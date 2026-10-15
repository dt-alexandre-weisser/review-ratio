import type { Context, MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  /** Requests allowed per key and window. */
  limit: number;
  windowMs: number;
  /** Identifies the client. Each entry point decides what it can trust (socket, proxy header). */
  keyOf: (c: Context) => string;
  now?: () => number;
  /** Upper bound of tracked keys, so a flood of addresses cannot exhaust memory. */
  maxKeys?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * The client address as seen by the outermost trusted proxy.
 *
 * Each proxy appends the address it received the request from, so with `trustedHops` proxies in
 * front of the server the client is the entry `trustedHops` from the end. Entries before it were
 * written by the client and can be forged. Returns `undefined` when the header is too short.
 */
export function forwardedClientIp(
  header: string | undefined,
  trustedHops: number,
): string | undefined {
  if (!header || trustedHops < 1) return undefined;
  const entries = header
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const ip = entries[entries.length - trustedHops];
  return ip && ip.length <= 64 ? ip : undefined;
}

/**
 * Fixed-window rate limit kept in memory. Good enough for one stateless instance: the endpoint
 * is anonymous, so the limit only has to stop a runaway client, not an attacker with many IPs.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 50_000;
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  function sweep(at: number): void {
    if (at - lastSweep < options.windowMs && buckets.size < maxKeys) return;
    lastSweep = at;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
    // Still full: drop the oldest buckets. A Map iterates in insertion order.
    for (const key of buckets.keys()) {
      if (buckets.size < maxKeys) break;
      buckets.delete(key);
    }
  }

  return async (c, next) => {
    const at = now();
    sweep(at);
    const key = options.keyOf(c);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      buckets.delete(key);
      bucket = { count: 0, resetAt: at + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const resetSeconds = String(Math.max(1, Math.ceil((bucket.resetAt - at) / 1000)));
    c.header('RateLimit-Limit', String(options.limit));
    c.header('RateLimit-Remaining', String(Math.max(0, options.limit - bucket.count)));
    c.header('RateLimit-Reset', resetSeconds);
    if (bucket.count > options.limit) {
      c.header('Retry-After', resetSeconds);
      return c.json(
        { error: { code: 'rate_limited', message: 'Too many requests. Try again later.' } },
        429,
      );
    }
    await next();
  };
}
