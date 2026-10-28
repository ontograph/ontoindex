import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectChanges, runImpactKernel, execFileText, resolveCommitRange, resolveAuditRepoHandle } =
  vi.hoisted(() => ({
    detectChanges: vi.fn(),
    runImpactKernel: vi.fn(),
    execFileText: vi.fn(),
    resolveCommitRange: vi.fn(),
    resolveAuditRepoHandle: vi.fn(),
  }));
vi.mock('../../../src/mcp/super/audit-ingest.js', () => ({ resolveAuditRepoHandle }));
vi.mock('../../../src/mcp/local/backend-detect-changes.js', () => ({ detectChanges }));
vi.mock('../../../src/core/process/exec-file.js', () => ({ execFileText }));
vi.mock('../../../src/storage/git.js', () => ({ resolveCommitRange }));
vi.mock('../../../src/core/impact/impact-kernel.js', async () => ({
  ...(await vi.importActual<typeof import('../../../src/core/impact/impact-kernel.js')>(
    '../../../src/core/impact/impact-kernel.js',
  )),
  runImpactKernel,
}));
const { collectVerificationDiff, evaluateVerifyDiff, gnVerifyDiff, gnTestGap } =
  await import('../../../src/mcp/super/write-through-verification.js');
const { dispatchSuper } = await import('../../../src/mcp/super/dispatch.js');
const repo = { id: 'scope', repoPath: '/repo' };
const selected = { id: 'selected-id', name: 'selected', filePath: 'src/selected.ts' };
const unrelated = { id: 'unrelated-id', name: 'unrelated', filePath: 'src/selected.ts.extra' };

