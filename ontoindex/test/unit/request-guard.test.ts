import { describe, expect, it } from 'vitest';
import { isTrustedHost, isTrustedOrigin } from '../../src/server/request-guard.js';

describe('request guard', () => {
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
