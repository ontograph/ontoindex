import { describe, expect, it } from 'vitest';
import { summarizeScopeRetentionCoverage } from '../../src/core/ingestion/pipeline-phases/scope-retention-coverage.js';
import {
  planScopeRetentionReplay,
  type ScopeRetentionReplayInput,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-replay-plan.js';

function input(overrides: Partial<ScopeRetentionReplayInput> = {}): ScopeRetentionReplayInput {
  return {
    changedPaths: ['src/callee.ts'],
    retainedFiles: ['src/caller.ts'],
    coverage: { version: 1, languages: [], complete: true },
    admission: 'proven',
    ...overrides,
  };
}

describe('planScopeRetentionReplay', () => {
  it('returns the sorted unique union of retained and changed files', () => {
    expect(
      planScopeRetentionReplay(
        input({
          changedPaths: ['src/z.ts', 'src/a.ts', 'src/z.ts'],
          retainedFiles: ['src/b.ts', 'src/a.ts'],
        }),
      ),
    ).toEqual({ kind: 'replay', files: ['src/a.ts', 'src/b.ts', 'src/z.ts'] });
  });

  it('requires independent proven admission even with complete coverage', () => {
    expect(planScopeRetentionReplay(input({ admission: 'unproven' }))).toEqual({
      kind: 'full-analysis-required',
      reason: 'admission-unproven',
    });
  });

  it.each([
    { inventory: [{ filePath: 'src/caller.ts', status: 'retained' }] },
    { inventory: [{ filePath: 'src/caller.ts', status: 'skipped' }] },
    {
      inventory: [
        { filePath: 'src/caller.ts', status: 'retained' },
        { filePath: 'src/skipped.ts', status: 'skipped' },
        { filePath: 'README.md', status: 'missing-outcome' },
      ],
    },
  ])('does not admit replay from complete inventory coverage alone: %j', ({ inventory }) => {
    const coverage = summarizeScopeRetentionCoverage(inventory);
    expect(coverage.complete).toBe(true);
    expect(planScopeRetentionReplay(input({ coverage, admission: 'unproven' }))).toEqual({
      kind: 'full-analysis-required',
      reason: 'admission-unproven',
    });
  });

  it.each(['failed', 'unsupported'])(
    'requires complete real coverage even with proven admission for %s',
    (status) => {
      const coverage = summarizeScopeRetentionCoverage([
        { filePath: 'src/caller.ts', status: 'retained' },
        { filePath: 'src/refused.ts', status },
      ]);
      expect(coverage.complete).toBe(false);
      expect(planScopeRetentionReplay(input({ coverage }))).toEqual({
        kind: 'full-analysis-required',
        reason: 'coverage-incomplete',
      });
    },
  );

  it('replays the sorted unique union with real retained coverage and proven admission', () => {
    const inventory = [
      { filePath: 'src/z.ts', status: 'retained' },
      { filePath: 'src/a.ts', status: 'retained' },
      { filePath: 'src/z.ts', status: 'retained' },
    ];
    const coverage = summarizeScopeRetentionCoverage(inventory);
    expect(coverage.complete).toBe(true);
    expect(
      planScopeRetentionReplay(
        input({
          coverage,
          retainedFiles: inventory.map((entry) => entry.filePath),
          changedPaths: ['src/b.ts', 'src/a.ts', 'src/b.ts'],
        }),
      ),
    ).toEqual({ kind: 'replay', files: ['src/a.ts', 'src/b.ts', 'src/z.ts'] });
  });

  it.each([
    undefined,
    { version: 1 as const, languages: [], complete: false },
    { seedReady: false, status: 'complete' },
    { seedReady: true, status: 'candidate' },
  ])('requires complete coverage: %j', (coverage) => {
    expect(planScopeRetentionReplay(input({ coverage }))).toEqual({
      kind: 'full-analysis-required',
      reason: 'coverage-incomplete',
    });
  });

  it('accepts explicit seed-ready complete coverage', () => {
    expect(
      planScopeRetentionReplay(input({ coverage: { seedReady: true, status: 'complete' } })),
    ).toEqual({ kind: 'replay', files: ['src/callee.ts', 'src/caller.ts'] });
  });

  it('falls back when the unique replay set exceeds its limit', () => {
    expect(planScopeRetentionReplay(input({ limits: { maxReplayFiles: 1 } }))).toEqual({
      kind: 'full-analysis-required',
      reason: 'replay-too-large',
    });
    expect(planScopeRetentionReplay(input({ limits: { maxReplayFiles: 2 } })).kind).toBe('replay');
  });

  it.each([
    '',
    ' ',
    '/src/file.ts',
    '../file.ts',
    'src/../file.ts',
    'src\\file.ts',
    'src/\0file.ts',
    42,
  ])('refuses invalid paths in either list: %j', (filePath) => {
    for (const key of ['changedPaths', 'retainedFiles'] as const) {
      expect(
        planScopeRetentionReplay(
          input({ [key]: [filePath] } as Partial<ScopeRetentionReplayInput>),
        ),
      ).toEqual({ kind: 'refused', reason: 'invalid-input' });
    }
  });

  it.each([-1, 1.5, NaN, Infinity])('refuses an invalid limit: %s', (maxReplayFiles) => {
    expect(planScopeRetentionReplay(input({ limits: { maxReplayFiles } }))).toEqual({
      kind: 'refused',
      reason: 'invalid-input',
    });
  });

  it.each(['.', './src/a.ts', 'src//a.ts', 'src/./a.ts', 'src/a.ts/'])(
    'refuses noncanonical paths in either list: %j',
    (filePath) => {
      for (const key of ['changedPaths', 'retainedFiles'] as const) {
        expect(planScopeRetentionReplay(input({ [key]: [filePath] }))).toEqual({
          kind: 'refused',
          reason: 'invalid-input',
        });
      }
    },
  );

  it('preserves valid dot-containing file and directory names', () => {
    expect(
      planScopeRetentionReplay(
        input({
          changedPaths: ['src/.hidden.ts', 'src/a..ts'],
          retainedFiles: ['.config/file.ts', 'src/.../a.ts'],
        }),
      ),
    ).toEqual({
      kind: 'replay',
      files: ['.config/file.ts', 'src/.../a.ts', 'src/.hidden.ts', 'src/a..ts'],
    });
  });

  it('is deterministic under input permutation and does not mutate inputs', () => {
    const original = input({
      changedPaths: Object.freeze(['src/z.ts', 'src/a.ts']),
      retainedFiles: Object.freeze(['src/b.ts', 'src/a.ts']),
    });
    const before = JSON.stringify(original);
    expect(planScopeRetentionReplay(original)).toEqual(
      planScopeRetentionReplay(
        input({
          changedPaths: [...original.changedPaths].reverse(),
          retainedFiles: [...original.retainedFiles].reverse(),
        }),
      ),
    );
    expect(JSON.stringify(original)).toBe(before);
  });

  // These are planner obligations, not evidence that graph replacement executes replay.
  it('replays a retained caller with a body-only change exactly once', () => {
    expect(planScopeRetentionReplay(input({ changedPaths: ['src/caller.ts'] }))).toEqual({
      kind: 'replay',
      files: ['src/caller.ts'],
    });
  });

  it('keeps an unresolved caller when an added export could resolve its call', () => {
    expect(planScopeRetentionReplay(input())).toEqual({
      kind: 'replay',
      files: ['src/callee.ts', 'src/caller.ts'],
    });
  });

  it('keeps a caller when a removed export could invalidate its call', () => {
    expect(planScopeRetentionReplay(input())).toEqual({
      kind: 'replay',
      files: ['src/callee.ts', 'src/caller.ts'],
    });
  });

  it('keeps a caller when a renamed export could change call resolution', () => {
    expect(planScopeRetentionReplay(input())).toEqual({
      kind: 'replay',
      files: ['src/callee.ts', 'src/caller.ts'],
    });
  });
});
