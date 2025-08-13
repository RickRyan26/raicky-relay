// Copyright (c) 2024 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE file or at https://opensource.org/licenses/MIT

import { RealtimeClient } from "@openai/realtime-api-beta";

type Env = {
  OPENAI_API_KEY: string;
  ENCRYPTION_KEY: string; // base64-encoded AES key matching app server
};

const DEBUG = true; // set as true to see debug logs
const MODEL = "gpt-4o-realtime-preview";
const OPENAI_URL = "wss://api.openai.com/v1/realtime";

function owrLog(...args: unknown[]) {
  if (DEBUG) {
    console.log("[owr]", ...args);
  }
}

function owrError(...args: unknown[]) {
  console.error("[owr error]", ...args);
}

// Shared configuration/constants for Twilio bridging and default relay
const ALLOWED_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
type VoiceName = (typeof ALLOWED_VOICES)[number];
const VOICE: VoiceName = "ash";
const LOG_EVENT_TYPES: ReadonlyArray<string> = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];
const SHOW_TIMING_MATH = false;


const welcomeMessage = `Greet the customer with "Hello, I'm your GateFrames A.I. assistant! How can I help?"`

// NOTE This prompt is a duplicate of the one in our Twilio Text endpoint.
function getSystemMessage(timeStamp: string): string {
  return (
    `Voice: Be very friendly, kind, and expressive.

    Role: You are a knowledgeable specialist in high-end driveway gates, openers, and accessories.

    Objective: Understand the customer's needs, provide accurate information, and guide them to the perfect Gate Frames product or solution, driving sales and satisfaction.

    Strict Scope: Your knowledge is limited to GateFrames products (driveway gates, fences, accessories, etc.). If asked about unrelated items or services, politely decline and steer the conversation back to GateFrames offerings.

    Knowledge: Gate Frames began from this simple promise. Design custom-sized automatic steel and wood gates and fences of the highest industry standard, deliver them directly to our fellow Americans for free, and offer enjoyable easy to follow Do-It-Yourself installation guides.

    Guidelines:
    - Ask concise clarifying questions to understand the use-case (swing vs. slide, driveway width/slope, material/style preference, opener power and power source, climate, budget, security/accessory needs).
    - Keep responses warm, upbeat, and professional; prioritize clarity over humor unless the customer invites it.
    
    The current date is ${timeStamp}.`
  );
}