describe('cold diff verification dispatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolveAuditRepoHandle.mockResolvedValue(repo);
    execFileText.mockResolvedValue('src/selected.ts\n');
    runImpactKernel.mockResolvedValue({ impacted: [], warnings: [] });
  });

  it.each(['gn_verify_diff', 'gn_test_gap'] as const)(
    'holds committed preparation through real %s diff collection',
    async (name) => {
      const events: string[] = [];
      let prepared = false;
      const backend = {
        resolveRepo: vi.fn(async () => {
          events.push('resolve');
          return repo;
        }),
        ensureRepoInitialized: vi.fn(async () => {
          events.push('initialize');
        }),
        withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => {
          events.push('prepare');
          prepared = true;
          try {
            const report = await operation();
            // Prepared reads may add blanket graph provenance; mixed verification
            // evidence must retain the report returned by the collector instead.
            return { ...report, preparedReadWrapper: true };
          } finally {
            prepared = false;
            events.push('release');
          }
        }),
      };
      detectChanges.mockImplementation(async () => {
        expect(prepared).toBe(true);
        events.push('discover');
        return { changed_symbols: [selected], warnings: [] };
      });
      runImpactKernel.mockImplementation(async () => {
        expect(prepared).toBe(true);
        events.push('impact');
        return { impacted: [], warnings: [] };
      });

      const report = await dispatchSuper(
        name,
        {
          repo: '/repo',
          changedFiles: ['src/selected.ts'],
          expectedFiles: ['src/selected.ts'],
        },
        'scope',
        undefined,
        undefined,
        backend,
      );

      expect(backend.resolveRepo).toHaveBeenCalledExactlyOnceWith('/repo');
      expect(backend.ensureRepoInitialized).toHaveBeenCalledExactlyOnceWith('scope');
      expect(backend.withPreparedRepoRead).toHaveBeenCalledExactlyOnceWith(
        repo,
        { needsRelationships: true, readMode: 'committed' },
        expect.any(Function),
      );
      expect(events).toEqual([
        'resolve',
        'initialize',
        'prepare',
        'discover',
        'impact',
        ...(name === 'gn_test_gap' ? ['impact'] : []),
        'release',
      ]);
      expect(report).toMatchObject({ actual: { changedSymbols: ['selected'] } });
      expect(report).not.toHaveProperty('preparedReadWrapper');
    },
  );

  it.each(['gn_verify_diff', 'gn_test_gap'] as const)(
    '%s fails before collection when cold initialization or preparation fails',
    async (name) => {
      for (const failure of ['initialize', 'prepare']) {
        const error = new Error(`${failure} blocked`);
        const backend = {
          resolveRepo: vi.fn(async () => repo),
          ensureRepoInitialized: vi.fn(async () => {
            if (failure === 'initialize') throw error;
          }),
          withPreparedRepoRead: vi.fn(async () => {
            throw error;
          }),
        };
        await expect(
          dispatchSuper(
            name,
            { changedFiles: ['src/selected.ts'] },
            'scope',
            undefined,
            undefined,
            backend,
          ),
        ).rejects.toBe(error);
        expect(backend.withPreparedRepoRead).toHaveBeenCalledTimes(failure === 'prepare' ? 1 : 0);
        expect(detectChanges).not.toHaveBeenCalled();
        expect(runImpactKernel).not.toHaveBeenCalled();
      }
    },
  );

  it.each([{ changedSymbols: ['manual'] }, { changedSymbols: [] }, { changedFiles: [] }])(
    'keeps explicitly graph-free verification inputs cold: %j',
    async (params) => {
      const backend = {
        resolveRepo: vi.fn(),
        ensureRepoInitialized: vi.fn(),
        withPreparedRepoRead: vi.fn(),
      };
      const report = await dispatchSuper(
        'gn_verify_diff',
        {
          expectedFiles: ['src/selected.ts'],
          ...params,
        },
        'scope',
        undefined,
        undefined,
        backend,
      );
      expect(report).toMatchObject({ status: 'PASS' });
      expect(backend.resolveRepo).not.toHaveBeenCalled();
      expect(backend.ensureRepoInitialized).not.toHaveBeenCalled();
      expect(backend.withPreparedRepoRead).not.toHaveBeenCalled();
      expect(detectChanges).not.toHaveBeenCalled();
      expect(runImpactKernel).not.toHaveBeenCalled();
    },
  );

  it('preserves direct dispatch without a read backend', async () => {
    detectChanges.mockResolvedValue({ changed_symbols: [selected], warnings: [] });
    const report = await dispatchSuper(
      'gn_verify_diff',
      {
        changedFiles: ['src/selected.ts'],
        expectedFiles: ['src/selected.ts'],
      },
      'scope',
    );
    expect(report).toMatchObject({ status: 'PASS', actual: { changedSymbols: ['selected'] } });
    expect(detectChanges).toHaveBeenCalledOnce();
  });

  it.each([{ symbol: 'selected' }, { filePath: 'src/selected.ts' }, { query: ' ' }])(
    'prepares target test-gap requests despite an empty diff: %j',
    async (target) => {
      const error = new Error('target preparation reached');
      const backend = {
        resolveRepo: vi.fn(async () => repo),
        ensureRepoInitialized: vi.fn(async () => {}),
        withPreparedRepoRead: vi.fn(async () => {
          throw error;
        }),
      };
      await expect(
        dispatchSuper(
          'gn_test_gap',
          { changedFiles: [], ...target },
          'scope',
          undefined,
          undefined,
          backend,
        ),
      ).rejects.toBe(error);
      expect(backend.ensureRepoInitialized).toHaveBeenCalledExactlyOnceWith('scope');
      expect(backend.withPreparedRepoRead).toHaveBeenCalledExactlyOnceWith(
        repo,
        { needsRelationships: true, readMode: 'committed' },
        expect.any(Function),
      );
      expect(detectChanges).not.toHaveBeenCalled();
    },
  );
});

