import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:module', async () => {
  const { createHash } = await import('node:crypto');
  const nativeDigest = createHash('sha256').update('native').digest('hex');
  const require = Object.assign(
    (name: string) => {
      if (name === 'node-gyp-build') return { path: (root: string) => `${root}/native.node` };
      return {
        __ontoindexNativeIdentity: { path: `/grammar/${name}/native.node`, digest: nativeDigest },
      };
    },
    { resolve: (name: string) => (name === 'node-gyp-build' ? name : `/grammar/${name}`) },
  );
  return { createRequire: () => require };
});

let bytes: Buffer;
beforeEach(() => {
  vi.resetModules();
  bytes = Buffer.from('first');
  const stat = (directory: boolean) =>
    ({
      dev: 1,
      ino: 1,
      mode: directory ? 0o755 : 0o644,
      size: 5,
      mtimeMs: 1,
      ctimeMs: 1,
      isFile: () => !directory,
      isDirectory: () => directory,
    }) as Stats;
  vi.spyOn(fs, 'lstat').mockImplementation((async (filename: string) =>
    stat(!path.extname(filename))) as typeof fs.lstat);
  vi.spyOn(fs, 'opendir').mockImplementation((async () => ({
    async *[Symbol.asyncIterator]() {
      yield { name: 'runtime.ts' };
    },
  })) as typeof fs.opendir);
  vi.spyOn(fs, 'open').mockImplementation((async () => {
    const content = Buffer.from(bytes);
    let offset = 0;
    return {
      stat: async () => stat(false),
      close: async () => {},
      read: async (buffer: Buffer, bufferOffset: number, length: number) => {
        const bytesRead = content.copy(buffer, bufferOffset, offset, offset + length);
        offset += bytesRead;
        return { bytesRead, buffer };
      },
    };
  }) as typeof fs.open);
  vi.spyOn(fs, 'readFile').mockImplementation((async () =>
    Buffer.from('native')) as typeof fs.readFile);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('supervised parser runtime baseline', () => {
  it('retains disk-only identities for callers that did not initialize supervision', async () => {
    const runtime = await import('../../src/core/tree-sitter/parser-identity.js');
    expect(await runtime.supervisedWorkspaceParserIdentity()).toBeNull();
    const initial = await runtime.workspaceParserIdentity();
    bytes = Buffer.from('other');
    expect(await runtime.workspaceParserIdentity()).not.toBe(initial);
  });

  it('accepts unchanged bytes after startup', async () => {
    const runtime = await import('../../src/core/tree-sitter/parser-identity.js');
    const initial = await runtime.initializeWorkspaceParserRuntime();
    expect(await runtime.supervisedWorkspaceParserIdentity()).toBe(initial);
    expect(await runtime.workspaceParserIdentity()).toBe(initial);
    expect(await runtime.workspaceParserIdentity()).toBe(initial);
  });

  it('shares concurrent initialization and cannot reset a successful baseline', async () => {
    const runtime = await import('../../src/core/tree-sitter/parser-identity.js');
    const initial = runtime.initializeWorkspaceParserRuntime();
    expect(runtime.initializeWorkspaceParserRuntime()).toBe(initial);
    await initial;
    bytes = Buffer.from('other');
    expect(runtime.initializeWorkspaceParserRuntime()).toBe(initial);
    await expect(runtime.workspaceParserIdentity()).rejects.toThrow(
      'Parser runtime changed; restart',
    );
    await expect(runtime.supervisedWorkspaceParserIdentity()).rejects.toThrow(
      'Parser runtime changed; restart',
    );
  });

  it('retains a rejected startup baseline after the filesystem recovers', async () => {
    const runtime = await import('../../src/core/tree-sitter/parser-identity.js');
    const failure = new Error('startup artifact unavailable');
    vi.mocked(fs.lstat).mockRejectedValueOnce(failure);
    const initial = runtime.initializeWorkspaceParserRuntime();
    await expect(initial).rejects.toBe(failure);
    expect(runtime.initializeWorkspaceParserRuntime()).toBe(initial);
    await expect(runtime.workspaceParserIdentity()).rejects.toBe(failure);
  });
});
