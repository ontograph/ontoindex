import { beforeEach, describe, expect, it, vi } from 'vitest';

const disposeMock = vi.fn();
const initMock = vi.fn();
const callToolMock = vi.fn();
const constructorMock = vi.fn();
const writeSyncMock = vi.fn();
const resolveRepoMock = vi.fn();
const ensureRepoInitializedMock = vi.fn();
const withPreparedRepoReadMock = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    constructor(options?: unknown) {
      constructorMock(options);
    }

    dispose = disposeMock;
    init = initMock;
    callTool = callToolMock;
    resolveRepo = resolveRepoMock;
    ensureRepoInitialized = ensureRepoInitializedMock;
    withPreparedRepoRead = withPreparedRepoReadMock;
  },
}));

vi.mock('node:fs', () => ({
  writeSync: writeSyncMock,
}));

describe('direct CLI tool commands', () => {
  beforeEach(() => {
    vi.resetModules();
    disposeMock.mockReset();
    constructorMock.mockReset();
    initMock.mockReset();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    initMock.mockResolvedValue(true);
    resolveRepoMock.mockReset().mockResolvedValue({ id: 'ontoindex' });
    ensureRepoInitializedMock.mockReset().mockResolvedValue(undefined);
    withPreparedRepoReadMock
      .mockReset()
      .mockImplementation((_repo, _options, operation) => operation());
  });

  it('writes output before disposing and creates a fresh backend for the next command', async () => {
    callToolMock.mockResolvedValue({ results: [] });
    const { contextCommand } = await import('../../src/cli/tool.js');

    await contextCommand('first');

    expect(writeSyncMock).toHaveBeenCalledWith(1, '{\n  "results": []\n}\n');
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(writeSyncMock.mock.invocationCallOrder[0]).toBeLessThan(
      disposeMock.mock.invocationCallOrder[0],
    );
    await contextCommand('second');
    expect(constructorMock).toHaveBeenCalledTimes(2);
    expect(disposeMock).toHaveBeenCalledTimes(2);
  });

  it('disposes the backend when a command fails', async () => {
    callToolMock.mockRejectedValue(new Error('tool failed'));
    const { contextCommand } = await import('../../src/cli/tool.js');

    await expect(contextCommand('first')).rejects.toThrow('tool failed');
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it('creates direct CLI backend with cwd as preferred project path', async () => {
    callToolMock.mockResolvedValue({ results: [] });
    const { queryCommand } = await import('../../src/cli/tool.js');

    await queryCommand('auth flow', {});

    expect(constructorMock).toHaveBeenCalledWith({ preferredProjectPath: process.cwd() });
  });

  it.each(['query', 'context', 'impact'] as const)(
    'forwards explicit committed read mode for %s without changing the default',
    async (command) => {
      callToolMock.mockResolvedValue({ results: [] });
      const { queryCommand, contextCommand, impactCommand } = await import('../../src/cli/tool.js');
      const run = { query: queryCommand, context: contextCommand, impact: impactCommand }[command];

      await run('symbol');
      expect(callToolMock.mock.calls[0][1]).not.toHaveProperty('read_mode');
      expect(withPreparedRepoReadMock).not.toHaveBeenCalled();
      await run('symbol', { readMode: 'committed', repo: 'ontoindex' });
      expect(resolveRepoMock).toHaveBeenCalledWith('ontoindex');
      expect(ensureRepoInitializedMock).toHaveBeenCalledWith('ontoindex');
      expect(withPreparedRepoReadMock).toHaveBeenCalledWith(
        { id: 'ontoindex' },
        { needsRelationships: true, readMode: 'committed' },
        expect.any(Function),
      );
      expect(callToolMock).toHaveBeenLastCalledWith(
        command,
        expect.objectContaining({ read_mode: 'committed' }),
      );
    },
  );

  it('forwards impact UID to resolve same-name symbols', async () => {
    callToolMock.mockResolvedValue({ results: [] });
    const { impactCommand } = await import('../../src/cli/tool.js');

    await impactCommand('Symbol', {
      uid: 'Struct:src/lib.rs:Symbol',
      readMode: 'committed',
      repo: 'ontoindex',
    });

    expect(callToolMock).toHaveBeenCalledWith(
      'impact',
      expect.objectContaining({ target_uid: 'Struct:src/lib.rs:Symbol', read_mode: 'committed' }),
    );
  });

  it('recommends committed impact after a workspace size refusal', async () => {
    const failure = Object.assign(new Error('workspace_preparation_failed: workspace_too_large'), {
      code: 'workspace_too_large',
    });
    callToolMock.mockRejectedValue(failure);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    try {
      const { impactCommand } = await import('../../src/cli/tool.js');
      await expect(impactCommand('Symbol')).rejects.toThrow('exit');

      const result = JSON.parse(writeSyncMock.mock.calls[0][1]);
      expect(result.suggestion).toContain(
        'ontoindex impact <symbol> --repo <name> --read-mode committed',
      );
      expect(result.suggestion).not.toContain('--depth');
      expect(disposeMock).toHaveBeenCalledOnce();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it.each([undefined, '', '@group'])(
    'rejects committed reads without a single repo: %s',
    async (repo) => {
      const { queryCommand } = await import('../../src/cli/tool.js');

      await expect(queryCommand('symbol', { readMode: 'committed', repo })).rejects.toThrow(
        'Committed reads require an explicit single repository',
      );
      expect(constructorMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    'consumeEnrichmentFacts',
    'includePassiveRelatedFacts',
    'includeMarkdownContext',
    'includeMarkdownPpr',
  ] as const)('rejects committed reads with %s before backend startup', async (flag) => {
    const { queryCommand } = await import('../../src/cli/tool.js');

    await expect(
      queryCommand('symbol', { readMode: 'committed', repo: 'ontoindex', [flag]: true }),
    ).rejects.toThrow('Committed reads do not support live or external enrichment');
    expect(constructorMock).not.toHaveBeenCalled();
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
      include_explanations: false,
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
      include_explanations: false,
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
      include_explanations: false,
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
      include_markdown_ppr: true,
      repo: undefined,
    });
  });

  it('forwards path filters and explanation opt-in query flags to LocalBackend params', async () => {
    callToolMock.mockResolvedValue({ results: [] });
    const { queryCommand } = await import('../../src/cli/tool.js');

    await queryCommand('auth flow', {
      includeExplanations: true,
      includePath: ['src/core', 'src/mcp'],
      excludePath: ['src/core/generated'],
    });

    expect(callToolMock).toHaveBeenCalledWith('query', {
      query: 'auth flow',
      task_context: undefined,
      goal: undefined,
      limit: undefined,
      include_content: false,
      include_explanations: true,
      include_paths: ['src/core', 'src/mcp'],
      exclude_paths: ['src/core/generated'],
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
      includePath: ['src/core', 'src/mcp'],
      repo: 'ontoindex',
    });

    expect(callToolMock).toHaveBeenCalledWith('detect_changes', {
      scope: 'compare',
      base_ref: 'main',
      include_paths: ['src/core', 'src/mcp'],
      repo: 'ontoindex',
    });
    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Risk level: low'));
  });

  it('prints detect_changes warnings when scope filtering omits ambient dirty files', async () => {
    callToolMock.mockResolvedValue({
      summary: { changed_files: 1, changed_count: 1, affected_count: 0, risk_level: 'low' },
      warnings: ['Omitted 1 changed file outside include_paths (src): docs/notes.md'],
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({ includePath: ['src'] });

    expect(writeSyncMock).toHaveBeenCalledWith(
      1,
      expect.stringContaining(
        'Warnings:\n  - Omitted 1 changed file outside include_paths (src): docs/notes.md',
      ),
    );
  });

  it('prints scoped no-change messages from detect_changes summary', async () => {
    callToolMock.mockResolvedValue({
      summary: {
        changed_files: 0,
        changed_count: 0,
        affected_count: 0,
        risk_level: 'none',
        message: 'No in-scope changes detected.',
      },
      warnings: ['Omitted 1 changed file outside include_paths (src): docs/notes.md'],
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({ includePath: ['src'] });

    expect(writeSyncMock).toHaveBeenCalledWith(
      1,
      expect.stringContaining(
        'No in-scope changes detected.\n\nWarnings:\n  - Omitted 1 changed file outside include_paths (src): docs/notes.md',
      ),
    );
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
