import { RealtimeClient } from "@openai/realtime-api-beta";
import type { Env } from "../config/env";
import { DEFAULT_VOICE, VoiceName } from "../config/voices";
import { LOG_EVENT_TYPES, MODEL, OPENAI_URL, SHOW_TIMING_MATH, TIME_LIMIT_MS, FINAL_TIME_LIMIT_MESSAGE } from "../config/config";
import { owrError, owrLog } from "../utils/log";
import { getAuthToken, validateAuth } from "../utils/auth";
import { chatPrompt, realtimeConcatPrompt, buildInitialCallGreeting } from "../prompts/chat";

type NullableString = string | null;
type TwilioBaseEvent = { event: string };
type TwilioCustomParameter = { name?: string; key?: string; value?: string };
type TwilioStartEvent = { event: "start"; start?: { streamSid?: string | null; customParameters?: TwilioCustomParameter[]; custom_parameters?: TwilioCustomParameter[] } };
type TwilioMediaEvent = { event: "media"; media?: { payload?: string; timestamp?: number | string } };
type TwilioMarkEvent = { event: "mark" };
type TwilioEvent = TwilioStartEvent | TwilioMediaEvent | TwilioMarkEvent | TwilioBaseEvent;

function isMediaEvent(e: TwilioEvent): e is TwilioMediaEvent { return e.event === "media"; }
function isStartEvent(e: TwilioEvent): e is TwilioStartEvent { return e.event === "start"; }
function isMarkEvent(e: TwilioEvent): e is TwilioMarkEvent { return e.event === "mark"; }

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
    try { serverSocket.close(1008, "Unauthorized"); } catch {}
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
  }
  const voiceParam = (reqUrl.searchParams.get("voice") || "").toLowerCase();
  const directionParam = (reqUrl.searchParams.get("direction") || "").toLowerCase();
  let systemInstructionsOverride: string | null = null;
  let initialGreetingOverride: string | null = null;
  let voicemailMode = false;
  let callDirection: 'inbound' | 'outbound' | 'unknown' = 'unknown';
  const selectedVoice: VoiceName = (['alloy','ash','ballad','coral','echo','sage','shimmer','verse'] as const).includes(
    voiceParam as VoiceName
  ) ? (voiceParam as VoiceName) : DEFAULT_VOICE;

  if (directionParam === 'inbound' || directionParam === 'outbound') {
    callDirection = directionParam as 'inbound' | 'outbound';
  }

  if (!apiKey) {
    owrError("Missing OpenAI API key. Did you forget to set OPENAI_API_KEY?");
    try { serverSocket.close(1011, "Server misconfigured: missing API key"); } catch {}
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
  }

  let streamSid: NullableString = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem: NullableString = null;
  let markQueue: string[] = [];
  let responseStartTimestampTwilio: number | null = null;

  let timeLimitTimer: ReturnType<typeof setTimeout> | null = null;
  let timeLimitClosing = false;
  let timeLimitCloseFallback: ReturnType<typeof setTimeout> | null = null;

  function sendFinalAndClose() {
    if (timeLimitClosing) return;
    timeLimitClosing = true;
    try {
      const item = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Please say exactly: ${FINAL_TIME_LIMIT_MESSAGE}` }]
        }
      } as const;
      realtimeClient!.realtime.send('conversation.item.create', item);
      realtimeClient!.realtime.send('response.create', { type: 'response.create' });
    } catch {}
    try {
      if (timeLimitCloseFallback) clearTimeout(timeLimitCloseFallback);
      timeLimitCloseFallback = setTimeout(() => {
        try { serverSocket.close(1000, 'time_limit'); } catch {}
        try { realtimeClient?.disconnect(); } catch {}
      }, 20_000);
    } catch {}
  }

  function scheduleTimeLimit() {
    try {
      if (timeLimitTimer) clearTimeout(timeLimitTimer);
      timeLimitTimer = setTimeout(() => { sendFinalAndClose(); }, TIME_LIMIT_MS);
    } catch {}
  }

  let realtimeClient: RealtimeClient | null = null;
  try {
    owrLog("Creating OpenAIRealtimeClient (Twilio mode)");
    realtimeClient = new RealtimeClient({ apiKey, debug: true, url: OPENAI_URL });
  } catch (e) {
    owrError("Error creating OpenAI RealtimeClient (Twilio mode)", e);
    try { serverSocket.close(1011, "Upstream client init failure"); } catch {}
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
  }

  function initializeSession() {
    const fallbackInstructions = realtimeConcatPrompt(
      chatPrompt(new Date().toISOString())
    );
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: selectedVoice,
        instructions: systemInstructionsOverride ?? fallbackInstructions,
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
    const initialMessage = initialGreetingOverride ?? '';
    if (!initialMessage) return;
    const initialConversationItem = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [ { type: "input_text", text: initialMessage } ],
      },
    } as const;
    realtimeClient!.realtime.send("conversation.item.create", initialConversationItem);
    realtimeClient!.realtime.send("response.create", { type: "response.create" });
  }

  function sendMark() {
    if (!streamSid) return;
    const markEvent = { event: "mark", streamSid, mark: { name: "responsePart" } } as const;
    serverSocket.send(JSON.stringify(markEvent));
    markQueue.push("responsePart");
  }

  function handleSpeechStartedEvent() {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
      if (SHOW_TIMING_MATH) {
        console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);
      }
      if (lastAssistantItem) {
        const truncateEvent = { type: "conversation.item.truncate", item_id: lastAssistantItem, content_index: 0, audio_end_ms: elapsedTime } as const;
        realtimeClient!.realtime.send("conversation.item.truncate", truncateEvent);
      }
      serverSocket.send(JSON.stringify({ event: "clear", streamSid }));
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  }

  realtimeClient.realtime.on("server.*", (evt: { type: string }) => {
    try {
      if (evt.type && LOG_EVENT_TYPES.includes(evt.type)) owrLog(`Received event from OpenAI: ${evt.type}`);
      if ((evt as unknown as { type?: string; delta?: string }).type === "response.audio.delta" && (evt as unknown as { delta?: string }).delta) {
        const { delta } = evt as unknown as { delta: string };
        const audioDelta = { event: "media", streamSid, media: { payload: delta } } as const;
        serverSocket.send(JSON.stringify(audioDelta));
        if (!responseStartTimestampTwilio) responseStartTimestampTwilio = latestMediaTimestamp;
        const itemId = (evt as unknown as { item_id?: string }).item_id;
        if (itemId) lastAssistantItem = itemId;
        sendMark();
      }
      if (evt.type === "input_audio_buffer.speech_started") {
        if (!voicemailMode) handleSpeechStartedEvent();
      }
      if (voicemailMode && evt.type === "response.done") {
        try { serverSocket.close(1000, "voicemail complete"); } catch {}
        try { realtimeClient?.disconnect(); } catch {}
      }
      if (timeLimitClosing && evt.type === 'response.done') {
        try { serverSocket.close(1000, 'time_limit'); } catch {}
        try { realtimeClient?.disconnect(); } catch {}
      }
    } catch (error) {
      owrError("Error processing OpenAI message (Twilio mode)", error);
    }
  });

  (realtimeClient as unknown as { socket?: WebSocket }).socket?.addEventListener(
    "message",
    (event: MessageEvent) => {
      try {
        const raw = typeof event.data === "string" ? event.data : "";
        if (!raw) return;
        const response = JSON.parse(raw) as { type?: string; delta?: string; item_id?: string };
        if (response.type && LOG_EVENT_TYPES.includes(response.type)) owrLog(`OpenAI ws message: ${response.type}`);
        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = { event: "media", streamSid, media: { payload: response.delta } } as const;
          serverSocket.send(JSON.stringify(audioDelta));
          if (!responseStartTimestampTwilio) responseStartTimestampTwilio = latestMediaTimestamp;
          if (response.item_id) lastAssistantItem = response.item_id;
          sendMark();
        }
        if (response.type === "input_audio_buffer.speech_started") {
          if (!voicemailMode) handleSpeechStartedEvent();
        }
        if (voicemailMode && response.type === "response.done") {
          try { serverSocket.close(1000, "voicemail complete"); } catch {}
          try { realtimeClient?.disconnect(); } catch {}
        }
      } catch {}
    }
  );

  realtimeClient.realtime.on("close", (metadata: { error: boolean }) => {
    owrLog(`Closing server-side (Twilio mode) because I received a close event: (error: ${metadata.error})`);
    try { serverSocket.close(); } catch {}
  });

  const twilioQueue: string[] = [];
  serverSocket.addEventListener("message", (event: MessageEvent) => {
    try {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      const twilioEvent = JSON.parse(raw) as TwilioEvent;
      if (!realtimeClient?.isConnected()) twilioQueue.push(raw);
      switch (twilioEvent.event) {
        case "media": {
          if (isMediaEvent(twilioEvent)) {
            latestMediaTimestamp = Number(twilioEvent.media?.timestamp || 0);
            if (realtimeClient?.isConnected()) {
              const audioAppend = { type: "input_audio_buffer.append", audio: twilioEvent.media?.payload } as const;
              realtimeClient.realtime.send("input_audio_buffer.append", audioAppend);
            }
          }
          break;
        }
        case "start": {
          if (isStartEvent(twilioEvent)) {
            streamSid = twilioEvent.start?.streamSid ?? null;
            const customParams = twilioEvent.start?.customParameters || twilioEvent.start?.custom_parameters || [];
            owrLog("[twilio] start.customParameters:", customParams);
            for (const p of customParams) {
              const key = (p.name || p.key || "").toLowerCase();
              const rawValue = p.value || "";
              const lowerValue = rawValue.toLowerCase();
              if (key === "amd") {
                voicemailMode = lowerValue.includes("machine");
              } else if (key === 'direction') {
                if (lowerValue === 'inbound' || lowerValue === 'outbound') callDirection = lowerValue as 'inbound' | 'outbound';
              } else if (key === 'sys') {
                try { systemInstructionsOverride = decodeBase64UrlUtf8(rawValue); } catch { systemInstructionsOverride = null; }
                if (systemInstructionsOverride != null) {
                  try { if (realtimeClient?.isConnected()) { realtimeClient.realtime.send('session.update', { type: 'session.update', session: { instructions: systemInstructionsOverride } }); } } catch {}
                }
              } else if (key === 'greet') {
                try { initialGreetingOverride = decodeBase64UrlUtf8(rawValue); } catch { initialGreetingOverride = null; }
              }
            }
            if (!initialGreetingOverride) {
              const greetText = buildInitialCallGreeting({ voicemailMode, callDirection });
              initialGreetingOverride = voicemailMode
                ? `Please say exactly: ${greetText}`
                : `Greet the user with "${greetText}"`;
            }
            if (realtimeClient?.isConnected()) sendInitialConversationItem(); else shouldSendInitialOnConnect = true;
          }
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          owrLog("Incoming Twilio stream has started", streamSid);
          scheduleTimeLimit();
          break;
        }
        case "mark": {
          if (isMarkEvent(twilioEvent)) { if (markQueue.length > 0) markQueue.shift(); }
          break;
        }
        default: {
          owrLog("Received non-media Twilio event:", (twilioEvent as TwilioBaseEvent).event);
          break;
        }
      }
    } catch (error) {
      owrError("Error parsing message from Twilio (Twilio mode)", error);
    }
  });

  serverSocket.addEventListener("close", () => {
    try { if (realtimeClient?.isConnected()) realtimeClient.disconnect(); } catch {}
    owrLog("Twilio client disconnected.");
    try { if (timeLimitTimer) clearTimeout(timeLimitTimer); } catch {}
    try { if (timeLimitCloseFallback) clearTimeout(timeLimitCloseFallback); } catch {}
  });

  let shouldSendInitialOnConnect = false;
  function decodeBase64UrlUtf8(raw: string): string {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  ctx.waitUntil(
    (async () => {
      try {
        owrLog(`Connecting to OpenAI (Twilio mode)...`);
        // @ts-expect-error Waiting on sdk types
        await realtimeClient!.connect({ model: MODEL });
        owrLog(`Connected to OpenAI successfully (Twilio mode)!`);
        initializeSession();
        if (shouldSendInitialOnConnect) { sendInitialConversationItem(); shouldSendInitialOnConnect = false; }
        while (twilioQueue.length) {
          const msg = twilioQueue.shift();
          if (!msg) continue;
          try {
            const eventParsed = JSON.parse(msg) as TwilioEvent;
            if (isMediaEvent(eventParsed)) {
              const audioAppend = { type: "input_audio_buffer.append", audio: eventParsed.media?.payload } as const;
              realtimeClient!.realtime.send("input_audio_buffer.append", audioAppend);
            }
          } catch {}
        }
      } catch (e) {
        owrError("Error connecting to OpenAI (Twilio mode)", e);
        try { serverSocket.close(1011, "Upstream connect failure"); } catch {}
      }
    })()
  );

  return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
}


