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
  let deferInitialForOutbound = false;
  let outboundVoicemailTimer: ReturnType<typeof setTimeout> | null = null;
  const OUTBOUND_VOICEMAIL_WAIT_MS = 8000;
  let startEventProcessed = false;
  let voicemailCloseRequested = false;
  let voicemailCloseTimeout: ReturnType<typeof setTimeout> | null = null;
  let alreadyClosed = false;
  let lastAudioDeltaAtMs: number | null = null;
  let outboundHumanGreetingTimer: ReturnType<typeof setTimeout> | null = null;
  const OUTBOUND_HUMAN_GREETING_DELAY_MS = 800;

  let timeLimitTimer: ReturnType<typeof setTimeout> | null = null;
  let timeLimitClosing = false;
  let timeLimitCloseFallback: ReturnType<typeof setTimeout> | null = null;

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

  function tryCloseVoicemailAfterDrain(reason: string) {
    if (alreadyClosed) return;
    // Close only when Twilio has acked all marks (audio drained), or after a short fallback
    const doClose = () => {
      if (alreadyClosed) return;
      alreadyClosed = true;
      try {
        serverSocket.close(1000, reason);
      } catch {}
      try {
        realtimeClient?.disconnect();
      } catch {}
    };
    const postDrainDelay = 1500; // allow Twilio to finish last buffer
    if (markQueue.length === 0) {
      try {
        setTimeout(doClose, postDrainDelay);
      } catch {
        doClose();
      }
      return;
    }
    try {
      if (voicemailCloseTimeout) clearTimeout(voicemailCloseTimeout);
      // longer fallback for longer voicemails
      voicemailCloseTimeout = setTimeout(doClose, 12000);
    } catch {
      doClose();
    }
  }

  function clearOutboundHumanGreetingTimer() {
    try {
      if (outboundHumanGreetingTimer) clearTimeout(outboundHumanGreetingTimer);
    } catch {}
    outboundHumanGreetingTimer = null;
  }

  function scheduleOutboundHumanGreeting() {
    clearOutboundHumanGreetingTimer();
    outboundHumanGreetingTimer = setTimeout(() => {
      try {
        if (!initialUserMessageSent && !voicemailMode && !speechDetected) {
          sendInitialConversationItem();
        }
      } catch {}
    }, OUTBOUND_HUMAN_GREETING_DELAY_MS);
  }

  let realtimeClient: RealtimeClient | null = null;
  try {
    rackyLog("Creating OpenAIRealtimeClient (Twilio mode)");
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
    rackyLog(
      `[twilio] Creating initial greeting with voicemailMode: ${voicemailMode}, callDirection: ${callDirection}`
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

    rackyLog(
      `Sent initial conversation item (voicemailMode: ${voicemailMode}):`,
      initialMessage
    );
  }

  function clearOutboundTimer() {
    try {
      if (outboundVoicemailTimer) clearTimeout(outboundVoicemailTimer);
    } catch {}
    outboundVoicemailTimer = null;
  }

  function scheduleOutboundVoicemailFallback() {
    clearOutboundTimer();
    outboundVoicemailTimer = setTimeout(() => {
      try {
        if (!initialUserMessageSent && !speechDetected) {
          // Treat as voicemail and send the voicemail message
          const old = voicemailMode;
          voicemailMode = true;
          rackyLog(
            `[twilio] No speech detected within ${OUTBOUND_VOICEMAIL_WAIT_MS}ms for outbound call; switching voicemailMode from ${old} to ${voicemailMode}`
          );
          sendInitialConversationItem();
        }
      } catch {}
    }, OUTBOUND_VOICEMAIL_WAIT_MS);
  }

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
    if (deferInitialForOutbound && !initialUserMessageSent) {
      // We waited for human; send greeting now
      deferInitialForOutbound = false;
      clearOutboundTimer();
      sendInitialConversationItem();
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
        clearOutboundHumanGreetingTimer();
        // If we deferred for outbound waiting for speech (human), don't send normal greeting
        // if voicemailMode is already true or AMD unknown. We only send normal greeting when
        // voicemailMode is false and we explicitly decided to wait for speech.
        if (
          deferInitialForOutbound &&
          !initialUserMessageSent &&
          voicemailMode
        ) {
          // Do nothing; voicemail path will be handled by fallback timer
          return;
        }
      }
      if (voicemailMode && evt.type === "response.done") {
        // For voicemail we close after audio drains; rely on marks or a short fallback
        tryCloseVoicemailAfterDrain("voicemail_complete");
      }
      if (timeLimitClosing && evt.type === "response.done") {
        try {
          serverSocket.close(1000, "time_limit");
        } catch {}
        try {
          realtimeClient?.disconnect();
        } catch {}
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
        clearOutboundHumanGreetingTimer();
      }
      if (voicemailMode && response.type === "response.done") {
        tryCloseVoicemailAfterDrain("voicemail_complete");
      }
    } catch {}
  });

  realtimeClient.realtime.on("close", (metadata: { error: boolean }) => {
    rackyLog(
      `Closing server-side (Twilio mode) because I received a close event: (error: ${metadata.error})`
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
            lastAudioDeltaAtMs = Date.now();
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
            // Decide when to send the initial greeting based on direction and AMD
            if (callDirection === "outbound") {
              if (voicemailMode) {
                if (realtimeClient?.isConnected()) {
                  setTimeout(() => sendInitialConversationItem(), 50);
                } else {
                  shouldSendInitialOnConnect = true;
                }
              } else {
                // Wait for human speech; also schedule an early gentle greeting if no speech
                deferInitialForOutbound = true;
                scheduleOutboundHumanGreeting();
                scheduleOutboundVoicemailFallback();
              }
            } else {
              // Inbound or unknown: if AMD says machine, send voicemail, else normal greeting
              if (voicemailMode) {
                if (realtimeClient?.isConnected()) {
                  setTimeout(() => sendInitialConversationItem(), 50);
                } else {
                  shouldSendInitialOnConnect = true;
                }
              } else {
                if (realtimeClient?.isConnected()) {
                  setTimeout(() => sendInitialConversationItem(), 100);
                } else {
                  shouldSendInitialOnConnect = true;
                }
              }
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
          }
          break;
        }
        default: {
          rackyLog(
            "Received non-media Twilio event:",
            (twilioEvent as TwilioBaseEvent).event
          );
          break;
        }
      }
    } catch (error) {
      rackyError("Error parsing message from Twilio (Twilio mode)", error);
    }
  });

  serverSocket.addEventListener("close", () => {
    try {
      if (realtimeClient?.isConnected()) realtimeClient.disconnect();
    } catch {}
    rackyLog("Twilio client disconnected.");
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
        rackyLog(`Connecting to OpenAI (Twilio mode)...`);
        // @ts-expect-error Waiting on sdk types
        await realtimeClient!.connect({ model: MODEL });
        rackyLog(`Connected to OpenAI successfully (Twilio mode)!`);
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