// Twilio Media Stream event types
type NullableString = string | null;
type TwilioBaseEvent = { event: string };
type TwilioStartEvent = {
  event: "start";
  start?: { streamSid?: string | null };
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

async function createRealtimeClient(
  request: Request,
  env: Env,
  ctx: ExecutionContext
) {
  // Copy protocol headers (prepare response headers but delay accept until after auth)
  const responseHeaders = new Headers();
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  if (protocolHeader) {
    const requestedProtocols = protocolHeader.split(",").map((p) => p.trim());
    if (requestedProtocols.length > 0) {
      responseHeaders.set("Sec-WebSocket-Protocol", requestedProtocols[0]);
    }
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    owrError(
      "Missing OpenAI API key. Did you forget to set OPENAI_API_KEY in .dev.vars (for local dev) or with wrangler secret put OPENAI_API_KEY (for production)?"
    );
    return new Response("Missing API key", { status: 401 });
  }

  // Enforce short-lived auth token for default relay clients BEFORE opening WS
  const url = new URL(request.url);
  const auth = getAuthToken(url);
  const tokenOk = await validateAuth(auth, env, "client");
  if (!tokenOk) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Create and accept the websocket only after validation succeeds
  const webSocketPair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(webSocketPair);
  serverSocket.accept();

  let realtimeClient: RealtimeClient | null = null;

  // Create RealtimeClient
  try {
    owrLog("Creating OpenAIRealtimeClient");
    realtimeClient = new RealtimeClient({
      apiKey,
      debug: DEBUG,
      url: OPENAI_URL,
    });
  } catch (e) {
    owrError("Error creating OpenAI RealtimeClient", e);
    serverSocket.close();
    return new Response("Error creating OpenAI RealtimeClient", {
      status: 500,
    });
  }

  // Relay: OpenAI Realtime API Event -> Client
  realtimeClient.realtime.on("server.*", (event: { type: string }) => {
    serverSocket.send(JSON.stringify(event));
  });

  realtimeClient.realtime.on("close", (metadata: { error: boolean }) => {
    owrLog(
      `Closing server-side because I received a close event: (error: ${metadata.error})`
    );
    serverSocket.close();
  });

  // Relay: Client -> OpenAI Realtime API Event
  const messageQueue: string[] = [];
  const messageHandler = (data: string) => {
    try {
      const parsedEvent = JSON.parse(data);
      realtimeClient.realtime.send(parsedEvent.type, parsedEvent);
    } catch (e) {
      owrError("Error parsing event from client", data);
    }
  };

  serverSocket.addEventListener("message", (event: MessageEvent) => {
    const data =
      typeof event.data === "string" ? event.data : event.data.toString();
    if (!realtimeClient.isConnected()) {
      messageQueue.push(data);
    } else {
      messageHandler(data);
    }
  });

  serverSocket.addEventListener("close", ({ code, reason }) => {
    owrLog(
      `Closing server-side because the client closed the connection: ${code} ${reason}`
    );
    realtimeClient.disconnect();
    messageQueue.length = 0;
  });

  let model: string | undefined = MODEL;

  // uncomment this to use a model from specified by the client

  // const modelParam = new URL(request.url).searchParams.get("model");
  // if (modelParam) {
  //   model = modelParam;
  // }

  // Connect to OpenAI Realtime API asynchronously; respond 101 immediately
  ctx.waitUntil(
    (async () => {
      try {
        owrLog(`Connecting to OpenAI...`);
        // @ts-expect-error Waiting on https://github.com/openai/openai-realtime-api-beta/pull/52
        await realtimeClient.connect({ model });
        owrLog(`Connected to OpenAI successfully!`);
        while (messageQueue.length) {
          const message = messageQueue.shift();
          if (message) {
            messageHandler(message);
          }
        }
      } catch (e) {
        owrError("Error connecting to OpenAI", e);
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

async function createTwilioRealtimeBridge(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const webSocketPair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(webSocketPair);

  serverSocket.accept();

  const responseHeaders = new Headers();
  // Force subprotocol to 'audio' for Twilio Media Streams
  responseHeaders.set("Sec-WebSocket-Protocol", "audio");

  const apiKey = env.OPENAI_API_KEY;
  const reqUrl = new URL(request.url);
  // Validate short-lived auth from app server
  const auth = getAuthToken(reqUrl);
  const authOk = await validateAuth(auth, env, "twilio");
  if (!authOk) {
    // Accept and close gracefully so Twilio gets a websocket closure instead of HTTP error
    try {
      serverSocket.close(1008, "Unauthorized");
    } catch {}
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
  }
  const voiceParam = (reqUrl.searchParams.get("voice") || "").toLowerCase();
  const selectedVoice: VoiceName = (ALLOWED_VOICES.includes(
    voiceParam as VoiceName
  )
    ? (voiceParam as VoiceName)
    : VOICE);
  if (!apiKey) {
    owrError(
      "Missing OpenAI API key. Did you forget to set OPENAI_API_KEY in .dev.vars (for local dev) or with wrangler secret put OPENAI_API_KEY (for production)?"
    );
    // Accept and then close gracefully so Twilio sees a proper websocket close
    try {
      serverSocket.close(1011, "Server misconfigured: missing API key");
    } catch {}
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
  }

  // Per-call connection state
  let streamSid: NullableString = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem: NullableString = null;
  let markQueue: string[] = [];
  let responseStartTimestampTwilio: number | null = null;

  // Build OpenAI Realtime client
  let realtimeClient: RealtimeClient | null = null;
  try {
    owrLog("Creating OpenAIRealtimeClient (Twilio mode)");
    realtimeClient = new RealtimeClient({
      apiKey,
      debug: DEBUG,
      url: OPENAI_URL,
    });
  } catch (e) {
    owrError("Error creating OpenAI RealtimeClient (Twilio mode)", e);
    try {
      serverSocket.close(1011, "Upstream client init failure");
    } catch {}
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
  }

  function initializeSession() {
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: selectedVoice,
        instructions: getSystemMessage(new Date().toISOString()),
        modalities: ["text", "audio"],
        temperature: 0.8,
      },
    } as const;
    realtimeClient!.realtime.send("session.update", sessionUpdate);
  }

  function sendInitialConversationItem() {
    const initialConversationItem = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: welcomeMessage,
          },
        ],
      },
    } as const;
    realtimeClient!.realtime.send(
      "conversation.item.create",
      initialConversationItem
    );
    realtimeClient!.realtime.send("response.create", { type: "response.create" });
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
      serverSocket.send(
        JSON.stringify({
          event: "clear",
          streamSid,
        })
      );
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  }

  // OpenAI -> Twilio
  realtimeClient.realtime.on("server.*", (evt: { type: string }) => {
    try {
      if (evt.type && LOG_EVENT_TYPES.includes(evt.type)) {
        owrLog(`Received event from OpenAI: ${evt.type}`);
      }
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
        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }
        const itemId = (evt as unknown as { item_id?: string }).item_id;
        if (itemId) lastAssistantItem = itemId;
        sendMark();
      }

      if (evt.type === "input_audio_buffer.speech_started") {
        handleSpeechStartedEvent();
      }
    } catch (error) {
      owrError("Error processing OpenAI message (Twilio mode)", error);
    }
  });

  // Also support raw websocket messages from OpenAI (some SDK versions emit strings)
  // This ensures we never drop audio deltas if they arrive over ws directly
  (realtimeClient as unknown as { socket?: WebSocket }).socket?.addEventListener(
    "message",
    (event: MessageEvent) => {
      try {
        const raw = typeof event.data === "string" ? event.data : "";
        if (!raw) return;
        const response = JSON.parse(raw) as {
          type?: string;
          delta?: string;
          item_id?: string;
        };
        if (response.type && LOG_EVENT_TYPES.includes(response.type)) {
          owrLog(`OpenAI ws message: ${response.type}`);
        }
        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid,
            media: { payload: response.delta },
          } as const;
          serverSocket.send(JSON.stringify(audioDelta));
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }
          if (response.item_id) lastAssistantItem = response.item_id;
          sendMark();
        }
        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }
      } catch {}
    }
  );

  realtimeClient.realtime.on("close", (metadata: { error: boolean }) => {
    owrLog(
      `Closing server-side (Twilio mode) because I received a close event: (error: ${metadata.error})`
    );
    try {
      serverSocket.close();
    } catch {}
  });

  // Buffer for Twilio events until OpenAI connects
  const twilioQueue: string[] = [];

  // Twilio -> OpenAI
  serverSocket.addEventListener("message", (event: MessageEvent) => {
    try {
      const raw =
        typeof event.data === "string" ? event.data : event.data.toString();
      const twilioEvent = JSON.parse(raw) as TwilioEvent;
      if (!realtimeClient?.isConnected()) {
        twilioQueue.push(raw);
      }
      switch (twilioEvent.event) {
        case "media": {
          if (isMediaEvent(twilioEvent)) {
            latestMediaTimestamp = Number(
              twilioEvent.media?.timestamp || 0
            );
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
          }
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          owrLog("Incoming Twilio stream has started", streamSid);
          break;
        }
        case "mark": {
          if (isMarkEvent(twilioEvent)) {
            if (markQueue.length > 0) markQueue.shift();
          }
          break;
        }
        default: {
          owrLog("Received non-media Twilio event:", twilioEvent.event);
          break;
        }
      }
    } catch (error) {
      owrError("Error parsing message from Twilio (Twilio mode)", error);
    }
  });

  serverSocket.addEventListener("close", () => {
    try {
      if (realtimeClient?.isConnected()) realtimeClient.disconnect();
    } catch {}
    owrLog("Twilio client disconnected.");
  });

  // Connect to OpenAI and initialize session
  ctx.waitUntil(
    (async () => {
      try {
        owrLog(`Connecting to OpenAI (Twilio mode)...`);
        // @ts-expect-error Waiting on https://github.com/openai/openai-realtime-api-beta/pull/52
        await realtimeClient!.connect({ model: MODEL });
        owrLog(`Connected to OpenAI successfully (Twilio mode)!`);
        initializeSession();
        sendInitialConversationItem();
        // Flush any queued Twilio media after connecting
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
        owrError("Error connecting to OpenAI (Twilio mode)", e);
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

// export default {
//   async fetch(
//     request: Request,
//     env: Env,
//     ctx: ExecutionContext
//   ): Promise<Response> {
//     // This would be a good place to add logic for
//     // authentication, rate limiting, etc.
//     // You could also do matching on the path or other things here.
//     const upgradeHeader = request.headers.get("Upgrade");
//     if (upgradeHeader === "websocket") {
//       return createRealtimeClient(request, env, ctx);
//     }

//     return new Response("Expected Upgrade: websocket", { status: 426 });
//   },
// };
const ALLOWED_ORIGINS = [
  "https://www.gateframes.com",
  "https://gateframes.com",
  "https://www.ricslist.com",
  "https://ricslist.com",
  "http://localhost:5173",
] as const;

export function isAllowedOrigin(origin: string | null): boolean {

  console.log(origin)
  if (!origin) return false;

  // Check exact matches first
  if (ALLOWED_ORIGINS.includes(origin as (typeof ALLOWED_ORIGINS)[number])) {
    return true;
  }

  // Check for development environments
  if (origin.startsWith("http://localhost:")) {
    const port = origin.split(":")[2];
    return (
      !isNaN(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535
    );
  }

  return false;
}

function sanitizeToken(raw: string | null): string | null {
  if (!raw) return null;
  // Strip accidental query fragments like '?model=...'
  const stopChars = ['?', '&', '#'];
  let token = raw;
  for (const ch of stopChars) {
    const idx = token.indexOf(ch);
    if (idx >= 0) token = token.slice(0, idx);
  }
  // Keep only base64url characters
  token = token.replace(/[^A-Za-z0-9_-]/g, '');
  return token.length ? token : null;
}

function getAuthToken(url: URL): string | null {
  // Prefer path /token/<b64url> or /auth/<b64url>
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && (parts[0] === 'token' || parts[0] === 'auth')) {
    return sanitizeToken(parts[1]);
  }
  return sanitizeToken(url.searchParams.get('auth'));
}

async function validateAuth(
  authParam: string | null,
  env: Env,
  expectedOrigin: "twilio" | "client"
): Promise<boolean> {
  try {
    if (!authParam) {
      owrLog("[auth] missing token");
      return false;
    }
    if (!env.ENCRYPTION_KEY) {
      owrLog("[auth] missing ENCRYPTION_KEY");
      return false;
    }
    const key = base64ToBytes(env.ENCRYPTION_KEY);
    const encrypted = base64UrlToBytes(authParam);
    const plaintext = await decryptAesGcm(encrypted, key);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as {
      iat: number;
      exp: number;
      origin: string;
      nonce: string;
    };
    const now = Date.now();
    if (decoded.exp < now) {
      owrLog("[auth] token expired", { exp: decoded.exp, now });
      return false;
    }
    if (decoded.iat > now + 30_000) {
      owrLog("[auth] token iat too far in future", { iat: decoded.iat, now });
      return false;
    }
    if (decoded.origin !== expectedOrigin) {
      owrLog("[auth] origin mismatch", { expected: expectedOrigin, got: decoded.origin });
      return false;
    }
    return true;
  } catch {
    owrLog("[auth] token decrypt/parse failed");
    return false;
  }
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function decryptAesGcm(data: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  if (data.length < 33) throw new Error("invalid data");
  const iv = data.slice(0, 16);
  const authTag = data.slice(data.length - 16);
  const ciphertext = data.slice(16, data.length - 16);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    combined.buffer as ArrayBuffer
  );
  return new Uint8Array(plain);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode");

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      // Twilio Media Stream mode bypasses Origin checks (Twilio typically omits Origin)
      const userAgent = request.headers.get("User-Agent") || "";
      const hasTwilioSig = request.headers.has("x-twilio-signature");
      const looksLikeTwilio =
        mode === "twilio" ||
        hasTwilioSig ||
        userAgent.includes("Twilio.TmeWs");
      if (looksLikeTwilio) {
        return createTwilioRealtimeBridge(request, env, ctx);
      }

      // Default relay uses Origin allowlist
      const origin = request.headers.get("Origin");
      if (!isAllowedOrigin(origin)) {
        return new Response("Unauthorized origin", { status: 403 });
      }

      return createRealtimeClient(request, env, ctx);
    }
    // Allow a simple OK on token/auth paths to avoid confusing logs/tools that ping these URLs without WS upgrade
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && (parts[0] === 'token' || parts[0] === 'auth')) {
      return new Response('OK', { status: 200 });
    }
    return new Response("Expected Upgrade: websocket", { status: 426 });
  },
};
