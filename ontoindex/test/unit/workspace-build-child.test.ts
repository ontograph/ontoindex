import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { events, runtimeImport, initialize, identity, analyze, exitCode } = vi.hoisted(() => ({
  events: [] as string[],
  runtimeImport: vi.fn(),
  initialize: vi.fn(),
  identity: vi.fn(),
  analyze: vi.fn(),
  exitCode: vi.fn(),
}));

vi.mock('../../src/core/tree-sitter/parser-identity.js', () => {
  runtimeImport();
  return { initializeWorkspaceParserRuntime: initialize, workspaceParserIdentity: identity };
});
vi.mock('../../src/core/run-analyze.js', () => {
  events.push('import');
  return { runFullAnalysis: analyze };
});
vi.mock('../../src/core/parent-watchdog.js', () => ({ startParentWatchdog: vi.fn() }));
vi.mock('../../src/mcp/local/workspace-build-supervisor.js', () => ({
  workspaceBuildExitCode: exitCode,
}));

const originalArgv = process.argv;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  events.length = 0;
  process.argv = ['node', 'workspace-build-child.js', '/repo'];
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  initialize.mockImplementation(async () => {
    events.push('initialize');
    return 'baseline';
  });
  identity.mockImplementation(async () => {
    events.push('verify');
    return 'baseline';
  });
  analyze.mockImplementation(async () => {
    events.push('analyze');
  });
  exitCode.mockReturnValue(17);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('supervised workspace child runtime admission', () => {
  it('initializes before analyzer import and verifies before analysis', async () => {
    await import('../../src/core/workspace-build-child.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    expect(events).toEqual(['initialize', 'import', 'verify', 'analyze']);
    expect(analyze).toHaveBeenCalledWith(
      '/repo',
      {
        workspaceGraph: true,
        skipNativeClose: true,
      },
      { onProgress: expect.any(Function) },
    );
  });

  it.each(['initialize', 'verify', 'analyze'] as const)(
    'preserves stderr and exit mapping when %s fails',
    async (stage) => {
      const failure = new Error(`${stage} failed`);
      ({ initialize, verify: identity, analyze })[stage]!.mockRejectedValueOnce(failure);
      await import('../../src/core/workspace-build-child.js');
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(17));
      expect(console.error).toHaveBeenCalledWith(failure.message);
      expect(exitCode).toHaveBeenCalledWith(failure);
      if (stage === 'initialize') expect(events).not.toContain('import');
      if (stage !== 'analyze') expect(analyze).not.toHaveBeenCalled();
    },
  );

  it('preserves the three-argument symbols analysis', async () => {
    process.argv.push('--symbols', '["src/example.ts"]');
    await import('../../src/core/workspace-build-child.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    expect(analyze).toHaveBeenCalledWith(
      '/repo',
      {
        dirtyOverlay: true,
        overlayPaths: ['src/example.ts'],
        skipNativeClose: true,
      },
      { onProgress: expect.any(Function) },
    );
  });

  it.each([
    { timeoutMs: 1, maxBytes: 1 },
    { timeoutMs: 120000, maxBytes: 67108864 },
  ])(
    'passes explicitly bounded retention %j with a deadline created before initialization',
    async (request) => {
      process.argv.push('--scope-retention', JSON.stringify(request));
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      initialize.mockImplementation(async () => {
        events.push('initialize');
        vi.mocked(Date.now).mockReturnValue(2000);
      });
      await import('../../src/core/workspace-build-child.js');
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(events.filter((event) => event !== 'import')).toEqual([
        'initialize',
        'verify',
        'analyze',
      ]);
      expect(analyze).toHaveBeenCalledWith(
        '/repo',
        {
          workspaceGraph: true,
          skipNativeClose: true,
        },
        { onProgress: expect.any(Function) },
        {
          scopeRetention: {
            deadline: 1000 + request.timeoutMs,
            artifactAllowance: { remainingBytes: request.maxBytes },
          },
        },
      );
    },
  );

  it.each([
    ['--scope-retention', 'invalid bounded scope retention'],
    ['--symbols', 'invalid bounded symbols paths'],
  ])('sanitizes malformed %s payload diagnostics', async (flag, diagnostic) => {
    const sentinel = 'private-payload-sentinel';
    process.argv.push(flag, `{"${sentinel}":`);
    await import('../../src/core/workspace-build-child.js');
    expect(console.error).toHaveBeenCalledExactlyOnceWith(diagnostic);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(sentinel);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(2);
    expect(runtimeImport).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ['--scope-retention'],
    ['--scope-retention', '{'],
    ...[
      'null',
      '[]',
      'true',
      '1',
      '{}',
      '{"timeoutMs":120000}',
      '{"maxBytes":67108864}',
      '{"timeoutMs":1,"maxBytes":1,"extra":true}',
      '{"timeoutMs":1,"maxBytes":1e309}',
      '{"timeoutMs":1e309,"maxBytes":1}',
      '{"timeoutMs":NaN,"maxBytes":1}',
      ...[0, -1, 1.5, 120001, Number.MAX_SAFE_INTEGER + 1].map((timeoutMs) =>
        JSON.stringify({ timeoutMs, maxBytes: 1 }),
      ),
      ...[0, -1, 1.5, 67108865, Number.MAX_SAFE_INTEGER + 1].map((maxBytes) =>
        JSON.stringify({ timeoutMs: 1, maxBytes }),
      ),
      '{"timeoutMs":"1","maxBytes":1}',
      '{"timeoutMs":1,"maxBytes":"1"}',
    ].map((request) => ['--scope-retention', request]),
    ['--unknown', '{}'],
    ['--symbols', '[]', '--scope-retention', '{"timeoutMs":1,"maxBytes":1}'],
    ['--scope-retention', '{"timeoutMs":1,"maxBytes":1}', '--symbols', '[]'],
  ])('rejects invalid admission %j before initialization and analyzer import', async (...args) => {
    process.argv = ['node', 'workspace-build-child.js', ...(args.length ? ['/repo', ...args] : [])];
    await import('../../src/core/workspace-build-child.js');
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(2);
    expect(console.error).toHaveBeenCalledOnce();
    expect(initialize).not.toHaveBeenCalled();
    expect(runtimeImport).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
    expect(exitCode).not.toHaveBeenCalled();
  });
});
