/**
 * Unit Tests: CORS origin allowlist
 *
 * Tests isAllowedOrigin() from server/api.ts, which controls which HTTP
 * Origins are permitted by the Express CORS middleware.
 *
 * Policy:
 *   - No origin (non-browser)         → allowed
 *   - http://localhost:<port>          → allowed
 *   - http://127.0.0.1:<port>         → allowed
 *   - https://ontoindex.vercel.app     → allowed
 *   - Everything else                 → rejected
 */
import { describe, it, expect } from 'vitest';
import { isAllowedOrigin, shouldAllowPrivateNetworkAccess } from '../../src/server/api.js';

// ─── No origin (non-browser / curl) ──────────────────────────────────

describe('isAllowedOrigin: no origin', () => {
  it('allows undefined origin (curl, server-to-server)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });
});

// ─── Localhost variants ───────────────────────────────────────────────

describe('isAllowedOrigin: localhost', () => {
  it('allows http://localhost:3000', () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
  });

  it('allows http://localhost:5173 (Vite default)', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
  });

  it('allows http://localhost:8080', () => {
    expect(isAllowedOrigin('http://localhost:8080')).toBe(true);
  });

  it('allows http://127.0.0.1:3000', () => {
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
  });

  it('allows http://127.0.0.1:5173', () => {
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
  });
});

// ─── Private Network Access ───────────────────────────────────────────

describe('shouldAllowPrivateNetworkAccess', () => {
  it('allows PNA headers for allowed origins', () => {
    expect(shouldAllowPrivateNetworkAccess('http://localhost:5173')).toBe(true);
    expect(shouldAllowPrivateNetworkAccess('https://ontoindex.vercel.app')).toBe(true);
  });

  it('rejects PNA headers for disallowed origins', () => {
    expect(shouldAllowPrivateNetworkAccess(undefined)).toBe(false);
    expect(shouldAllowPrivateNetworkAccess('https://evil.com')).toBe(false);
    expect(shouldAllowPrivateNetworkAccess('http://192.168.1.100:5173')).toBe(false);
  });
});

// ─── Deployed site ────────────────────────────────────────────────────

describe('isAllowedOrigin: vercel.app', () => {
  it('allows https://ontoindex.vercel.app', () => {
    expect(isAllowedOrigin('https://ontoindex.vercel.app')).toBe(true);
  });

  it('rejects other vercel.app subdomains', () => {
    expect(isAllowedOrigin('https://evil.vercel.app')).toBe(false);
  });
});

// ─── RFC 1918 private networks ────────────────────────────────────────

describe('isAllowedOrigin: private network origins', () => {
  it('rejects 10.x.x.x origins', () => {
    expect(isAllowedOrigin('http://10.0.0.1:3000')).toBe(false);
    expect(isAllowedOrigin('http://10.1.2.3:5173')).toBe(false);
    expect(isAllowedOrigin('http://10.255.255.255:8080')).toBe(false);
  });

  it('rejects 172.16-31.x.x origins', () => {
    expect(isAllowedOrigin('http://172.16.0.1:3000')).toBe(false);
    expect(isAllowedOrigin('http://172.20.1.2:3000')).toBe(false);
    expect(isAllowedOrigin('http://172.31.255.255:3000')).toBe(false);
  });

  it('rejects http://172.15.0.1:3000 (below range)', () => {
    expect(isAllowedOrigin('http://172.15.0.1:3000')).toBe(false);
  });

  it('rejects http://172.32.0.1:3000 (above range)', () => {
    expect(isAllowedOrigin('http://172.32.0.1:3000')).toBe(false);
  });

  it('rejects 192.168.x.x origins', () => {
    expect(isAllowedOrigin('http://192.168.0.1:3000')).toBe(false);
    expect(isAllowedOrigin('http://192.168.1.100:5173')).toBe(false);
    expect(isAllowedOrigin('http://192.168.255.254:8080')).toBe(false);
  });

  it('rejects http://192.167.1.1:3000 (adjacent, not private)', () => {
    expect(isAllowedOrigin('http://192.167.1.1:3000')).toBe(false);
  });

  it('rejects http://192.169.1.1:3000 (adjacent, not private)', () => {
    expect(isAllowedOrigin('http://192.169.1.1:3000')).toBe(false);
  });
});

// ─── Public / untrusted origins ───────────────────────────────────────

describe('isAllowedOrigin: rejected origins', () => {
  it('rejects https://evil.com', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
  });

  it('rejects https://example.com', () => {
    expect(isAllowedOrigin('https://example.com')).toBe(false);
  });

  it('rejects http://8.8.8.8:3000 (Google DNS, public IP)', () => {
    expect(isAllowedOrigin('http://8.8.8.8:3000')).toBe(false);
  });

  it('rejects https://ontoindex.example.com (not the official domain)', () => {
    expect(isAllowedOrigin('https://ontoindex.example.com')).toBe(false);
  });

  it('rejects malformed origin string', () => {
    expect(isAllowedOrigin('not-a-url')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAllowedOrigin('')).toBe(false);
  });

  // Localhost without explicit port (port 80 implied)
  it('allows http://localhost without port', () => {
    expect(isAllowedOrigin('http://localhost')).toBe(true);
  });

  it('allows http://127.0.0.1 without port', () => {
    expect(isAllowedOrigin('http://127.0.0.1')).toBe(true);
  });

  // IPv6 loopback
  it('allows IPv6 loopback http://[::1]:3000', () => {
    expect(isAllowedOrigin('http://[::1]:3000')).toBe(true);
  });

  it('allows IPv6 loopback http://[::1] without port', () => {
    expect(isAllowedOrigin('http://[::1]')).toBe(true);
  });

  // Protocol validation
  it('rejects non-HTTP(S) origins from private IPs', () => {
    expect(isAllowedOrigin('ftp://10.0.0.1')).toBe(false);
    expect(isAllowedOrigin('ftp://192.168.1.1')).toBe(false);
  });
});