describe('evaluateVerifyDiff symbol expectations', () => {
  const actual = {
    changedFiles: ['src/selected.ts'],
    changedSymbols: ['selected'],
    impactedSymbols: ['outsideCaller'],
    executedTests: [],
    symbolRecords: [],
    warnings: [],
  };
  it.each([
    [undefined, 'PASS', [], []],
    [[], 'FAIL', ['selected'], ['outsideCaller']],
    [['selected'], 'PASS', [], ['outsideCaller']],
    [['other'], 'FAIL', ['selected'], ['outsideCaller']],
  ] as const)('evaluates expectations %j', (expectedSymbols, status, changed, impacted) => {
    expect(
      evaluateVerifyDiff({ expectedFiles: actual.changedFiles, expectedSymbols, actual }),
    ).toEqual({
      status,
      unexpectedChangedFiles: [],
      unexpectedChangedSymbols: changed,
      unexpectedImpactedSymbols: impacted,
      missingRequiredTests: [],
    });
  });
  it('keeps file and required-test checks strict when symbols are omitted', () => {
    expect(
      evaluateVerifyDiff({ expectedFiles: [], expectedTests: ['required'], actual }),
    ).toMatchObject({
      status: 'FAIL',
      unexpectedChangedFiles: actual.changedFiles,
      missingRequiredTests: ['required'],
      unexpectedChangedSymbols: [],
    });
  });
});

