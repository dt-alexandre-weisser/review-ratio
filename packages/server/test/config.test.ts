import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('defaults to the loopback prototype setup', () => {
    expect(loadConfig({})).toEqual({ port: DEFAULT_PORT, host: '127.0.0.1', trustedProxyHops: 0 });
  });

  it('reads valid values', () => {
    expect(loadConfig({ PORT: '8080', HOST: '0.0.0.0', TRUSTED_PROXY_HOPS: '1' })).toEqual({
      port: 8080,
      host: '0.0.0.0',
      trustedProxyHops: 1,
    });
  });

  it('rejects malformed numbers instead of half-parsing them', () => {
    expect(() => loadConfig({ PORT: '80x' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '-1' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ TRUSTED_PROXY_HOPS: '1.5' })).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it('requires an explicit proxy setting when reachable from the network', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/TRUSTED_PROXY_HOPS is required/);
    expect(loadConfig({ HOST: '0.0.0.0', TRUSTED_PROXY_HOPS: '0' }).trustedProxyHops).toBe(0);
    expect(loadConfig({ HOST: 'localhost' }).trustedProxyHops).toBe(0);
  });
});
