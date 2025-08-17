import { RealtimeClient } from "@openai/realtime-api-beta";
import {
  ALLOWED_VOICES,
  DEFAULT_VOICE,
  FINAL_TIME_LIMIT_MESSAGE,
  LOG_EVENT_TYPES,
  MODEL,
  OPENAI_URL,
  SHOW_TIMING_MATH,
  TIME_LIMIT_MS,
  VoiceName,
} from "../config/config";
import type { Env } from "../config/env";
import {
  buildInitialCallGreeting,
  chatPrompt,
  realtimeConcatPrompt,
} from "../prompts/chat";
import { getAuthToken, validateAuth } from "../utils/auth";
import { rackyError, rackyLog } from "../utils/log";

type NullableString = string | null;
type TwilioBaseEvent = { event: string };
type TwilioCustomParameter = { name?: string; key?: string; value?: string };
type TwilioStartEvent = {
  event: "start";
  start?: {
    streamSid?: string | null;
    customParameters?: TwilioCustomParameter[];
    custom_parameters?: TwilioCustomParameter[];
  };
};
type TwilioMediaEvent = {
  event: "media";
  media?: { payload?: string; timestamp?: number | string };
};
type TwilioMarkEvent = { event: "mark" };
type TwilioEvent =
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioMarkEvent
  | TwilioBaseEvent;

function isMediaEvent(e: TwilioEvent): e is TwilioMediaEvent {
  return e.event === "media";
}
function isStartEvent(e: TwilioEvent): e is TwilioStartEvent {
  return e.event === "start";
}
function isMarkEvent(e: TwilioEvent): e is TwilioMarkEvent {
  return e.event === "mark";
}

