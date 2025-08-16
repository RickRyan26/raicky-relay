export type RateBucket = {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerMs: number;
};

// In-memory fallback for local/dev environments
function getLocalRateLimiter(): Map<string, RateBucket> {
  // @ts-expect-error attach ephemeral map to global
  globalThis.__rateLimiter ||= new Map<string, RateBucket>();
  // @ts-expect-error read back ephemeral map from global
  return globalThis.__rateLimiter as Map<string, RateBucket>;
}

function pruneLocalRateLimiter(): void {
  const buckets = getLocalRateLimiter();
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (
      bucket.tokens >= bucket.capacity &&
      now - bucket.lastRefill > 5 * 60 * 1000
    ) {
      buckets.delete(key);
    }
  }
}

export function rateLimitConsumeLocal(
  key: string,
  capacity: number,
  intervalMs: number
): { allowed: boolean; retryAfterMs: number } {
  const buckets = getLocalRateLimiter();
  const now = Date.now();
  const refillPerMs = capacity / intervalMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity - 1, lastRefill: now, capacity, refillPerMs };
    buckets.set(key, bucket);
    if (Math.random() < 0.01) pruneLocalRateLimiter();
    return { allowed: true, retryAfterMs: 0 };
  }
  let tokens = bucket.tokens + (now - bucket.lastRefill) * bucket.refillPerMs;
  if (tokens > capacity) tokens = capacity;
  if (tokens < 1) {
    bucket.tokens = tokens;
    bucket.lastRefill = now;
    bucket.capacity = capacity;
    bucket.refillPerMs = refillPerMs;
    const retryAfterMs = Math.ceil((1 - tokens) / bucket.refillPerMs);
    if (Math.random() < 0.01) pruneLocalRateLimiter();
    return { allowed: false, retryAfterMs };
  }
  tokens -= 1;
  bucket.tokens = tokens;
  bucket.lastRefill = now;
  bucket.capacity = capacity;
  bucket.refillPerMs = refillPerMs;
  if (Math.random() < 0.01) pruneLocalRateLimiter();
  return { allowed: true, retryAfterMs: 0 };
}

// Durable Object implementation
export class RateLimitBucket {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/consume") return new Response("Not Found", { status: 404 });

    let payload: { capacity: number; intervalMs: number };
    try {
      payload = (await request.json()) as { capacity: number; intervalMs: number };
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const { capacity, intervalMs } = payload;
    if (!Number.isFinite(capacity) || !Number.isFinite(intervalMs)) {
      return new Response("Bad Request", { status: 400 });
    }

    const now = Date.now();
    const refillPerMs = capacity / intervalMs;

    const bucket =
      ((await this.state.storage.get<RateBucket>("bucket")) as RateBucket | undefined) ||
      ({ tokens: capacity, lastRefill: now, capacity, refillPerMs } as RateBucket);

    let tokens = bucket.tokens + (now - bucket.lastRefill) * bucket.refillPerMs;
    if (tokens > capacity) tokens = capacity;

    if (tokens < 1) {
      const retryAfterMs = Math.ceil((1 - tokens) / refillPerMs);
      bucket.tokens = tokens;
      bucket.lastRefill = now;
      bucket.capacity = capacity;
      bucket.refillPerMs = refillPerMs;
      await this.state.storage.put("bucket", bucket);
      return new Response(JSON.stringify({ allowed: false, retryAfterMs }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    tokens -= 1;
    bucket.tokens = tokens;
    bucket.lastRefill = now;
    bucket.capacity = capacity;
    bucket.refillPerMs = refillPerMs;
    await this.state.storage.put("bucket", bucket);
    return new Response(JSON.stringify({ allowed: true, retryAfterMs: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Helper that prefers Durable Object, with local fallback
export async function rateLimitConsume(
  env: { RATE_LIMITER?: DurableObjectNamespace },
  key: string,
  capacity: number,
  intervalMs: number
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const ns = env.RATE_LIMITER;
  if (!ns) return rateLimitConsumeLocal(key, capacity, intervalMs);

  const id = ns.idFromName(key);
  const stub = ns.get(id);
  const res = await stub.fetch("https://do/consume", {
    method: "POST",
    body: JSON.stringify({ capacity, intervalMs }),
  });
  if (!res.ok) {
    // Fail open but conservative: allow with small retry
    return { allowed: true, retryAfterMs: 0 };
  }
  return (await res.json()) as { allowed: boolean; retryAfterMs: number };
}


