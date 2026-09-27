import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeParameterized } = vi.hoisted(() => ({ executeParameterized: vi.fn() }));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({ executeParameterized }));

import { resolveSymbolCandidates } from '../../src/mcp/local/backend-symbol-resolution.js';

const row = (id: string, filePath: string) => ({
  id,
  name: 'isWriteQuery',
  type: 'Function',
  filePath,
  startLine: 1,
  endLine: 3,
  content: '',
});

/** First call: name lookup rows; later calls (label enrichment) return nothing. */
const withNameRows = (rows: ReturnType<typeof row>[]) =>
  executeParameterized.mockImplementation(async (_repo: unknown, query: unknown) =>
    String(query ?? '').includes('$symName') ? rows : [],
  );

describe('resolveSymbolCandidates with same-named test helpers', () => {
  beforeEach(() => executeParameterized.mockReset());

  it('resolves a bare name to the only production symbol', async () => {
    withNameRows([
      row('Function:src/core/lbug/pool-adapter.ts:isWriteQuery', 'src/core/lbug/pool-adapter.ts'),
      row('Function:web/test/unit/guards.test.ts:isWriteQuery', 'web/test/unit/guards.test.ts'),
    ]);
    const outcome = await resolveSymbolCandidates({ id: 'repo' }, { name: 'isWriteQuery' }, {});
    expect(outcome.kind).toBe('ok');
    expect(outcome.kind === 'ok' && outcome.symbol.id).toBe(
      'Function:src/core/lbug/pool-adapter.ts:isWriteQuery',
    );
  });

  it('stays ambiguous when two production symbols share the name', async () => {
    withNameRows([
      row('Function:src/a.ts:isWriteQuery', 'src/a.ts'),
      row('Function:src/b.ts:isWriteQuery', 'src/b.ts'),
      row('Function:test/c.test.ts:isWriteQuery', 'test/c.test.ts'),
    ]);
    const outcome = await resolveSymbolCandidates({ id: 'repo' }, { name: 'isWriteQuery' }, {});
    expect(outcome.kind).toBe('ambiguous');
  });

  it('stays ambiguous when every candidate lives in a test file', async () => {
    withNameRows([
      row('Function:test/a.test.ts:isWriteQuery', 'test/a.test.ts'),
      row('Function:test/b.test.ts:isWriteQuery', 'test/b.test.ts'),
    ]);
    const outcome = await resolveSymbolCandidates({ id: 'repo' }, { name: 'isWriteQuery' }, {});
    expect(outcome.kind).toBe('ambiguous');
  });
});
