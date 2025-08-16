import type { Env } from "./config/env";
import { isAllowedOrigin, RL_HTTP_CAPACITY, RL_HTTP_INTERVAL_MS, RL_WS_CAPACITY, RL_WS_INTERVAL_MS } from "./config/config";
import { getClientIp } from "./utils/ip";
import { rateLimitConsume, RateLimitBucket } from "./utils/rateLimiter";
import { handleTwilioVoiceWebhook } from "./http/twilio";
import { handleTwilioConversationsWebhook } from "./http/conversations";
import { createRealtimeClient } from "./realtime/client";
import { createTwilioRealtimeBridge } from "./realtime/twilioBridge";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode");
    const clientIp = getClientIp(request);

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      const userAgent = request.headers.get("User-Agent") || "";
      const hasTwilioSig = request.headers.has("x-twilio-signature");
      const looksLikeTwilio = mode === "twilio" || hasTwilioSig || userAgent.includes("Twilio.TmeWs");
      if (looksLikeTwilio) return createTwilioRealtimeBridge(request, env, ctx);

      const origin = request.headers.get("Origin");
      if (!isAllowedOrigin(origin)) return new Response("Unauthorized origin", { status: 403 });

      const rl = await rateLimitConsume(env, `ws:${clientIp}`, RL_WS_CAPACITY, RL_WS_INTERVAL_MS);
      if (!rl.allowed) {
        const retrySec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
        return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(retrySec) } });
      }
      return createRealtimeClient(request, env, ctx);
    }

    const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    if (pathname === "/twilio/convo" && request.method === "POST") return handleTwilioConversationsWebhook(request, env, ctx);
    if (pathname === "/twilio/voice" && (request.method === "POST" || request.method === "GET")) return handleTwilioVoiceWebhook(request, env);

    const httpRl = await rateLimitConsume(env, `http:${clientIp}`, RL_HTTP_CAPACITY, RL_HTTP_INTERVAL_MS);
    if (!httpRl.allowed) {
      const retrySec = Math.max(1, Math.ceil(httpRl.retryAfterMs / 1000));
      return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(retrySec) } });
    }

    if (request.method === 'POST' && request.headers.has('x-twilio-signature')) {
      console.log('[http] unexpected Twilio POST', { path: url.pathname });
      return new Response('ok', { status: 200 });
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && (parts[0] === 'token' || parts[0] === 'auth')) return new Response('OK', { status: 200 });
    return new Response("Expected Upgrade: websocket", { status: 426 });
  },
};

// Re-export the Durable Object class for Wrangler to bind
export { RateLimitBucket };


