import { afterEach, describe, expect, it, vi } from 'vitest';
import Parser from 'tree-sitter';
import type {
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from '../../src/core/ingestion/workers/parse-types.js';

const port = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn() }));
vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: port,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function parse(content: string) {
  port.postMessage.mockClear();
  await import('../../src/core/ingestion/workers/parse-worker.js');
  const handler = port.on.mock.calls.find(([event]) => event === 'message')?.[1] as
    | ((message: WorkerIncomingMessage) => Promise<void>)
    | undefined;
  expect(handler).toBeDefined();
  await handler!([{ path: 'example.ts', content }]);
  const messages = port.postMessage.mock.calls.map(([message]) => message as WorkerOutgoingMessage);
  expect(messages.filter((message) => message.type === 'error')).toEqual([]);
  const result = messages.find((message) => message.type === 'result');
  if (result?.type !== 'result' || !result.data) throw new Error('Missing worker result');
  return { messages, data: result.data };
}

describe('source worker AST limits', () => {
  it.each(['parse', 'query'] as const)(
    'reports a real %s failure without claiming a size limit',
    async (phase) => {
      vi.stubEnv('ONTOINDEX_PARSE_MAX_AST_NODES', '');
      vi.stubEnv('ONTOINDEX_PARSE_MAX_AST_DEPTH', '');
      await import('../../src/core/ingestion/workers/parse-worker.js');
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fail = () => {
        throw new Error(`${phase}-sentinel`);
      };
      if (phase === 'parse') vi.spyOn(Parser.prototype, 'parse').mockImplementationOnce(fail);
      else vi.spyOn(Parser.Query.prototype, 'matches').mockImplementationOnce(fail);
      const { messages, data } = await parse(
        'import { value } from "./other"; export const result = value;',
      );
      expect(
        messages.some(
          (message) => message.type === 'warning' && message.message.includes(`${phase}-sentinel`),
        ),
      ).toBe(true);
      expect(data.symbols).toEqual([]);
      expect(data.imports.length).toBeGreaterThan(0);
      expect(warning.mock.calls.flat().join('\n')).not.toContain('AST or size limits');
    },
  );

  it('extracts definitions and calls with no configured AST limits', async () => {
    vi.stubEnv('ONTOINDEX_PARSE_MAX_AST_NODES', '');
    vi.stubEnv('ONTOINDEX_PARSE_MAX_AST_DEPTH', '');
    const { data, messages } = await parse(
      'export function target() {}\nexport function caller() { target(); }',
    );
    expect(data.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['target', 'caller']),
    );
    expect(data.calls).toEqual(
      expect.arrayContaining([expect.objectContaining({ calledName: 'target' })]),
    );
    expect(messages.filter((message) => message.type === 'warning')).toEqual([]);
  });

  it.each([
    ['ONTOINDEX_PARSE_MAX_AST_NODES', '5', /AST node.*\d+.*5/i],
    ['ONTOINDEX_PARSE_MAX_AST_DEPTH', '3', /AST depth.*3/i],
  ])(
    'reports the explicit %s ceiling instead of a file size failure',
    async (key, limit, reason) => {
      vi.stubEnv('ONTOINDEX_PARSE_MAX_AST_NODES', '');
      vi.stubEnv('ONTOINDEX_PARSE_MAX_AST_DEPTH', '');
      vi.stubEnv(key, limit);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { data, messages } = await parse('export function deep() { return (((((((1))))))); }');
      expect(data.symbols).toEqual([]);
      const warnings = messages.filter((message) => message.type === 'warning');
      expect(
        warnings.some((message) => message.type === 'warning' && reason.test(message.message)),
      ).toBe(true);
      expect(warning.mock.calls.flat().join('\n')).not.toContain('AST or size limits');
    },
  );
});
