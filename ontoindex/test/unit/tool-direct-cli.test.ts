import { beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const callToolMock = vi.fn();
const writeSyncMock = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = initMock;
    callTool = callToolMock;
  },
}));

vi.mock('node:fs', () => ({
  writeSync: writeSyncMock,
}));

describe('direct CLI tool commands', () => {
  beforeEach(() => {
    vi.resetModules();
    initMock.mockReset();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    initMock.mockResolvedValue(true);
  });

  it('dispatches typed query documents through the typed backend path', async () => {
    callToolMock.mockResolvedValue({ results: [] });
    const { queryCommand } = await import('../../src/cli/tool.js');

    await queryCommand(
      'intent: release blocker diagnosis\nsymbol: loadGraphToLbug\nfile: src/core/lbug.ts\ngraph load',
      {
        typed: true,
        repo: 'ontoindex',
        limit: '3',
      },
    );

    expect(callToolMock).toHaveBeenCalledWith('query', {
      typedQuery: {
        intent: 'release blocker diagnosis',
        lines: [
          { type: 'symbol', query: 'loadGraphToLbug', lineNumber: 2 },
          { type: 'file', query: 'src/core/lbug.ts', lineNumber: 3 },
          { type: 'lex', query: 'graph load', lineNumber: 4 },
        ],
      },
      task_context: undefined,
      goal: undefined,
      limit: 3,
      include_content: false,
      repo: 'ontoindex',
    });
  });

  it('rejects unknown typed query document lines before backend dispatch', async () => {
    const { queryCommand } = await import('../../src/cli/tool.js');

    await expect(queryCommand('route: GET /api/search', { typed: true })).rejects.toThrow(
      'Unknown typed query line type "route" on line 1',
    );
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('leaves colon-prefixed plain queries unchanged unless --typed is set', async () => {
    callToolMock.mockResolvedValue({ results: [] });
    const { queryCommand } = await import('../../src/cli/tool.js');

    await queryCommand('route: GET /api/search', { repo: 'ontoindex' });

    expect(callToolMock).toHaveBeenCalledWith('query', {
      query: 'route: GET /api/search',
      task_context: undefined,
      goal: undefined,
      limit: undefined,
      include_content: false,
      repo: 'ontoindex',
    });
  });

  it('forwards passive retrieval opt-in query flags to LocalBackend params', async () => {
    callToolMock.mockResolvedValue({ results: [] });
    const { queryCommand } = await import('../../src/cli/tool.js');

    await queryCommand('auth flow', {
      consumeEnrichmentFacts: true,
      includePassiveRelatedFacts: true,
      includeMarkdownContext: true,
      includeMarkdownPpr: true,
    });

    expect(callToolMock).toHaveBeenCalledWith('query', {
      query: 'auth flow',
      task_context: undefined,
      goal: undefined,
      limit: undefined,
      include_content: false,
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
      include_markdown_ppr: true,
      repo: undefined,
    });
  });

  it('dispatches detect_changes with CLI-shaped arguments', async () => {
    callToolMock.mockResolvedValue({
      summary: {
        changed_files: 1,
        changed_count: 2,
        affected_count: 1,
        risk_level: 'low',
      },
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({
      scope: 'compare',
      baseRef: 'main',
      repo: 'ontoindex',
    });

    expect(callToolMock).toHaveBeenCalledWith('detect_changes', {
      scope: 'compare',
      base_ref: 'main',
      repo: 'ontoindex',
    });
    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Risk level: low'));
  });

  it('prints "No changes detected." when changed_count is 0', async () => {
    callToolMock.mockResolvedValue({
      summary: { changed_files: 0, changed_count: 0, affected_count: 0, risk_level: 'low' },
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('No changes detected.'));
  });

  it('prints error message when result contains an error', async () => {
    callToolMock.mockResolvedValue({ error: 'index is stale' });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Error: index is stale'));
  });

  it('truncates changed_symbols list beyond 15 and shows overflow count', async () => {
    const symbols = Array.from({ length: 17 }, (_, i) => ({
      type: 'function',
      name: `fn${i}`,
      filePath: `src/file${i}.ts`,
    }));
    callToolMock.mockResolvedValue({
      summary: { changed_files: 17, changed_count: 17, affected_count: 0, risk_level: 'low' },
      changed_symbols: symbols,
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('function fn14 → src/file14.ts');
    expect(output).not.toContain('fn15');
    expect(output).toContain('... and 2 more');
  });

  it('truncates affected_processes list beyond 10', async () => {
    const processes = Array.from({ length: 12 }, (_, i) => ({
      name: `proc${i}`,
      step_count: 3,
      changed_steps: [{ symbol: `sym${i}` }],
    }));
    callToolMock.mockResolvedValue({
      summary: { changed_files: 1, changed_count: 1, affected_count: 12, risk_level: 'low' },
      affected_processes: processes,
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('proc9');
    expect(output).not.toContain('proc10');
  });
});
