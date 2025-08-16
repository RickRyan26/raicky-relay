export type RateBucket = {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerMs: number;
};

function getRateLimiter(): Map<string, RateBucket> {
  // @ts-expect-error attach ephemeral map to global
  globalThis.__rateLimiter ||= new Map<string, RateBucket>();
  // @ts-expect-error read back ephemeral map from global
  return globalThis.__rateLimiter as Map<string, RateBucket>;
}

function pruneRateLimiter(): void {
  const buckets = getRateLimiter();
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.tokens >= bucket.capacity && now - bucket.lastRefill > 5 * 60 * 1000) {
      buckets.delete(key);
    }
  }
}

export function rateLimitConsume(
  key: string,
  capacity: number,
  intervalMs: number
): { allowed: boolean; retryAfterMs: number } {
  const buckets = getRateLimiter();
  const now = Date.now();
  const refillPerMs = capacity / intervalMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity - 1, lastRefill: now, capacity, refillPerMs };
    buckets.set(key, bucket);
    if (Math.random() < 0.01) pruneRateLimiter();
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
    if (Math.random() < 0.01) pruneRateLimiter();
    return { allowed: false, retryAfterMs };
  }
  tokens -= 1;
  bucket.tokens = tokens;
  bucket.lastRefill = now;
  bucket.capacity = capacity;
  bucket.refillPerMs = refillPerMs;
  if (Math.random() < 0.01) pruneRateLimiter();
  return { allowed: true, retryAfterMs: 0 };
}


