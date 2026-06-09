import { describe, expect, it } from 'vitest';
import {
  boundAnalyzerInputMetadata,
  createAnalyzerTimingRecord,
  decideAnalyzerBudget,
  decideScopedPrecisionPolicy,
} from '../../src/core/ingestion/performance/index.js';

describe('analyzer budget contract', () => {
  it('skips optional analyzers by default', () => {
    const decision = decideAnalyzerBudget();

    expect(decision).toEqual({
      allowed: false,
      reason: 'not-enabled',
      input: {
        fileCount: undefined,
        byteCount: undefined,
        candidateCount: undefined,
        languageCount: undefined,
        samplePaths: [],
        samplePathsTruncated: false,
      },
    });
  });

  it('allows explicitly enabled analyzer work within budget', () => {
    const decision = decideAnalyzerBudget(
      { enabled: true, maxFiles: 3, maxBytes: 1_000, maxCandidates: 5 },
      { fileCount: 2, byteCount: 500, candidateCount: 4, languageCount: 1 },
    );

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
    expect(decision.input.fileCount).toBe(2);
  });

  it('hard-disables analyzer work even when explicitly enabled', () => {
    const decision = decideAnalyzerBudget({ hardDisabled: true, enabled: true });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('hard-disabled');
  });

  it('skips analyzer work when bounded input exceeds limits', () => {
    expect(decideAnalyzerBudget({ enabled: true, maxFiles: 1 }, { fileCount: 2 }).reason).toBe(
      'file-limit',
    );
    expect(decideAnalyzerBudget({ enabled: true, maxBytes: 99 }, { byteCount: 100 }).reason).toBe(
      'byte-limit',
    );
    expect(
      decideAnalyzerBudget({ enabled: true, maxCandidates: 1 }, { candidateCount: 2 }).reason,
    ).toBe('candidate-limit');
  });

  it('bounds input path samples and numeric metadata', () => {
    const metadata = boundAnalyzerInputMetadata(
      {
        fileCount: 3.9,
        byteCount: -1,
        candidateCount: Number.POSITIVE_INFINITY,
        languageCount: 2,
        samplePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      },
      2,
    );

    expect(metadata).toEqual({
      fileCount: 3,
      byteCount: undefined,
      candidateCount: undefined,
      languageCount: 2,
      samplePaths: ['src/a.ts', 'src/b.ts'],
      samplePathsTruncated: true,
    });
  });
});

