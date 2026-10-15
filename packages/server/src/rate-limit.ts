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

/** Parses an IPv6 address into its eight 16-bit groups, or `null`. Accepts a dotted IPv4 tail. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined) => (part ? part.split(':') : []);
  const left = parse(halves[0]);
  const right = parse(halves[1]);
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/**
 * The rate-limit key of a client address. IPv6 clients usually hold a whole /64, so one key per
 * full address would let a single client rotate through billions of keys: IPv6 addresses are
 * keyed by their /64 prefix. IPv4, in any of its IPv6 spellings and with or without a port, is
 * keyed by the address itself.
 */
export function networkKey(ip: string): string {
  let address = ip.trim();
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(address);
  if (v4WithPort?.[1]) return v4WithPort[1];
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed?.[1]) address = bracketed[1];
  address = address.split('%')[0] ?? '';
  if (!address.includes(':')) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, not :: or ::1) are IPv4 clients.
  const v4Prefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (v4Prefix && (g5 === 0xffff || (g5 === 0 && g6 !== 0))) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
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
