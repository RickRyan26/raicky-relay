import { RealtimeClient } from "@openai/realtime-api-beta";
import type { Env } from "../config/env";
import { LOG_EVENT_TYPES, MODEL, OPENAI_URL, SHOW_TIMING_MATH, TIME_LIMIT_MS, FINAL_TIME_LIMIT_MESSAGE } from "../config/config";
import { rackyError, rackyLog } from "../utils/log";
import { getAuthToken, validateAuth } from "../utils/auth";

export async function createRealtimeClient(
  request: Request,
  env: Env,
  ctx: ExecutionContext
) {
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
    rackyError(
      "Missing OpenAI API key. Did you forget to set OPENAI_API_KEY in .dev.vars (for local dev) or with wrangler secret put OPENAI_API_KEY (for production)?"
    );
    return new Response("Missing API key", { status: 401 });
  }

  const url = new URL(request.url);
  const auth = getAuthToken(url);
  const tokenOk = await validateAuth(auth, env, "client");
  if (!tokenOk) {
    return new Response("Unauthorized", { status: 401 });
  }

  const webSocketPair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(webSocketPair);
  serverSocket.accept();

  let realtimeClient: RealtimeClient | null = null;

  try {
    rackyLog("Creating OpenAIRealtimeClient");
    realtimeClient = new RealtimeClient({ apiKey, debug: true, url: OPENAI_URL });
  } catch (e) {
    rackyError("Error creating OpenAI RealtimeClient", e);
    serverSocket.close();
    return new Response("Error creating OpenAI RealtimeClient", { status: 500 });
  }

  const endClientDueToTimeLimit = () => {
    try {
      serverSocket.send(
        JSON.stringify({ type: "system.time_limit", message: FINAL_TIME_LIMIT_MESSAGE })
      );
    } catch {}
    try { serverSocket.close(4000, "time_limit"); } catch {}
    try { realtimeClient?.disconnect(); } catch {}
  };
  const clientTimeLimitTimer = setTimeout(endClientDueToTimeLimit, TIME_LIMIT_MS);

  realtimeClient.realtime.on("server.*", (event: { type: string }) => {
    serverSocket.send(JSON.stringify(event));
  });

  realtimeClient.realtime.on("close", (metadata: { error: boolean }) => {
    rackyLog(`Closing server-side because I received a close event: (error: ${metadata.error})`);
    serverSocket.close();
  });

  const messageQueue: string[] = [];
  const messageHandler = (data: string) => {
    try {
      const parsedEvent = JSON.parse(data);
      realtimeClient.realtime.send(parsedEvent.type, parsedEvent);
    } catch (e) {
      rackyError("Error parsing event from client", data);
    }
  };

  serverSocket.addEventListener("message", (event: MessageEvent) => {
    const data = typeof event.data === "string" ? event.data : event.data.toString();
    if (!realtimeClient.isConnected()) {
      messageQueue.push(data);
    } else {
      messageHandler(data);
    }
  });

  serverSocket.addEventListener("close", ({ code, reason }) => {
    rackyLog(`Closing server-side because the client closed the connection: ${code} ${reason}`);
    realtimeClient.disconnect();
    messageQueue.length = 0;
    try { clearTimeout(clientTimeLimitTimer); } catch {}
  });

  let model: string | undefined = MODEL;

  ctx.waitUntil(
    (async () => {
      try {
        rackyLog(`Connecting to OpenAI...`);
        // @ts-expect-error Waiting on openai sdk types
        await realtimeClient.connect({ model });
        rackyLog(`Connected to OpenAI successfully!`);
        while (messageQueue.length) {
          const message = messageQueue.shift();
          if (message) messageHandler(message);
        }
      } catch (e) {
        rackyError("Error connecting to OpenAI", e);
        try { serverSocket.close(1011, "Upstream connect failure"); } catch {}
      }
    })()
  );

  return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
}


