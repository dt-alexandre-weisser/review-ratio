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
 * The rate-limit key of a client address. IPv6 clients usually hold a whole /64, so one key per
 * full address would let a single client rotate through billions of keys: IPv6 addresses are
 * keyed by their /64 prefix. IPv4 and IPv4-mapped addresses are keyed as they are.
 */
export function networkKey(ip: string): string {
  const address =
    ip
      .trim()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) return mapped[1];
  if (!address.includes(':')) return address;
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  const prefix = groups.slice(0, 4).map((g) => (Number.parseInt(g, 16) || 0).toString(16));
  return `${prefix.join(':')}::/64`;
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

  /** Drops expired buckets, at most once per window: O(keys) amortised over a window. */
  function sweepExpired(at: number): void {
    if (at - lastSweep < options.windowMs) return;
    lastSweep = at;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  }

  return async (c, next) => {
    const at = now();
    sweepExpired(at);
    const key = options.keyOf(c);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      buckets.delete(key);
      // Full: evict the oldest bucket. A Map iterates in insertion order, so this is O(1).
      if (buckets.size >= maxKeys) {
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
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
