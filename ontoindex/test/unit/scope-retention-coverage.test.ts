import { describe, expect, it } from 'vitest';
import { summarizeScopeRetentionCoverage } from '../../src/core/ingestion/pipeline-phases/scope-retention-coverage.js';

describe('scope retention coverage', () => {
  it('groups languages, counts refusal reasons, and accounts for every inventory entry deterministically', () => {
    const inventory = [
      { filePath: 'unknown.xyz', status: 'missing-outcome' },
      { filePath: 'one.ts', status: 'retained' },
      { filePath: 'two.ts', status: 'skipped' },
      { filePath: 'one.py', status: 'unsupported', reason: 'unsupported-syntax' },
      { filePath: 'two.py', status: 'failed', reason: 'unsupported-syntax' },
      { filePath: 'three.py', status: 'failed' },
      { filePath: 'four.py', status: 'invalid-outcome' },
      { filePath: 'five.py', status: 'unsupported' },
      { filePath: 'missing.ts', status: 'missing-artifact' },
      { filePath: 'future.ts', status: 'future-status' },
    ];
    const coverage = summarizeScopeRetentionCoverage(inventory);
    expect(coverage).toEqual({
      version: 1,
      languages: [
        {
          language: 'python',
          files: 5,
          retained: 0,
          skipped: 0,
          refused: 5,
          unaccounted: 0,
          unparsed: 0,
          refusalReasons: [
            { reason: 'failed', count: 1 },
            { reason: 'invalid-outcome', count: 1 },
            { reason: 'unsupported', count: 1 },
            { reason: 'unsupported-syntax', count: 2 },
          ],
        },
        {
          language: 'typescript',
          files: 4,
          retained: 1,
          skipped: 1,
          refused: 0,
          unaccounted: 2,
          unparsed: 0,
          refusalReasons: [],
        },
        {
          language: 'unknown',
          files: 1,
          retained: 0,
          skipped: 0,
          refused: 0,
          unaccounted: 0,
          unparsed: 1,
          refusalReasons: [],
        },
      ],
      complete: false,
    });
    expect(summarizeScopeRetentionCoverage([...inventory].reverse())).toEqual(coverage);
    for (const bucket of coverage.languages) {
      expect(bucket.files).toBe(
        bucket.retained + bucket.skipped + bucket.refused + bucket.unaccounted + bucket.unparsed,
      );
      expect(bucket.refusalReasons.reduce((sum, entry) => sum + entry.count, 0)).toBe(
        bucket.refused,
      );
    }
  });

  it('does not call an empty inventory complete', () => {
    expect(summarizeScopeRetentionCoverage([])).toEqual({
      version: 1,
      languages: [],
      complete: false,
    });
  });

  it('counts missing outcomes for unknown languages as unparsed without blocking completeness', () => {
    expect(
      summarizeScopeRetentionCoverage([
        { filePath: 'a.ts', status: 'retained' },
        { filePath: 'README.md', status: 'missing-outcome' },
      ]),
    ).toEqual({
      version: 1,
      languages: [
        {
          language: 'typescript',
          files: 1,
          retained: 1,
          skipped: 0,
          refused: 0,
          unaccounted: 0,
          unparsed: 0,
          refusalReasons: [],
        },
        {
          language: 'unknown',
          files: 1,
          retained: 0,
          skipped: 0,
          refused: 0,
          unaccounted: 0,
          unparsed: 1,
          refusalReasons: [],
        },
      ],
      complete: true,
    });
  });

  it('keeps missing outcomes for known languages unaccounted and incomplete', () => {
    expect(
      summarizeScopeRetentionCoverage([{ filePath: 'a.ts', status: 'missing-outcome' }]),
    ).toEqual({
      version: 1,
      languages: [
        {
          language: 'typescript',
          files: 1,
          retained: 0,
          skipped: 0,
          refused: 0,
          unaccounted: 1,
          unparsed: 0,
          refusalReasons: [],
        },
      ],
      complete: false,
    });
  });

  it('keeps failed unknown-language files refused and incomplete', () => {
    expect(summarizeScopeRetentionCoverage([{ filePath: 'image.png', status: 'failed' }])).toEqual({
      version: 1,
      languages: [
        {
          language: 'unknown',
          files: 1,
          retained: 0,
          skipped: 0,
          refused: 1,
          unaccounted: 0,
          unparsed: 0,
          refusalReasons: [{ reason: 'failed', count: 1 }],
        },
      ],
      complete: false,
    });
  });

  it('calls nonempty retained and skipped inventories complete, including unknown languages', () => {
    expect(
      summarizeScopeRetentionCoverage([
        { filePath: 'file.ts', status: 'retained' },
        { filePath: 'file.py', status: 'skipped' },
        { filePath: 'file.xyz', status: 'skipped' },
      ]).complete,
    ).toBe(true);
  });

  it.each([
    'failed',
    'unsupported',
    'invalid-outcome',
    'missing-artifact',
    'missing-outcome',
    'future-status',
  ])('does not call a nonempty inventory complete for %s', (status) => {
    expect(summarizeScopeRetentionCoverage([{ filePath: 'file.ts', status }]).complete).toBe(false);
  });
});