describe('analyzer timing record', () => {
  it('creates a serializable skipped timing record with bounded input metadata', () => {
    const record = createAnalyzerTimingRecord({
      analyzerId: 'ts-type-aware',
      status: 'skipped',
      skippedReason: 'not-enabled',
      startedAt: '2026-05-13T00:00:00.000Z',
      finishedAt: '2026-05-13T00:00:00.125Z',
      input: {
        fileCount: 3,
        samplePaths: ['a.ts', 'b.ts', 'c.ts'],
      },
      maxSamplePaths: 2,
    });

    expect(record).toEqual({
      analyzerId: 'ts-type-aware',
      status: 'skipped',
      skippedReason: 'not-enabled',
      startedAt: '2026-05-13T00:00:00.000Z',
      finishedAt: '2026-05-13T00:00:00.125Z',
      durationMs: 125,
      input: {
        fileCount: 3,
        samplePaths: ['a.ts', 'b.ts'],
        samplePathsTruncated: true,
      },
    });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('requires skipped records to include a skipped reason', () => {
    expect(() =>
      createAnalyzerTimingRecord({
        analyzerId: 'codeql',
        status: 'skipped',
        startedAt: '2026-05-13T00:00:00.000Z',
        finishedAt: '2026-05-13T00:00:00.000Z',
      }),
    ).toThrow('Analyzer timing record requires skippedReason when status is skipped');
  });

  it('rejects negative durations', () => {
    expect(() =>
      createAnalyzerTimingRecord({
        analyzerId: 'ts-type-aware',
        status: 'completed',
        startedAt: '2026-05-13T00:00:01.000Z',
        finishedAt: '2026-05-13T00:00:00.000Z',
      }),
    ).toThrow('Analyzer timing record requires finishedAt to be after startedAt');
  });
});

describe('scoped precision policy', () => {
  it('denies precision engines by default with an empty scope', () => {
    const decision = decideScopedPrecisionPolicy();

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('not-enabled');
    expect(decision.scope).toEqual({
      engineId: '',
      engineKind: 'external-analyzer',
      files: [],
      languages: [],
      purposes: [],
      input: {
        fileCount: undefined,
        byteCount: undefined,
        candidateCount: undefined,
        languageCount: undefined,
        samplePaths: [],
        samplePathsTruncated: false,
      },
    });
  });

  it('allows explicitly enabled precision work with declared file, language, and purpose scope', () => {
    const decision = decideScopedPrecisionPolicy(
      {
        enabled: true,
        allowedLanguages: ['typescript'],
        allowedPurposes: ['call-resolution'],
        maxPrecisionFiles: 2,
        maxPrecisionLanguages: 1,
        maxPrecisionPurposes: 1,
      },
      {
        engineId: 'fast-ts-rule',
        engineKind: 'tree-sitter-rule',
        files: [' src/a.ts ', 'src/a.ts', 'src/b.ts'],
        languages: ['typescript'],
        purposes: ['call-resolution'],
      },
    );

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
    expect(decision.scope).toMatchObject({
      engineId: 'fast-ts-rule',
      engineKind: 'tree-sitter-rule',
      files: ['src/a.ts', 'src/b.ts'],
      languages: ['typescript'],
      purposes: ['call-resolution'],
    });
  });

  it('requires engine id plus non-empty file, language, and purpose scope before running', () => {
    for (const declaration of [
      {
        engineId: '',
        files: ['src/a.ts'],
        languages: ['typescript'],
        purposes: ['call-resolution'],
      },
      {
        engineId: 'missing-file',
        files: [],
        languages: ['typescript'],
        purposes: ['call-resolution'],
      },
      {
        engineId: 'missing-language',
        files: ['src/a.ts'],
        languages: [],
        purposes: ['call-resolution'],
      },
      { engineId: 'missing-purpose', files: ['src/a.ts'], languages: ['typescript'], purposes: [] },
    ]) {
      const decision = decideScopedPrecisionPolicy(
        { enabled: true },
        {
          ...declaration,
          engineKind: 'static-registry',
        },
      );

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('scope-empty');
    }
  });

  it('denies forbidden precision engine kinds even when explicitly enabled', () => {
    for (const engineKind of [
      'typescript-compiler-api',
      'lsp',
      'codeql',
      'joern',
      'daemon',
      'external-analyzer',
    ] as const) {
      const decision = decideScopedPrecisionPolicy(
        { enabled: true },
        {
          engineId: engineKind,
          engineKind,
          files: ['src/a.ts'],
          languages: ['typescript'],
          purposes: ['call-resolution'],
        },
      );

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('forbidden-engine');
    }
  });

  it('applies language, purpose, and scope-size limits independently', () => {
    expect(
      decideScopedPrecisionPolicy(
        { enabled: true, allowedLanguages: ['typescript'] },
        {
          engineId: 'lang',
          engineKind: 'tree-sitter-rule',
          files: ['src/a.py'],
          languages: ['python'],
          purposes: ['call-resolution'],
        },
      ).reason,
    ).toBe('language-limit');

    expect(
      decideScopedPrecisionPolicy(
        { enabled: true, allowedPurposes: ['call-resolution'] },
        {
          engineId: 'purpose',
          engineKind: 'tree-sitter-rule',
          files: ['src/a.ts'],
          languages: ['typescript'],
          purposes: ['dataflow'],
        },
      ).reason,
    ).toBe('purpose-limit');

    expect(
      decideScopedPrecisionPolicy(
        { enabled: true, maxPrecisionFiles: 1 },
        {
          engineId: 'files',
          engineKind: 'tree-sitter-rule',
          files: ['src/a.ts', 'src/b.ts'],
          languages: ['typescript'],
          purposes: ['call-resolution'],
        },
      ).reason,
    ).toBe('file-limit');
  });

  it('denies unknown precision purposes from the closed purpose set', () => {
    const decision = decideScopedPrecisionPolicy(
      { enabled: true },
      {
        engineId: 'unknown-purpose',
        engineKind: 'tree-sitter-rule',
        files: ['src/a.ts'],
        languages: ['typescript'],
        purposes: ['quality'],
      },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('purpose-limit');
  });

  it('strips absolute file paths from scoped precision declarations', () => {
    const decision = decideScopedPrecisionPolicy(
      { enabled: true },
      {
        engineId: 'absolute-path',
        engineKind: 'tree-sitter-rule',
        files: ['/repo/src/a.ts', 'C:\\repo\\src\\b.ts'],
        languages: ['typescript'],
        purposes: ['call-resolution'],
      },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('scope-empty');
    expect(decision.scope.files).toEqual([]);
  });
});
