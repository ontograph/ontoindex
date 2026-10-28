import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const tsxImportUrl = pathToFileURL(
  path.join(path.dirname(require.resolve('tsx/package.json')), 'dist/loader.mjs'),
).href;

it('propagates SDK client cancellation to the backend over stdio while the server stays alive', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      tsxImportUrl,
      path.join(packageRoot, 'test/fixtures/mcp-stdio-cancellation-server.ts'),
    ],
    cwd: packageRoot,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-cancellation-test', version: '1' });
  const controller = new AbortController();
  let stderr = '';
  let closed = false;
  const observers = new Set<() => void>();
  transport.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
    for (const observe of observers) observe();
  });
  client.onclose = () => {
    closed = true;
    for (const observe of observers) observe();
  };

  async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observe!: () => void;
    const failure = new Promise<never>((_resolve, reject) => {
      observe = () => {
        if (closed) reject(new Error(`Child exited before ${label}`));
      };
      observers.add(observe);
      observe();
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 20_000);
    });
    try {
      return await Promise.race([operation, failure]);
    } finally {
      clearTimeout(timer);
      observers.delete(observe);
    }
  }

  async function waitForMarker(marker: string) {
    let observe!: () => void;
    const seen = new Promise<void>((resolve) => {
      observe = () => {
        if (stderr.split('\n').includes(marker)) resolve();
      };
      observers.add(observe);
      observe();
    });
    try {
      await bounded(seen, marker);
    } finally {
      observers.delete(observe);
    }
  }

  try {
    await bounded(client.connect(transport), 'client connection');
    const result = client
      .callTool({ name: 'discover', arguments: { action: 'repos' } }, undefined, {
        signal: controller.signal,
      })
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason }),
      );
    await waitForMarker('ENTERED');
    controller.abort();
    expect(await bounded(result, 'client rejection')).toMatchObject({ status: 'rejected' });
    await waitForMarker('ABORTED');
    expect(closed).toBe(false);
    expect(transport.pid).not.toBeNull();
    process.kill(transport.pid!, 0);
  } catch (error) {
    throw new Error(`${String(error)}\nChild stderr:\n${stderr}`, { cause: error });
  } finally {
    controller.abort();
    try {
      await transport.close();
    } catch (error) {
      throw new Error(`Transport cleanup failed: ${String(error)}\nChild stderr:\n${stderr}`, {
        cause: error,
      });
    }
  }
}, 70_000);
