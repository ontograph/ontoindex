import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { startMCPServer } from '../../src/mcp/server.js';

const backend = {
  withOperation<T>(operation: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
    const signal = options?.signal;
    if (!signal) return operation();
    return new Promise<T>((_resolve, reject) => {
      const abort = () => {
        process.stderr.write('ABORTED\n');
        reject(signal.reason ?? new Error('Operation aborted'));
      };
      signal.addEventListener('abort', abort, { once: true });
      process.stderr.write('ENTERED\n');
      if (signal.aborted) abort();
    });
  },
  async dispose() {},
};

await startMCPServer(backend as unknown as LocalBackend);
