import { describe, expect, it } from 'vitest';
import { LSPClient } from '../../src/core/lsp/client.js';

const frame = (payload: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
};

describe('LSPClient stdout framing', () => {
  it('resolves pending requests from Content-Length framed messages', async () => {
    const client = new LSPClient('unused') as any;
    const timer = setTimeout(() => {}, 10_000);
    const pending = new Promise((resolve, reject) => {
      client.pendingRequests.set(1, { resolve, reject, timer });
    });

    client.handleStdoutData(frame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));

    await expect(pending).resolves.toEqual({ ok: true });
    expect(client.pendingRequests.has(1)).toBe(false);
    clearTimeout(timer);
  });

  it('handles frames split across stdout chunks', async () => {
    const client = new LSPClient('unused') as any;
    const timer = setTimeout(() => {}, 10_000);
    const pending = new Promise((resolve, reject) => {
      client.pendingRequests.set(2, { resolve, reject, timer });
    });
    const message = frame({ jsonrpc: '2.0', id: 2, result: ['ref'] });

    client.handleStdoutData(message.subarray(0, 12));
    expect(client.pendingRequests.has(2)).toBe(true);
    client.handleStdoutData(message.subarray(12));

    await expect(pending).resolves.toEqual(['ref']);
    clearTimeout(timer);
  });

  it('rejects pending requests from framed LSP errors', async () => {
    const client = new LSPClient('unused') as any;
    const timer = setTimeout(() => {}, 10_000);
    const pending = new Promise((resolve, reject) => {
      client.pendingRequests.set(3, { resolve, reject, timer });
    });

    client.handleStdoutData(
      frame({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'failed' } }),
    );

    await expect(pending).rejects.toThrow('failed');
    clearTimeout(timer);
  });

  it('preserves non-string LSP error message coercion', async () => {
    const client = new LSPClient('unused') as any;
    const timer = setTimeout(() => {}, 10_000);
    const pending = new Promise((resolve, reject) => {
      client.pendingRequests.set(6, { resolve, reject, timer });
    });

    client.handleStdoutData(frame({ jsonrpc: '2.0', id: 6, error: { message: 123 } }));

    await expect(pending).rejects.toThrow('123');
    clearTimeout(timer);
  });

  it('rejects pending requests and clears the buffer when headers grow without a terminator', async () => {
    const client = new LSPClient('unused') as any;
    const timer = setTimeout(() => {}, 10_000);
    const pending = new Promise((resolve, reject) => {
      client.pendingRequests.set(4, { resolve, reject, timer });
    });

    client.handleStdoutData(Buffer.alloc(64 * 1024 + 1, 'x'));

    await expect(pending).rejects.toThrow('LSP header exceeded');
    expect(client.pendingRequests.has(4)).toBe(false);
    expect(client.stdoutBuffer.length).toBe(0);
  });

  it('rejects pending requests when a frame declares an oversized body', async () => {
    const client = new LSPClient('unused') as any;
    const timer = setTimeout(() => {}, 10_000);
    const pending = new Promise((resolve, reject) => {
      client.pendingRequests.set(5, { resolve, reject, timer });
    });

    client.handleStdoutData(Buffer.from(`Content-Length: ${10 * 1024 * 1024 + 1}\r\n\r\n`));

    await expect(pending).rejects.toThrow('LSP frame body exceeded');
    expect(client.pendingRequests.has(5)).toBe(false);
    expect(client.stdoutBuffer.length).toBe(0);
  });
});