describe('collectVerificationDiff changedFiles scope', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolveAuditRepoHandle.mockResolvedValue(repo);
    detectChanges.mockResolvedValue({
      changed_symbols: [selected, unrelated],
      warnings: ['Detector capped.'],
    });
    runImpactKernel.mockResolvedValue({
      impacted: [{ name: 'outsideCaller', filePath: 'other/caller.ts' }],
      warnings: [],
    });
    execFileText.mockResolvedValue('src/selected.ts\nsrc/selected.ts.extra\n');
  });

  it('filters exact file membership before impact and preserves outside callers and detector warnings', async () => {
    const result = await collectVerificationDiff(repo, { changedFiles: ['src/selected.ts'] });
    expect(result.changedSymbols).toEqual(['selected']);
    expect(result.impactedSymbols).toEqual(['outsideCaller']);
    expect(result.warnings).toEqual(['Detector capped.']);
    expect(runImpactKernel).toHaveBeenCalledTimes(1);
    expect(runImpactKernel.mock.calls[0][1]).toMatchObject(selected);
    expect(execFileText).not.toHaveBeenCalled();
    expect(detectChanges).toHaveBeenCalledWith(repo, {
      scope: 'unstaged',
      changed_files: ['src/selected.ts'],
    });
  });

  it('skips automatic detection for an empty supplied file list', async () => {
    const result = await collectVerificationDiff(repo, { changedFiles: [] });
    expect(result.symbolRecords).toEqual([]);
    expect(result.impactedSymbols).toEqual([]);
    expect(detectChanges).not.toHaveBeenCalled();
    expect(runImpactKernel).not.toHaveBeenCalled();
  });

  it('preserves ambient detection when changedFiles is omitted', async () => {
    const result = await collectVerificationDiff(repo, {});
    expect(result.changedSymbols).toEqual(['selected', 'unrelated']);
    expect(execFileText).toHaveBeenCalledTimes(1);
    expect(runImpactKernel).toHaveBeenCalledTimes(2);
  });

  it('keeps explicitly supplied symbols authoritative even with an empty file list', async () => {
    const result = await collectVerificationDiff(repo, {
      changedFiles: [],
      changedSymbols: ['manual'],
    });
    expect(result.changedSymbols).toEqual(['manual']);
    expect(detectChanges).not.toHaveBeenCalled();
    expect(runImpactKernel).not.toHaveBeenCalled();
  });

  it.each([
    './src/selected.ts',
    '/repo/src/selected.ts',
    'src/other/../selected.ts',
    'src\\selected.ts',
  ])('normalizes selected in-repo path %s', async (file) => {
    expect((await collectVerificationDiff(repo, { changedFiles: [file] })).changedSymbols).toEqual([
      'selected',
    ]);
    expect(detectChanges.mock.calls[0][1].changed_files).toEqual(['src/selected.ts']);
  });

  it('passes normalized selected paths to compare detection', async () => {
    await collectVerificationDiff(repo, {
      changedFiles: ['./src/selected.ts'],
      diffRef: 'main',
    });
    expect(detectChanges).toHaveBeenCalledWith(repo, {
      scope: 'compare',
      base_ref: 'main',
      changed_files: ['src/selected.ts'],
    });
    expect(resolveCommitRange).toHaveBeenCalledWith('/repo', 'main');
  });

  it('normalizes detected paths and excludes outside paths', async () => {
    detectChanges.mockResolvedValue({
      changed_symbols: [
        { ...selected, filePath: '/repo/src/other/../selected.ts' },
        { ...unrelated, filePath: '/elsewhere/src/selected.ts' },
      ],
    });
    expect(
      (
        await collectVerificationDiff(repo, {
          changedFiles: ['src\\selected.ts'],
        })
      ).changedSymbols,
    ).toEqual(['selected']);
  });

  it.each(['../elsewhere/src/selected.ts', '/elsewhere/file.ts', '.', '/repo', 'src/..'])(
    'fails closed for invalid selection %s without detecting ambient changes',
    async (file) => {
      const actual = await collectVerificationDiff(repo, {
        changedFiles: ['src/selected.ts', file],
      });
      expect(actual.collectionFailed).toBe(true);
      expect(actual.changedSymbols).toEqual([]);
      expect(actual.warnings).toContainEqual(
        expect.stringContaining('not a repository-relative file'),
      );
      expect(detectChanges).not.toHaveBeenCalled();
      expect(evaluateVerifyDiff({ expectedFiles: actual.changedFiles, actual }).status).toBe(
        'FAIL',
      );
    },
  );

  it.each([undefined, [], ['selected']])(
    'fails verification on detector error with expectations %j',
    async (expectedSymbols) => {
      detectChanges.mockResolvedValue({ error: 'Detector failed.' });
      const report = await gnVerifyDiff('scope', {
        changedFiles: ['src/selected.ts'],
        expectedFiles: ['src/selected.ts'],
        expectedSymbols,
      });
      expect(report.status).toBe('FAIL');
      expect(report.warnings).toContain('Detector failed.');
      expect(report.skipReasons).toContain('Diff collection failed; verification is incomplete.');
      expect(report.actual).not.toHaveProperty('collectionFailed');
    },
  );

  it('does not let expectedFiles select detector inputs', async () => {
    await gnVerifyDiff('scope', { expectedFiles: ['src/selected.ts'] });
    expect(detectChanges).toHaveBeenCalledWith(repo, { scope: 'unstaged' });
  });

  it('warns when omitted expectedFiles makes changed files unexpected', async () => {
    const report = await gnVerifyDiff('scope', { changedFiles: ['src/selected.ts'] });
    expect(report.status).toBe('FAIL');
    expect(report.unexpectedChangedFiles).toEqual(['src/selected.ts']);
    expect(report.warnings).toEqual([
      'Detector capped.',
      'expectedFiles not provided; every changed file is reported as unexpected.',
    ]);
    expect(report.skipReasons).toEqual([
      'expectedSymbols not provided; symbol scope was not checked.',
    ]);
  });

  it.each([[[]], [['src/selected.ts']]])(
    'does not warn about omitted expectedFiles when provided as %j',
    async (expectedFiles) => {
      const report = await gnVerifyDiff('scope', {
        changedFiles: ['src/selected.ts'],
        expectedFiles,
      });
      expect(report.status).toBe(expectedFiles.length === 0 ? 'FAIL' : 'PASS');
      expect(report.warnings).toEqual(['Detector capped.']);
    },
  );

  it('does not warn about omitted expectedFiles for an empty diff', async () => {
    const report = await gnVerifyDiff('scope', { changedFiles: [] });
    expect(report.status).toBe('PASS');
    expect(report.warnings).toEqual([]);
  });

  it('warns that a zero-production-symbol test-gap PASS does not establish coverage', async () => {
    detectChanges.mockResolvedValue({ changed_symbols: [], warnings: ['Detector capped.'] });
    const report = await gnTestGap('scope', { changedFiles: ['src/selected.ts'] });
    expect(report.status).toBe('PASS');
    expect(report.changedProductionSymbolCount).toBe(0);
    expect(report.warnings).toEqual([
      'Detector capped.',
      'No changed production symbols; PASS does not establish test coverage.',
    ]);
    expect(report.skipReasons).toEqual([]);
  });

  it('fails diff test-gap verification when collection fails without exposing internal state', async () => {
    detectChanges.mockResolvedValue({ error: 'Detector failed.' });
    const report = await gnTestGap('scope', { changedFiles: ['src/selected.ts'] });
    expect(report.status).toBe('FAIL');
    expect(report.warnings).toContain('Detector failed.');
    expect(report.skipReasons).toContain('Diff collection failed; verification is incomplete.');
    expect(report.actual).not.toHaveProperty('collectionFailed');
  });

  it.each([{ warnings: [] }, { warnings: ['Detector capped.'] }])(
    'passes successful empty diff test-gap collection with warnings $warnings',
    async ({ warnings }) => {
      detectChanges.mockResolvedValue({ changed_symbols: [], warnings });
      const report = await gnTestGap('scope', { changedFiles: ['src/selected.ts'] });
      expect(report.status).toBe('PASS');
      expect(report.warnings).toEqual([
        ...warnings,
        'No changed production symbols; PASS does not establish test coverage.',
      ]);
      expect(report.skipReasons).toEqual([]);
      expect(report.actual).not.toHaveProperty('collectionFailed');
    },
  );

  it('passes successful collection with ordinary warnings', async () => {
    const actual = await collectVerificationDiff(repo, { changedFiles: ['src/selected.ts'] });
    expect(evaluateVerifyDiff({ expectedFiles: actual.changedFiles, actual }).status).toBe('PASS');
    expect(actual.warnings).toContain('Detector capped.');
  });

  it('passes genuinely empty successful detection', async () => {
    execFileText.mockResolvedValue('');
    detectChanges.mockResolvedValue({ changed_symbols: [], warnings: [] });
    const actual = await collectVerificationDiff(repo, {});
    expect(evaluateVerifyDiff({ expectedFiles: [], expectedSymbols: [], actual }).status).toBe(
      'PASS',
    );
    expect(actual).not.toHaveProperty('collectionFailed');
  });

  it('retains symbols missing provenance with a warning', async () => {
    detectChanges.mockResolvedValue({
      changed_symbols: [{ id: 'unknown-id', name: 'unknown' }, unrelated],
    });
    const result = await collectVerificationDiff(repo, { changedFiles: ['src/selected.ts'] });
    expect(result.changedSymbols).toEqual(['unknown']);
    expect(result.warnings).toEqual([expect.stringContaining('no file provenance')]);
  });

  it('preserves impact cap warnings after selection', async () => {
    detectChanges.mockResolvedValue({
      changed_symbols: Array.from({ length: 26 }, (_, i) => ({
        ...selected,
        id: `id-${i}`,
        name: `name-${i}`,
      })),
    });
    const result = await collectVerificationDiff(repo, { changedFiles: ['src/selected.ts'] });
    expect(runImpactKernel).toHaveBeenCalledTimes(25);
    expect(result.warnings).toContain('Impact scan capped at 25 changed symbols.');
  });

  it('validates compare refs even when automatic detection is skipped', async () => {
    resolveCommitRange.mockRejectedValue(new Error('invalid ref'));
    await expect(
      collectVerificationDiff(repo, { changedFiles: [], diffRef: '--unsafe' }),
    ).rejects.toThrow('invalid ref');
    expect(resolveCommitRange).toHaveBeenCalledWith('/repo', '--unsafe');
    expect(detectChanges).not.toHaveBeenCalled();
  });
});
