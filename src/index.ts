// Copyright (c) 2024 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE file or at https://opensource.org/licenses/MIT

import { RealtimeClient } from "@openai/realtime-api-beta";

type Env = {
  OPENAI_API_KEY: string;
};

const DEBUG = false; // set as true to see debug logs
const MODEL = "gpt-4o-realtime-preview-2024-10-01";
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
const VOICE: "alloy" | "echo" | "shimmer" = "alloy";
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

function getSystemMessage(): string {
  return (
    `Voice: Be very friendly, kind, and expressive.

    Role: You are a knowledgeable specialist in high-end driveway gates, openers, and accessories.

    Objective: Understand the customer's needs, provide accurate information, and guide them to the perfect Gate Frames product or solution, driving sales and satisfaction.

    Strict Scope: Your knowledge is limited to GateFrames products (driveway gates, fences, accessories, etc.). If asked about unrelated items or services, politely decline and steer the conversation back to GateFrames offerings.

    Knowledge: Gate Frames began from this simple promise. Design custom-sized automatic steel and wood gates and fences of the highest industry standard, deliver them directly to our fellow Americans for free, and offer enjoyable easy to follow Do-It-Yourself installation guides.

    Guidelines:
    - Ask concise clarifying questions to understand the use-case (swing vs. slide, driveway width/slope, material/style preference, opener power and power source, climate, budget, security/accessory needs).
    - Keep responses warm, upbeat, and professional; prioritize clarity over humor unless the customer invites it.`
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
  const webSocketPair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(webSocketPair);

  serverSocket.accept();

  // Copy protocol headers
  const responseHeaders = new Headers();
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  let apiKey = env.OPENAI_API_KEY;
  if (protocolHeader) {
    const requestedProtocols = protocolHeader.split(",").map((p) => p.trim());
    if (requestedProtocols.includes("realtime")) {
      // Not exactly sure why this protocol needs to be accepted
      responseHeaders.set("Sec-WebSocket-Protocol", "realtime");
    }
  }

  if (!apiKey) {
    owrError(
      "Missing OpenAI API key. Did you forget to set OPENAI_API_KEY in .dev.vars (for local dev) or with wrangler secret put OPENAI_API_KEY (for production)?"
    );
    return new Response("Missing API key", { status: 401 });
  }

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

  serverSocket.addEventListener("message", (event: MessageEvent) => {
    const messageHandler = (data: string) => {
      try {
        const parsedEvent = JSON.parse(data);
        realtimeClient.realtime.send(parsedEvent.type, parsedEvent);
      } catch (e) {
        owrError("Error parsing event from client", data);
      }
    };

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

  // Connect to OpenAI Realtime API
  try {
    owrLog(`Connecting to OpenAI...`);
    // @ts-expect-error Waiting on https://github.com/openai/openai-realtime-api-beta/pull/52
    await realtimeClient.connect({ model });
    owrLog(`Connected to OpenAI successfully!`);
    while (messageQueue.length) {
      const message = messageQueue.shift();
      if (message) {
        serverSocket.send(message);
      }
    }
  } catch (e) {
    owrError("Error connecting to OpenAI", e);
    return new Response("Error connecting to OpenAI", { status: 500 });
  }

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
  // Echo Twilio's requested subprotocol (commonly 'audio')
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  if (protocolHeader) {
    const requested = protocolHeader.split(",").map((p) => p.trim());
    if (requested.includes("audio")) {
      responseHeaders.set("Sec-WebSocket-Protocol", "audio");
    }
  }

  const apiKey = env.OPENAI_API_KEY;
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
        voice: VOICE,
        instructions: getSystemMessage(),
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
            text:
              "Greet the customer with \"Hello! I’m your GateFrames.com A.I. assistant, and I hope your day is going well! Do you have a question about your driveway gate or it's installation?\"",
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
      if (mode === "twilio") {
        return createTwilioRealtimeBridge(request, env, ctx);
      }

      // Default relay uses Origin allowlist
      const origin = request.headers.get("Origin");
      if (!isAllowedOrigin(origin)) {
        return new Response("Unauthorized origin", { status: 403 });
      }

      return createRealtimeClient(request, env, ctx);
    }

    return new Response("Expected Upgrade: websocket", { status: 426 });
  },
};