export async function createTwilioRealtimeBridge(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const connectionStart = Date.now();
  rackyLog(`[timing] WebSocket connection initiated at ${new Date().toISOString()}`);
  
  const webSocketPair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(webSocketPair);
  serverSocket.accept();

  const responseHeaders = new Headers();
  responseHeaders.set("Sec-WebSocket-Protocol", "audio");

  const apiKey = env.OPENAI_API_KEY;
  const reqUrl = new URL(request.url);
  const auth = getAuthToken(reqUrl);
  const authOk = await validateAuth(auth, env, "twilio");
  if (!authOk) {
    try {
      serverSocket.close(1008, "Unauthorized");
    } catch {}
    return new Response(null, {
      status: 101,
      headers: responseHeaders,
      webSocket: clientSocket,
    });
  }
  const voiceParam = (reqUrl.searchParams.get("voice") || "").toLowerCase();
  const directionParam = (
    reqUrl.searchParams.get("direction") || ""
  ).toLowerCase();
  // Read amd from URL as an immediate hint while waiting for Twilio customParameters
  const amdParam = (reqUrl.searchParams.get("amd") || "").toLowerCase();

  let voicemailMode = false;
  let callDirection: "inbound" | "outbound" | "unknown" = "unknown";
  const selectedVoice: VoiceName = ALLOWED_VOICES.includes(
    voiceParam as VoiceName
  )
    ? (voiceParam as VoiceName)
    : DEFAULT_VOICE;

  if (directionParam === "inbound" || directionParam === "outbound") {
    callDirection = directionParam as "inbound" | "outbound";
  }

  // Seed voicemailMode immediately from amd query param if present
  if (amdParam) {
    const old = voicemailMode;
    voicemailMode =
      amdParam.includes("machine") ||
      amdParam === "machine_start" ||
      amdParam === "machine_end_beep" ||
      amdParam === "machine_end_silence" ||
      amdParam === "machine_end_other";
    rackyLog(
      `[twilio] initial amd param=${amdParam}; voicemailMode changed from ${old} to ${voicemailMode}`
    );
  }

  if (!apiKey) {
    rackyError("Missing OpenAI API key. Did you forget to set OPENAI_API_KEY?");
    try {
      serverSocket.close(1011, "Server misconfigured: missing API key");
    } catch {}
    return new Response(null, {
      status: 101,
      headers: responseHeaders,
      webSocket: clientSocket,
    });
  }

  let streamSid: NullableString = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem: NullableString = null;
  let markQueue: string[] = [];
  let responseStartTimestampTwilio: number | null = null;
  let speechDetected = false;
  let startEventProcessed = false;
  let voicemailCloseRequested = false;
  let alreadyClosed = false;
  let greetingSent = false;

  let timeLimitTimer: ReturnType<typeof setTimeout> | null = null;
  let timeLimitClosing = false;
  let timeLimitCloseFallback: ReturnType<typeof setTimeout> | null = null;
  let timeLimitCloseRequested = false;

  function sendFinalAndClose() {
    if (timeLimitClosing) return;
    timeLimitClosing = true;
    try {
      const item = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Please say exactly: ${FINAL_TIME_LIMIT_MESSAGE}`,
            },
          ],
        },
      } as const;
      realtimeClient!.realtime.send("conversation.item.create", item);
      realtimeClient!.realtime.send("response.create", {
        type: "response.create",
      });
    } catch {}
    try {
      if (timeLimitCloseFallback) clearTimeout(timeLimitCloseFallback);
      timeLimitCloseFallback = setTimeout(() => {
        try {
          serverSocket.close(1000, "time_limit");
        } catch {}
        try {
          realtimeClient?.disconnect();
        } catch {}
      }, 20_000);
    } catch {}
  }

  function scheduleTimeLimit() {
    try {
      if (timeLimitTimer) clearTimeout(timeLimitTimer);
      timeLimitTimer = setTimeout(() => {
        sendFinalAndClose();
      }, TIME_LIMIT_MS);
    } catch {}
  }

  function finalizeVoicemailCloseIfDrained() {
    if (!voicemailCloseRequested || alreadyClosed) return;
    const postDrainDelay = 1500;
    if (markQueue.length === 0) {
      try {
        setTimeout(() => {
          if (alreadyClosed) return;
          alreadyClosed = true;
          try {
            serverSocket.close(1000, "voicemail_complete");
          } catch {}
          try {
            realtimeClient?.disconnect();
          } catch {}
        }, postDrainDelay);
      } catch {}
    }
  }

  function tryCloseVoicemailAfterDrain() {
    if (alreadyClosed) return;
    voicemailCloseRequested = true;
    finalizeVoicemailCloseIfDrained();
  }

  function finalizeTimeLimitCloseIfDrained() {
    if (!timeLimitCloseRequested || alreadyClosed) return;
    const postDrainDelay = 1500;
    if (markQueue.length === 0) {
      try {
        setTimeout(() => {
          if (alreadyClosed) return;
          alreadyClosed = true;
          try {
            serverSocket.close(1000, "time_limit");
          } catch {}
          try {
            realtimeClient?.disconnect();
          } catch {}
          try {
            if (timeLimitCloseFallback) clearTimeout(timeLimitCloseFallback);
          } catch {}
        }, postDrainDelay);
      } catch {}
    }
  }

  function tryCloseTimeLimitAfterDrain() {
    if (alreadyClosed) return;
    timeLimitCloseRequested = true;
    finalizeTimeLimitCloseIfDrained();
  }

  let realtimeClient: RealtimeClient | null = null;
  try {
    const clientCreateTime = Date.now() - connectionStart;
    rackyLog(`[timing] Creating OpenAIRealtimeClient (Twilio mode) at +${clientCreateTime}ms`);
    realtimeClient = new RealtimeClient({
      apiKey,
      debug: false,
      url: OPENAI_URL,
    });
  } catch (e) {
    rackyError("Error creating OpenAI RealtimeClient (Twilio mode)", e);
    try {
      serverSocket.close(1011, "Upstream client init failure");
    } catch {}
    return new Response(null, {
      status: 101,
      headers: responseHeaders,
      webSocket: clientSocket,
    });
  }

  function initializeSession() {
    const instructions = realtimeConcatPrompt(
      chatPrompt(new Date().toISOString())
    );
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: selectedVoice,
        instructions,
        modalities: ["text", "audio"],
        temperature: 0.8,
      },
    } as const;
    realtimeClient!.realtime.send("session.update", sessionUpdate);
  }

  let initialUserMessageSent = false;
  function sendInitialConversationItem() {
    if (initialUserMessageSent) return;
    initialUserMessageSent = true;
    const greetingTime = Date.now() - connectionStart;
    const timestamp = new Date().toISOString();
    rackyLog(
      `[timing] Sending initial greeting at +${greetingTime}ms (${timestamp}) with voicemailMode: ${voicemailMode}, callDirection: ${callDirection}`
    );
    const initialMessage = buildInitialCallGreeting({
      voicemailMode,
      callDirection,
    });

    const initialConversationItem = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: initialMessage }],
      },
    } as const;
    realtimeClient!.realtime.send(
      "conversation.item.create",
      initialConversationItem
    );
    realtimeClient!.realtime.send("response.create", {
      type: "response.create",
    });

    const greetingSentTime = Date.now() - connectionStart;
    greetingSent = true;
    rackyLog(
      `[timing] Initial greeting sent at +${greetingSentTime}ms (voicemailMode: ${voicemailMode}):`,
      initialMessage
    );
  }

  // Removed outbound fallback timers per user request

  function sendMark() {
    if (!streamSid) return;
    const markEvent = {
      event: "mark",
      streamSid,
      mark: { name: "responsePart" },
    } as const;
    serverSocket.send(JSON.stringify(markEvent));
    markQueue.push("responsePart");
  }

  function handleSpeechStartedEvent() {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
      if (SHOW_TIMING_MATH) {
        console.log(
          `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
        );
      }
      if (lastAssistantItem) {
        const truncateEvent = {
          type: "conversation.item.truncate",
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime,
        } as const;
        realtimeClient!.realtime.send(
          "conversation.item.truncate",
          truncateEvent
        );
      }
      serverSocket.send(JSON.stringify({ event: "clear", streamSid }));
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  }

  realtimeClient.realtime.on("server.*", (evt: { type: string }) => {
    try {
      if (evt.type && LOG_EVENT_TYPES.includes(evt.type))
        rackyLog(`Received event from OpenAI: ${evt.type}`);
      if (
        (evt as unknown as { type?: string; delta?: string }).type ===
          "response.audio.delta" &&
        (evt as unknown as { delta?: string }).delta
      ) {
        const { delta } = evt as unknown as { delta: string };
        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload: delta },
        } as const;
        serverSocket.send(JSON.stringify(audioDelta));
        if (!responseStartTimestampTwilio)
          responseStartTimestampTwilio = latestMediaTimestamp;
        const itemId = (evt as unknown as { item_id?: string }).item_id;
        if (itemId) lastAssistantItem = itemId;
        sendMark();
      }
      if (evt.type === "input_audio_buffer.speech_started") {
        speechDetected = true;
        if (!voicemailMode) handleSpeechStartedEvent();
      }
      if (voicemailMode && evt.type === "response.done") {
        // For voicemail we close after audio drains only
        tryCloseVoicemailAfterDrain();
      }
      if (timeLimitClosing && evt.type === "response.done") {
        // After the final response is generated, wait for audio to drain to Twilio
        tryCloseTimeLimitAfterDrain();
      }
    } catch (error) {
      rackyError("Error processing OpenAI message (Twilio mode)", error);
    }
  });

  (
    realtimeClient as unknown as { socket?: WebSocket }
  ).socket?.addEventListener("message", (event: MessageEvent) => {
    try {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) return;
      const response = JSON.parse(raw) as {
        type?: string;
        delta?: string;
        item_id?: string;
      };
      if (response.type && LOG_EVENT_TYPES.includes(response.type))
        rackyLog(`OpenAI ws message: ${response.type}`);
      if (response.type === "response.audio.delta" && response.delta) {
        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload: response.delta },
        } as const;
        serverSocket.send(JSON.stringify(audioDelta));
        if (!responseStartTimestampTwilio)
          responseStartTimestampTwilio = latestMediaTimestamp;
        if (response.item_id) lastAssistantItem = response.item_id;
        sendMark();
      }
      if (response.type === "input_audio_buffer.speech_started") {
        speechDetected = true;
        if (!voicemailMode) handleSpeechStartedEvent();
      }
      if (voicemailMode && response.type === "response.done") {
        tryCloseVoicemailAfterDrain();
      }
    } catch {}
  });

  realtimeClient.realtime.on("close", (metadata: { error: boolean }) => {
    const closeTime = Date.now() - connectionStart;
    rackyLog(
      `[timing] OpenAI close event received at +${closeTime}ms (error: ${metadata.error}) - closing server-side (Twilio mode)`
    );
    try {
      serverSocket.close();
    } catch {}
  });

  const twilioQueue: string[] = [];
  serverSocket.addEventListener("message", (event: MessageEvent) => {
    try {
      const raw =
        typeof event.data === "string" ? event.data : event.data.toString();
      const twilioEvent = JSON.parse(raw) as TwilioEvent;
      if (!realtimeClient?.isConnected()) twilioQueue.push(raw);
      switch (twilioEvent.event) {
        case "media": {
          if (isMediaEvent(twilioEvent)) {
            latestMediaTimestamp = Number(twilioEvent.media?.timestamp || 0);
            if (realtimeClient?.isConnected()) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: twilioEvent.media?.payload,
              } as const;
              realtimeClient.realtime.send(
                "input_audio_buffer.append",
                audioAppend
              );
            }
          }
          break;
        }
        case "start": {
          if (isStartEvent(twilioEvent)) {
            const startEventTime = Date.now() - connectionStart;
            rackyLog(`[timing] Start event received at +${startEventTime}ms`);
            
            streamSid = twilioEvent.start?.streamSid ?? null;
            const rawCustomParams =
              (twilioEvent.start?.customParameters as unknown) ??
              (twilioEvent.start?.custom_parameters as unknown) ??
              null;
            rackyLog("[twilio] start.customParameters:", rawCustomParams);
            try {
              if (Array.isArray(rawCustomParams)) {
                for (const p of rawCustomParams) {
                  const key = (
                    (p?.name ?? p?.key ?? "") as string
                  ).toLowerCase();
                  const value = ((p?.value ?? "") as string).toLowerCase();
                  rackyLog(
                    `[twilio] Processing parameter - key: "${key}", value: "${value}"`
                  );
                  if (key === "amd") {
                    const oldVoicemailMode = voicemailMode;
                    voicemailMode =
                      value.includes("machine") ||
                      value === "machine_start" ||
                      value === "machine_end_beep" ||
                      value === "machine_end_silence" ||
                      value === "machine_end_other";
                    rackyLog(
                      `[twilio] AMD parameter detected - value: "${value}", voicemailMode changed from ${oldVoicemailMode} to ${voicemailMode}`
                    );
                  }
                  if (key === "direction") {
                    const oldDirection = callDirection;
                    if (value === "inbound" || value === "outbound") {
                      callDirection = value as typeof callDirection;
                    }
                    rackyLog(
                      `[twilio] Direction parameter detected - value: "${value}", callDirection changed from ${oldDirection} to ${callDirection}`
                    );
                  }
                }
              } else if (
                rawCustomParams &&
                typeof rawCustomParams === "object"
              ) {
                for (const [k, v] of Object.entries(
                  rawCustomParams as Record<string, unknown>
                )) {
                  const key = (k || "").toLowerCase();
                  const value = String(v ?? "").toLowerCase();
                  rackyLog(
                    `[twilio] Processing parameter - key: "${key}", value: "${value}"`
                  );
                  if (key === "amd") {
                    const oldVoicemailMode = voicemailMode;
                    voicemailMode =
                      value.includes("machine") ||
                      value === "machine_start" ||
                      value === "machine_end_beep" ||
                      value === "machine_end_silence" ||
                      value === "machine_end_other";
                    rackyLog(
                      `[twilio] AMD parameter detected - value: "${value}", voicemailMode changed from ${oldVoicemailMode} to ${voicemailMode}`
                    );
                  }
                  if (key === "direction") {
                    const oldDirection = callDirection;
                    if (value === "inbound" || value === "outbound") {
                      callDirection = value as typeof callDirection;
                    }
                    rackyLog(
                      `[twilio] Direction parameter detected - value: "${value}", callDirection changed from ${oldDirection} to ${callDirection}`
                    );
                  }
                }
              }
            } catch (e) {
              rackyError("[twilio] Failed to process customParameters", e);
            }
            startEventProcessed = true;
            rackyLog(
              `[twilio] Start event processed - Direction: ${callDirection}, VoicemailMode: ${voicemailMode}, Sending greeting immediately`
            );
            // Always send initial greeting immediately for both inbound and outbound calls
            // If it's a voicemail, we can adjust after detection
            if (realtimeClient?.isConnected()) {
              // Send immediately with minimal delay
              setTimeout(() => sendInitialConversationItem(), 50);
            } else {
              shouldSendInitialOnConnect = true;
            }
          }
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          rackyLog("Incoming Twilio stream has started", streamSid);
          scheduleTimeLimit();
          break;
        }
        case "mark": {
          if (isMarkEvent(twilioEvent)) {
            if (markQueue.length > 0) markQueue.shift();
            // Check if any pending graceful closures can complete now that audio is drained
            finalizeVoicemailCloseIfDrained();
            finalizeTimeLimitCloseIfDrained();
          }
          break;
        }
        default: {
          const eventTime = Date.now() - connectionStart;
          const eventType = (twilioEvent as TwilioBaseEvent).event;
          rackyLog(
            `[timing] Received non-media Twilio event at +${eventTime}ms: ${eventType}`
          );
          if (eventType === "connected") {
            rackyLog(`[timing] CONNECTED event received at +${eventTime}ms - Twilio WebSocket established`);
          } else if (eventType === "stop") {
            // Ignore stop events that come too early - before we've had a chance to establish the call
            const tooEarly = eventTime < 2000; // Less than 2 seconds
            const beforeGreeting = !greetingSent;
            
            rackyLog(`[timing] STOP event received at +${eventTime}ms - greetingSent: ${greetingSent}, tooEarly: ${tooEarly}`);
            
            if (tooEarly && beforeGreeting) {
              rackyLog(`[timing] IGNORING early STOP event at +${eventTime}ms - likely spurious Twilio event`);
              return; // Don't process this stop event
            } else {
              rackyLog(`[timing] Processing STOP event at +${eventTime}ms - this will cause closure`);
            }
          }
          break;
        }
      }
    } catch (error) {
      rackyError("Error parsing message from Twilio (Twilio mode)", error);
    }
  });

  serverSocket.addEventListener("close", () => {
    const closeTime = Date.now() - connectionStart;
    rackyLog(`[timing] Twilio client disconnected at +${closeTime}ms`);
    try {
      if (realtimeClient?.isConnected()) realtimeClient.disconnect();
    } catch {}
    try {
      if (timeLimitTimer) clearTimeout(timeLimitTimer);
    } catch {}
    try {
      if (timeLimitCloseFallback) clearTimeout(timeLimitCloseFallback);
    } catch {}
  });

  let shouldSendInitialOnConnect = false;

  ctx.waitUntil(
    (async () => {
      try {
        const connectStartTime = Date.now() - connectionStart;
        rackyLog(`[timing] Connecting to OpenAI (Twilio mode) at +${connectStartTime}ms...`);
        // @ts-expect-error Waiting on sdk types
        await realtimeClient!.connect({ model: MODEL });
        const connectEndTime = Date.now() - connectionStart;
        rackyLog(`[timing] Connected to OpenAI successfully (Twilio mode) at +${connectEndTime}ms!`);
        initializeSession();

        // Send initial conversation item immediately if needed
        if (shouldSendInitialOnConnect) {
          sendInitialConversationItem();
          shouldSendInitialOnConnect = false;
        }

        // Do NOT force the initial greeting before we see the Twilio start event.
        // We need the start event to process custom parameters (including AMD)
        // so the greeting respects voicemail mode.
        while (twilioQueue.length) {
          const msg = twilioQueue.shift();
          if (!msg) continue;
          try {
            const eventParsed = JSON.parse(msg) as TwilioEvent;
            if (isMediaEvent(eventParsed)) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: eventParsed.media?.payload,
              } as const;
              realtimeClient!.realtime.send(
                "input_audio_buffer.append",
                audioAppend
              );
            }
          } catch {}
        }
      } catch (e) {
        rackyError("Error connecting to OpenAI (Twilio mode)", e);
        try {
          serverSocket.close(1011, "Upstream connect failure");
        } catch {}
      }
    })()
  );

  return new Response(null, {
    status: 101,
    headers: responseHeaders,
    webSocket: clientSocket,
  });
}
