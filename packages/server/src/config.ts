/**
 * Configuration of the Node entry point, read from the environment and validated up front so a
 * misconfigured server fails at start rather than in production traffic.
 */
export interface ServerConfig {
  port: number;
  host: string;
  /** Proxies in front of the server that append to `X-Forwarded-For`. */
  trustedProxyHops: number;
}

export const DEFAULT_PORT = 8787;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function intFrom(
  env: Record<string, string | undefined>,
  name: string,
  max: number,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}, got "${raw}"`);
  }
  return Number(raw);
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const host = env['HOST'] && env['HOST'] !== '' ? env['HOST'] : '127.0.0.1';
  const port = intFrom(env, 'PORT', 65_535) ?? DEFAULT_PORT;
  const hops = intFrom(env, 'TRUSTED_PROXY_HOPS', 10);
  if (hops === undefined && !LOOPBACK.has(host)) {
    // Reachable from the network: the rate limit key depends on what sits in front. Guessing
    // wrong either lets clients forge their key or puts every client in one bucket.
    throw new Error(
      `TRUSTED_PROXY_HOPS is required when HOST is ${host}: 0 when clients connect directly, ` +
        '1 behind one proxy that appends to X-Forwarded-For (Cloud Run), and so on.',
    );
  }
  return { port, host, trustedProxyHops: hops ?? 0 };
}
