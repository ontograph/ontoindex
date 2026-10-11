import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompatibleStdioServerTransport } from '../../src/mcp/compatible-stdio-transport.js';

function onceMessage(transport: CompatibleStdioServerTransport): Promise<any> {
  return new Promise((resolve, reject) => {
    transport.onmessage = (message) => resolve(message);
    transport.onerror = (error) => reject(error);
  });
}

describe('CompatibleStdioServerTransport', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let transport: CompatibleStdioServerTransport;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    transport = new CompatibleStdioServerTransport(stdin, stdout);
  });

  it('parses coalesced LF and CRLF Content-Length frames in order', async () => {
    await transport.start();
    const onMessage = vi.fn();
    const onError = vi.fn();
    transport.onmessage = onMessage;
    transport.onerror = onError;
    const bodies = [1, 2].map((id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }));
    stdin.write(
      bodies
        .map((body, index) => {
          const separator = index === 0 ? '\n\n' : '\r\n\r\n';
          return `Content-Length: ${Buffer.byteLength(body)}${separator}${body}`;
        })
        .join(''),
    );
    expect(onMessage.mock.calls.map(([message]) => message.id)).toEqual([1, 2]);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([1, 1024])('waits for write completion with highWaterMark %i', async (highWaterMark) => {
    let complete!: (error?: Error | null) => void;
    const output = new Writable({
      highWaterMark,
      write(_chunk, _encoding, callback) {
        complete = callback;
      },
    });
    const sender = new CompatibleStdioServerTransport(stdin, output);
    await sender.start();
    const settled = vi.fn();
    const sending = sender.send({ jsonrpc: '2.0', id: 1, result: {} }).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    complete();
    await sending;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(output.listenerCount('error')).toBe(0);
    expect(output.listenerCount('drain')).toBe(0);
    await sender.close();
  });

  it('rejects asynchronous write callback errors without leaking listeners', async () => {
    const failure = new Error('write failed');
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(() => callback(failure));
      },
    });
    const sender = new CompatibleStdioServerTransport(stdin, output);
    await sender.start();
    await expect(sender.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toBe(failure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(output.listenerCount('error')).toBe(0);
    expect(output.listenerCount('drain')).toBe(0);
    await sender.close();
  });

  it('rejects synchronous write throws without leaking listeners', async () => {
    const failure = new Error('write threw');
    vi.spyOn(stdout, 'write').mockImplementation(() => {
      throw failure;
    });
    await transport.start();
    await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toBe(failure);
    expect(stdout.listenerCount('error')).toBe(0);
    expect(stdout.listenerCount('drain')).toBe(0);
  });

  it('parses Content-Length framed initialize requests', async () => {
    await transport.start();
    const messagePromise = onceMessage(transport);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex', version: '0.1' },
      },
    });

    stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);

    await expect(messagePromise).resolves.toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'codex' } },
    });
  });

  it('parses newline-delimited initialize requests', async () => {
    await transport.start();
    const messagePromise = onceMessage(transport);
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cursor', version: '0.1' },
        },
      })}\n`,
    );

    await expect(messagePromise).resolves.toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'cursor' } },
    });
  });

  it('continues after a malformed newline message in the same chunk', async () => {
    await transport.start();
    const onError = vi.fn();
    const onMessage = vi.fn();
    transport.onerror = onError;
    transport.onmessage = onMessage;

    stdin.write('{malformed}\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });

  it('continues after a malformed Content-Length body in the same chunk', async () => {
    await transport.start();
    const onError = vi.fn();
    const onMessage = vi.fn();
    transport.onerror = onError;
    transport.onmessage = onMessage;
    const validBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });

    stdin.write(
      `Content-Length: 1\r\n\r\nxContent-Length: ${Buffer.byteLength(validBody, 'utf8')}\r\n\r\n${validBody}`,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });

  it('detects newline framing after leading ASCII whitespace', async () => {
    await transport.start();
    const onMessage = vi.fn();
    transport.onmessage = onMessage;

    stdin.write(' {"jsonrpc":"2.0","id":1,"method":"ping"}\n');

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });

  it('responds with Content-Length framing after Content-Length input', async () => {
    await transport.start();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex', version: '0.1' },
      },
    });

    const messagePromise = onceMessage(transport);
    stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\n\n${body}`);
    await messagePromise;

    const chunks: Buffer[] = [];
    stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const raw = Buffer.concat(chunks).toString('utf8');

    expect(raw).toBe('Content-Length: 45\r\n\r\n{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
  });

  it('reports malformed Content-Length headers once without looping forever', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    stdin.write('Content-Length:\r\n\r\n{}');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('recovers after discarding a malformed Content-Length frame', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    stdin.write('Content-Length:\r\n\r\n{}');
    await new Promise((resolve) => setTimeout(resolve, 25));

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'recovery-client', version: '0.1' },
      },
    });
    const messagePromise = onceMessage(transport);
    stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);

    await expect(messagePromise).resolves.toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'recovery-client' } },
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // ─── Security hardening regressions ──────────────────────────────

  it('rejects Content-Length values exceeding the buffer cap', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    // 20 MB — exceeds the 10 MB MAX_BUFFER_SIZE
    stdin.write('Content-Length: 20971520\r\n\r\n{}');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message).toMatch(/exceeds maximum/i);
  });

  it('errors when read buffer exceeds maximum size in newline mode', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    // Send a JSON-starting chunk (triggers newline mode) with no newline,
    // then keep appending until we exceed the 10 MB cap
    const chunkSize = 1024 * 1024; // 1 MB
    const chunk = Buffer.alloc(chunkSize, 0x61); // 'a' repeated
    // First byte must be '{' to trigger newline framing detection
    const first = Buffer.from('{' + 'a'.repeat(chunkSize - 1));
    stdin.write(first);

    for (let i = 0; i < 10; i++) {
      stdin.write(chunk);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onError).toHaveBeenCalled();
    const hasMaxSizeError = onError.mock.calls.some(
      (call) => call[0] instanceof Error && /maximum size/i.test(call[0].message),
    );
    expect(hasMaxSizeError).toBe(true);
  });

  it('handles many consecutive empty lines without stack overflow', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    // First, seed the framing mode with a valid newline-delimited message
    const seed = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'seed', version: '0.1' },
      },
    });
    const seedPromise = onceMessage(transport);
    stdin.write(seed + '\n');
    await seedPromise;

    // Now send 15K empty lines followed by a real message — this would
    // stack-overflow with the old recursive readNewlineMessage
    const followup = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'notifications/initialized',
      params: {},
    });

    const messagePromise = onceMessage(transport);
    stdin.write('\n'.repeat(15_000) + followup + '\n');

    await expect(messagePromise).resolves.toMatchObject({
      method: 'notifications/initialized',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects send() after transport is closed', async () => {
    await transport.start();
    await transport.close();

    await expect(transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } })).rejects.toThrow(
      /closed/i,
    );
  });

  it('does not detect content-length framing from short ambiguous prefix', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    // Write only "cont" — fewer than 14 bytes, should NOT trigger
    // content-length detection. Transport should wait for more data.
    stdin.write(Buffer.from('cont'));
    await new Promise((resolve) => setTimeout(resolve, 25));

    // No message and no error — transport is waiting for more data
    expect(onError).not.toHaveBeenCalled();
  });

  it('responds with newline framing after newline input', async () => {
    await transport.start();
    const messagePromise = onceMessage(transport);
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cursor', version: '0.1' },
        },
      })}\n`,
    );
    await messagePromise;

    const chunks: Buffer[] = [];
    stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const raw = Buffer.concat(chunks).toString('utf8');

    expect(raw).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
  });
});
