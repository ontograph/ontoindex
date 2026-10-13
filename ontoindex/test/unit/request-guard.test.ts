import { describe, expect, it, vi } from 'vitest';
import {
  isTrustedHost,
  isTrustedOrigin,
  parseAllowedHosts,
} from '../../src/server/request-guard.js';

describe('request guard', () => {
  it('parses bounded allowed authorities and warns once for invalid entries', () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(parseAllowedHosts()).toEqual([]);
      expect(parseAllowedHosts('  ')).toEqual([]);
      expect(parseAllowedHosts(' LOCALHOST:8080, Example.COM, [::1]:4848 ')).toEqual([
        'localhost:8080',
        'example.com',
        '[::1]:4848',
      ]);
      expect(
        parseAllowedHosts('*,bad/path,localhost:bad,localhost:99999,' + 'x'.repeat(256)),
      ).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(1);
      warning.mockClear();
      expect(
        parseAllowedHosts(Array.from({ length: 33 }, (_, i) => `host${i}.example`).join(',')),
      ).toHaveLength(32);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
  it('matches explicit authorities independently of the backend port', () => {
    expect(isTrustedHost('localhost:8080', { port: 4848 })).toBe(false);
    expect(isTrustedHost('LOCALHOST:8080', { port: 4848, extraHosts: ['localhost:8080'] })).toBe(
      true,
    );
    expect(isTrustedHost('localhost:8081', { port: 4848, extraHosts: ['localhost:8080'] })).toBe(
      false,
    );
    expect(isTrustedHost('example.com:8081', { port: 4848, extraHosts: ['example.com'] })).toBe(
      true,
    );
    expect(isTrustedHost('evil.com', { extraHosts: ['*'] })).toBe(false);
    expect(isTrustedHost('[::1]:8080', { port: 4848, extraHosts: ['[::1]:8080'] })).toBe(true);
  });
  it('normalizes a single localhost trailing dot only', () => {
    expect(isTrustedHost('localhost.:4848', { port: 4848 })).toBe(true);
    expect(isTrustedHost('localhost..:4848', { port: 4848 })).toBe(false);
    expect(isTrustedHost('127.0.0.1.:4848', { port: 4848 })).toBe(false);
  });
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '[::1]'])('allows host %s', (host) => {
    expect(isTrustedHost(host, {})).toBe(true);
    expect(isTrustedHost(`${host}:4848`, { port: 4848 })).toBe(true);
    expect(isTrustedHost(`${host}:4849`, { port: 4848 })).toBe(false);
    expect(isTrustedHost(host, { port: 4848 })).toBe(false);
  });
  it.each([
    undefined,
    '',
    'evil.com',
    'localhost.evil.com',
    '127.0.0.1.evil.com',
    'localhost:bad',
    'localhost/path',
    'evil@localhost',
    'localhost?x',
    'localhost#x',
    ' localhost ',
    '127.1',
    '2130706433',
  ])('rejects host %s', (host) => {
    expect(isTrustedHost(host, {})).toBe(false);
  });
  it('allows the default HTTP port and explicit additional hosts', () => {
    expect(isTrustedHost('localhost', { port: 80 })).toBe(true);
    expect(isTrustedHost('example.com:4848', { port: 4848, extraHosts: ['example.com'] })).toBe(
      true,
    );
  });
  it.each([
    undefined,
    'http://localhost',
    'http://LOCALHOST:3000',
    'http://127.0.0.1:4848',
    'http://[::1]:3000',
    'https://ontoindex.vercel.app',
  ])('allows origin %s', (origin) => {
    expect(isTrustedOrigin(origin)).toBe(true);
  });
  it.each([
    null,
    'null',
    '',
    'bad',
    'https://localhost',
    'http://localhost.:4848',
    'http://evil.com',
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
    'https://ontoindex.vercel.app.evil.com',
    'http://evil@localhost',
    'http://127.1',
    'http://2130706433',
  ])('rejects origin %s', (origin) => {
    expect(isTrustedOrigin(origin as string | undefined)).toBe(false);
  });
});
