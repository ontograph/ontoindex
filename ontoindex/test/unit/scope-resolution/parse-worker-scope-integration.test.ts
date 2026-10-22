/**
 * Unit tests for `extractParsedFile` — the parse-worker → ScopeExtractor
 * bridge (RFC #909 Ring 2 PKG #920).
 *
 * The goal is to pin three invariants:
 *
 *   1. When a provider does NOT implement `emitScopeCaptures`, the helper
 *      returns `undefined` silently. This is the state of every language
 *      today — `ParseWorkerResult.parsedFiles` stays empty and the legacy
 *      DAG continues unaffected.
 *   2. When a provider DOES implement the hook, the helper threads its
 *      output through `ScopeExtractor.extract` and returns a `ParsedFile`.
 *   3. Exceptions from either the hook or the extractor are caught
 *      locally. The helper returns `undefined` — scope-extraction
 *      failures must NEVER break legacy parsing on the same file.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import Parser, { type SyntaxNode } from 'tree-sitter';
import {
  SupportedLanguages,
  type Capture,
  type CaptureMatch,
  type ParsedFile,
} from 'ontoindex-shared';
import {
  extractParsedFile,
  extractParsedFileOutcome,
} from '../../../src/core/ingestion/scope-extractor-bridge.js';
import type { LanguageProvider } from '../../../src/core/ingestion/language-provider.js';
import * as languageProviders from '../../../src/core/ingestion/languages/index.js';
import { processParsing } from '../../../src/core/ingestion/parsing-processor.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createASTCache } from '../../../src/core/ingestion/ast-cache.js';
import { createResolutionContext } from '../../../src/core/ingestion/model/resolution-context.js';
import type { WorkerPool } from '../../../src/core/ingestion/workers/worker-pool.js';
import {
  createEmptyResult,
  type ParseWorkerResult,
} from '../../../src/core/ingestion/workers/parse-types.js';
import type { WorkerDispatchOptions } from '../../../src/core/ingestion/workers/worker-pool.js';

// ─── Capture helpers ────────────────────────────────────────────────────────

const cap = (
  name: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  text = '',
): Capture => ({ name, range: { startLine, startCol, endLine, endCol }, text });

const moduleScopeMatch = (): CaptureMatch => ({
  '@scope.module': cap('@scope.module', 1, 0, 100, 0),
});

describe('processParsing sequential scope artifacts', () => {
  const caches: ReturnType<typeof createASTCache>[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const cache of caches) cache.clear();
    caches.length = 0;
  });

  function setup() {
    const graph = createKnowledgeGraph();
    const symbols = createResolutionContext().model.symbols;
    const cache = createASTCache();
    caches.push(cache);
    return { graph, symbols, cache };
  }

  function scopeHook(hook: LanguageProvider['emitScopeCaptures']) {
    const getProvider = languageProviders.getProvider;
    vi.spyOn(languageProviders, 'getProvider').mockImplementation((language) => ({
      ...getProvider(language),
      emitScopeCaptures: hook,
    }));
  }

  function crashingWorkers() {
    const dispatch = vi.fn().mockRejectedValue(new Error('scope regression worker crash'));
    const pool: WorkerPool = {
      size: 1,
      isolation: 'thread',
      startupDurationMs: 0,
      workerStartupDurationsMs: [0],
      terminate: async () => {},
      dispatch,
    };
    return { pool, dispatch };
  }

  it.each(['sequential', 'worker fallback'] as const)(
    'delivers ordered artifacts while preserving legacy graph output in %s mode',
    async (mode) => {
      const parse = vi.spyOn(Parser.prototype, 'parse');
      const { graph, symbols, cache } = setup();
      const borrowedRoots: { path: string; text: string | undefined; cached: boolean }[] = [];
      scopeHook((_source, path, root) => {
        borrowedRoots.push({
          path,
          text: root?.text,
          cached: root !== undefined && root === cache.get(path)?.rootNode,
        });
        return [moduleScopeMatch()];
      });
      const files = [
        { path: 'z-last.ts', content: 'export function firstFunction() {}' },
        { path: 'a-first.ts', content: 'export function secondFunction() {}' },
      ];
      const workers = crashingWorkers();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();
      const onParseErrors = vi.fn();
      const onOutcomes = vi.fn();

      const result = await processParsing(
        graph,
        files,
        '/scope-test',
        symbols,
        cache,
        undefined,
        mode === 'worker fallback' ? workers.pool : undefined,
        undefined,
        undefined,
        'sequential',
        onParseErrors,
        onArtifacts,
        onOutcomes,
      );

      expect(result).toBeNull();
      expect(parse).toHaveBeenCalledTimes(files.length);
      expect(borrowedRoots).toEqual(
        files.map((file) => ({ path: file.path, text: file.content, cached: true })),
      );
      expect(onArtifacts).toHaveBeenCalledTimes(1);
      expect(
        onArtifacts.mock.calls[0]![0].map((file) => ({
          path: file.filePath,
          kinds: file.scopes.map((scope) => scope.kind),
        })),
      ).toEqual([
        { path: 'z-last.ts', kinds: ['Module'] },
        { path: 'a-first.ts', kinds: ['Module'] },
      ]);
      expect(onParseErrors).toHaveBeenCalledExactlyOnceWith([]);
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([
        { filePath: 'z-last.ts', status: 'success' },
        { filePath: 'a-first.ts', status: 'success' },
      ]);
      for (const name of ['firstFunction', 'secondFunction']) {
        expect(graph.nodes.some((node) => node.properties.name === name)).toBe(true);
        expect(symbols.lookupCallableByName(name)).not.toHaveLength(0);
      }
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'worker fallback' ? 1 : 0);
    },
  );

  it.each(['sequential', 'worker fallback'] as const)(
    'passes the live extracted Vue script root to the scope provider in %s mode',
    async (mode) => {
      const script = '\nexport function componentFunction() {}\n';
      const { graph, symbols, cache } = setup();
      const borrowedRoots: { text: string | undefined; cached: boolean }[] = [];
      const emit = vi.fn<NonNullable<LanguageProvider['emitScopeCaptures']>>(
        (_source, path, root) => {
          borrowedRoots.push({
            text: root?.text,
            cached: root !== undefined && root === cache.get(path)?.rootNode,
          });
          return [moduleScopeMatch()];
        },
      );
      scopeHook(emit);
      const workers = crashingWorkers();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();

      expect(
        await processParsing(
          graph,
          [
            {
              path: 'Component.vue',
              content: `<template><div /></template>\n<script setup lang="ts">${script}</script>`,
            },
          ],
          '/scope-test',
          symbols,
          cache,
          undefined,
          mode === 'worker fallback' ? workers.pool : undefined,
          undefined,
          undefined,
          'sequential',
          undefined,
          onArtifacts,
        ),
      ).toBeNull();

      expect(emit).toHaveBeenCalledExactlyOnceWith(
        script,
        'Component.vue',
        cache.get('Component.vue')!.rootNode,
      );
      const root = cache.get('Component.vue')!.rootNode;
      expect(borrowedRoots).toEqual([
        { text: script.slice(root.startIndex, root.endIndex), cached: true },
      ]);
      expect(onArtifacts.mock.calls[0]![0].map((file) => file.filePath)).toEqual(['Component.vue']);
      expect(symbols.lookupCallableByName('componentFunction')).not.toHaveLength(0);
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'worker fallback' ? 1 : 0);
    },
  );

  it.each(['absent', 'throwing'] as const)(
    'keeps legacy definitions and emits an empty artifact list when the hook is %s',
    async (hook) => {
      scopeHook(
        hook === 'absent'
          ? undefined
          : () => {
              throw new Error('scope hook failed');
            },
      );
      const { graph, symbols, cache } = setup();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();

      const result = await processParsing(
        graph,
        [{ path: 'legacy.ts', content: 'export function legacyFunction() {}' }],
        '/scope-test',
        symbols,
        cache,
        undefined,
        undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        onArtifacts,
      );

      expect(result).toBeNull();
      expect(onArtifacts).toHaveBeenCalledExactlyOnceWith([]);
      expect(graph.nodes.some((node) => node.properties.name === 'legacyFunction')).toBe(true);
      expect(symbols.lookupCallableByName('legacyFunction')).not.toHaveLength(0);
    },
  );

  it('accepts the original signature without an artifact callback', async () => {
    scopeHook(() => [moduleScopeMatch()]);
    const { graph, symbols, cache } = setup();
    const onProgress = vi.fn();

    expect(
      await processParsing(
        graph,
        [{ path: 'legacy.ts', content: 'export function originalSignature() {}' }],
        symbols,
        cache,
        onProgress,
      ),
    ).toBeNull();

    expect(onProgress).toHaveBeenCalledWith(1, 1, 'legacy.ts');
    expect(symbols.lookupCallableByName('originalSignature')).not.toHaveLength(0);
  });

  it.each(['sequential', 'worker fallback'] as const)(
    'reports ordered success, unsupported and failed attempts in %s mode',
    async (mode) => {
      const getProvider = languageProviders.getProvider;
      vi.spyOn(languageProviders, 'getProvider').mockImplementation((language) => ({
        ...getProvider(language),
        emitScopeCaptures:
          language === SupportedLanguages.JavaScript
            ? undefined
            : (_source, filePath) => {
                if (filePath === 'failed.ts') throw new Error('scope hook failed');
                if (filePath.endsWith('.cxx')) return [];
                return [moduleScopeMatch()];
              },
      }));
      const { graph, symbols, cache } = setup();
      const workers = crashingWorkers();
      const onOutcomes = vi.fn();
      const onArtifacts = vi.fn();

      const result = await processParsing(
        graph,
        [
          { path: 'z-success.ts', content: 'export function successful() {}' },
          { path: 'unsupported.js', content: 'export function unsupported() {}' },
          { path: 'failed.ts', content: 'export function failed() {}' },
          {
            path: 'sw/source/core/layout/pagechg.cxx',
            content: 'int nativeFunction() { return 1; }',
          },
          { path: 'skipped.txt', content: 'not a supported source file' },
        ],
        '/scope-test',
        symbols,
        cache,
        undefined,
        mode === 'worker fallback' ? workers.pool : undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        onArtifacts,
        onOutcomes,
      );

      expect(result).toBeNull();
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([
        { filePath: 'z-success.ts', status: 'success' },
        { filePath: 'unsupported.js', status: 'unsupported', reason: 'missing-scope-hook' },
        { filePath: 'failed.ts', status: 'failed', reason: 'scope-extraction-error' },
        {
          filePath: 'sw/source/core/layout/pagechg.cxx',
          status: 'failed',
          reason: 'missing-module-scope',
        },
      ]);
      expect(onArtifacts.mock.calls[0]![0].map((file: ParsedFile) => file.filePath)).toEqual([
        'z-success.ts',
      ]);
      for (const name of ['successful', 'unsupported', 'failed']) {
        expect(symbols.lookupCallableByName(name)).not.toHaveLength(0);
      }
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'worker fallback' ? 1 : 0);
    },
  );

  it.each(['streamed', 'final', 'legacy'] as const)(
    'retains %s worker outcomes after the worker result is cleared',
    async (mode) => {
      const { graph, symbols, cache } = setup();
      const workerResult = createEmptyResult();
      const expected = [
        { filePath: 'z.ts', status: 'success' } as const,
        { filePath: 'a.ts', status: 'failed', reason: 'scope-extraction-error' } as const,
      ];
      workerResult.scopeExtractionOutcomes = expected.slice();
      if (mode === 'legacy') delete workerResult.scopeExtractionOutcomes;
      const workers = crashingWorkers();
      workers.dispatch.mockImplementation(async (...args: unknown[]) => {
        if (mode !== 'streamed') return [workerResult];
        const options = args[4] as WorkerDispatchOptions<ParseWorkerResult>;
        options.onResultPart!(workerResult, {
          workerIndex: 0,
          workerChunkSize: 2,
          workerIsolation: 'thread',
        });
        return [createEmptyResult()];
      });
      const onOutcomes = vi.fn();

      const result = await processParsing(
        graph,
        [{ path: 'z.ts', content: 'export const z = 1;' }],
        '/scope-test',
        symbols,
        cache,
        undefined,
        workers.pool,
        undefined,
        undefined,
        'sequential',
        undefined,
        undefined,
        onOutcomes,
      );

      expect(result).not.toBeNull();
      expect(result!.scopeExtractionOutcomes).toEqual(mode === 'legacy' ? [] : expected);
      expect(result!.parsedFiles).toEqual([]);
      expect(workerResult.scopeExtractionOutcomes).toEqual(mode === 'legacy' ? undefined : []);
      expect(workers.dispatch).toHaveBeenCalledTimes(1);
      expect(onOutcomes).not.toHaveBeenCalled();
    },
  );

  it('propagates scope outcome callback failures to the caller', async () => {
    scopeHook(() => [moduleScopeMatch()]);
    const { graph, symbols, cache } = setup();
    const failure = new Error('scope outcome sink failed');

    await expect(
      processParsing(
        graph,
        [{ path: 'callback.ts', content: 'export function callbackFunction() {}' }],
        '/scope-test',
        symbols,
        cache,
        undefined,
        undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        undefined,
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
  });

  it('propagates artifact callback failures to the caller', async () => {
    scopeHook(() => [moduleScopeMatch()]);
    const { graph, symbols, cache } = setup();
    const failure = new Error('artifact sink failed');

    await expect(
      processParsing(
        graph,
        [{ path: 'callback.ts', content: 'export function callbackFunction() {}' }],
        '/scope-test',
        symbols,
        cache,
        undefined,
        undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
  });
});

/**
 * Build a `LanguageProvider` whose shape is only as narrow as
 * `extractParsedFile` reads. Tests cast to the full provider type since
 * `extractParsedFile` is typed against `LanguageProvider` (not the narrow
 * `ScopeExtractorHooks`); the real worker always has a full provider.
 */
function fakeProvider(
  hooks: Partial<
    Pick<
      LanguageProvider,
      'emitScopeCaptures' | 'shouldCreateScope' | 'resolveScopeKind' | 'interpretExports'
    >
  >,
): LanguageProvider {
  return hooks as unknown as LanguageProvider;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('extractParsedFileOutcome', () => {
  it('includes explicit exports in a successful bridge artifact', () => {
    const provider = fakeProvider({
      emitScopeCaptures: () => [
        moduleScopeMatch(),
        {
          '@declaration.function': cap('@declaration.function', 2, 0, 2, 6),
          '@declaration.name': cap('@declaration.name', 2, 0, 2, 6, 'render'),
        },
      ],
      interpretExports: (_matches, context) => new Map([['default', context.localDefs[0]!.nodeId]]),
    });
    const outcome = extractParsedFileOutcome(provider, 'source text', 'a.ts');

    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') throw new Error('Expected a successful extraction');
    expect(outcome.parsedFile.exports).toEqual(
      new Map([['default', outcome.parsedFile.localDefs[0]!.nodeId]]),
    );
    expect(extractParsedFile(provider, 'source text', 'a.ts')).toEqual(outcome.parsedFile);
  });

  it.each(['throwing', 'invalid result'] as const)(
    'preserves failure outcomes and legacy warnings for an export hook with %s',
    (mode) => {
      const provider = fakeProvider({
        emitScopeCaptures: () => [moduleScopeMatch()],
        interpretExports: () => {
          if (mode === 'throwing') throw new Error('export hook failed');
          return new Map([['default', 'foreign-definition']]);
        },
      });
      const onWarn = vi.fn();
      const legacyWarn = vi.fn();

      expect(extractParsedFileOutcome(provider, 'src', 'a.ts', onWarn)).toEqual({
        status: 'failed',
        reason: 'scope-extraction-error',
      });
      expect(extractParsedFile(provider, 'src', 'a.ts', legacyWarn)).toBeUndefined();
      expect(onWarn.mock.calls).toEqual(legacyWarn.mock.calls);
      expect(onWarn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('a.ts'));
      if (mode === 'throwing') {
        expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('export hook failed'));
      }
    },
  );

  it.each([
    ['outcome helper', extractParsedFileOutcome],
    ['legacy wrapper', extractParsedFile],
  ] as const)('forwards the exact borrowed root through the %s', (_name, extract) => {
    const root = { text: 'source text' } as SyntaxNode;
    const emit = vi.fn<NonNullable<LanguageProvider['emitScopeCaptures']>>(() => [
      moduleScopeMatch(),
    ]);
    const provider = fakeProvider({ emitScopeCaptures: emit });
    const onWarn = vi.fn();

    expect(extract(provider, 'source text', 'src/file.ts', onWarn, root)).toBeDefined();

    expect(emit).toHaveBeenCalledExactlyOnceWith('source text', 'src/file.ts', root);
    expect(emit.mock.calls[0]![2]).toBe(root);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('returns the extracted artifact after invoking the provider exactly once', () => {
    const emit = vi.fn(() => [moduleScopeMatch()]);
    const provider = fakeProvider({ emitScopeCaptures: emit });
    const onWarn = vi.fn();

    const outcome = extractParsedFileOutcome(provider, 'source text', 'src/file.ts', onWarn);

    expect(emit).toHaveBeenCalledExactlyOnceWith('source text', 'src/file.ts');
    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') throw new Error('Expected a successful extraction');
    expect(outcome.parsedFile.filePath).toBe('src/file.ts');
    expect(outcome.parsedFile.scopes.map((scope) => scope.kind)).toEqual(['Module']);
    expect(onWarn).not.toHaveBeenCalled();
    expect(extractParsedFile(provider, 'source text', 'src/file.ts', onWarn)).toEqual(
      outcome.parsedFile,
    );
  });

  it.each([
    {
      name: 'missing hook',
      hook: undefined,
      path: 'a.ts',
      expected: { status: 'unsupported', reason: 'missing-scope-hook' },
      warning: undefined,
    },
    {
      name: 'throwing hook',
      hook: () => {
        throw new Error('provider boom');
      },
      path: 'a.ts',
      expected: { status: 'failed', reason: 'scope-extraction-error' },
      warning: 'provider boom',
    },
    {
      name: 'overlapping captures',
      hook: () => [
        moduleScopeMatch(),
        { '@scope.function': cap('@scope.function', 10, 0, 20, 0) },
        { '@scope.function': cap('@scope.function', 15, 0, 25, 0) },
      ],
      path: 'a.ts',
      expected: { status: 'failed', reason: 'scope-extraction-error' },
      warning: 'overlap',
    },
    {
      name: 'unexpected missing module',
      hook: () => [],
      path: 'a.ts',
      expected: { status: 'failed', reason: 'scope-extraction-error' },
      warning: 'ScopeExtractor: no Module scope found',
    },
    ...['sw/source/core/layout/pagechg.cxx', 'include/sfx2/objsh.hxx'].map((path) => ({
      name: `expected missing module in ${path}`,
      hook: () => [],
      path,
      expected: { status: 'failed', reason: 'missing-module-scope' },
      warning: undefined,
    })),
  ])(
    'classifies $name and preserves legacy return values and warnings',
    ({ hook, path, expected, warning }) => {
      const provider = fakeProvider({ emitScopeCaptures: hook });
      const onWarn = vi.fn();
      const legacyWarn = vi.fn();

      expect(extractParsedFileOutcome(provider, 'src', path, onWarn)).toEqual(expected);
      expect(extractParsedFile(provider, 'src', path, legacyWarn)).toBeUndefined();
      expect(onWarn.mock.calls).toEqual(legacyWarn.mock.calls);
      if (warning === undefined) {
        expect(onWarn).not.toHaveBeenCalled();
      } else {
        expect(onWarn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(warning));
        expect(onWarn).toHaveBeenCalledWith(expect.stringContaining(path));
      }
    },
  );

  it.each([
    ['outcome helper', extractParsedFileOutcome],
    ['legacy wrapper', extractParsedFile],
  ] as const)('propagates warning callback failures from the %s', (_name, extract) => {
    const provider = fakeProvider({
      emitScopeCaptures: () => {
        throw new Error('provider boom');
      },
    });
    const failure = new Error('warning sink failed');

    expect(() =>
      extract(provider, 'src', 'a.ts', () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});

describe('extractParsedFile', () => {
  describe('provider has NOT migrated (no emitScopeCaptures)', () => {
    it('returns undefined — silent no-op for legacy languages', () => {
      const provider = fakeProvider({}); // no hook
      const result = extractParsedFile(provider, 'source text', 'src/file.ts');
      expect(result).toBeUndefined();
    });

    it('never calls the scope extractor when the hook is absent — cannot throw', () => {
      // If the extractor was wrongly invoked, it would complain about the
      // missing Module scope for empty captures. This test proves the
      // short-circuit actually fires.
      const provider = fakeProvider({});
      expect(() => extractParsedFile(provider, '', 'x.ts')).not.toThrow();
    });
  });

  describe('provider HAS migrated', () => {
    it('threads emitScopeCaptures output through ScopeExtractor', () => {
      const provider = fakeProvider({
        emitScopeCaptures: () => [moduleScopeMatch()],
      });
      const result = extractParsedFile(provider, 'source text', 'src/file.ts');
      expect(result).toBeDefined();
      expect(result!.filePath).toBe('src/file.ts');
      expect(result!.scopes).toHaveLength(1);
      expect(result!.scopes[0]!.kind).toBe('Module');
    });

    it('forwards the correct arguments to emitScopeCaptures', () => {
      let seenText: string | undefined;
      let seenPath: string | undefined;
      const provider = fakeProvider({
        emitScopeCaptures: (text, path) => {
          seenText = text;
          seenPath = path;
          return [moduleScopeMatch()];
        },
      });
      extractParsedFile(provider, 'the real text', 'deep/path/file.ts');
      expect(seenText).toBe('the real text');
      expect(seenPath).toBe('deep/path/file.ts');
    });

    it('honors provider hooks beyond emitScopeCaptures (shouldCreateScope)', () => {
      // A Block scope the provider declines to create — the resulting
      // ParsedFile should have only the Module scope, not the Block.
      const provider = fakeProvider({
        emitScopeCaptures: () => [
          moduleScopeMatch(),
          { '@scope.block': cap('@scope.block', 10, 0, 20, 0) },
        ],
        shouldCreateScope: (match) => match['@scope.block'] === undefined,
      });
      const result = extractParsedFile(provider, 'src', 'a.ts');
      expect(result!.scopes).toHaveLength(1);
      expect(result!.scopes[0]!.kind).toBe('Module');
    });
  });

  describe('error resilience — never breaks legacy parsing', () => {
    it('returns undefined when emitScopeCaptures throws', () => {
      const provider = fakeProvider({
        emitScopeCaptures: () => {
          throw new Error('provider boom');
        },
      });
      const result = extractParsedFile(provider, 'src', 'a.ts');
      expect(result).toBeUndefined();
    });

    it('routes errors through the onWarn callback when provided', () => {
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => {
          throw new Error('provider boom');
        },
      });
      const result = extractParsedFile(provider, 'src', 'path/to/file.ts', (msg) => {
        warnings.push(msg);
      });
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('path/to/file.ts');
      expect(warnings[0]).toContain('provider boom');
    });

    it('warns when ScopeExtractor throws an unexpected missing Module scope', () => {
      // Emits no scope captures, so the extractor reaches the missing
      // Module invariant. Legacy parsing on the same file continues
      // unaffected by this failure.
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => [],
      });
      const result = extractParsedFile(provider, 'src', 'a.ts', (msg) => {
        warnings.push(msg);
      });
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('ScopeExtractor: no Module scope found');
    });

    it('suppresses expected missing Module scope warnings for LO-style .cxx files', () => {
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => [],
      });
      const result = extractParsedFile(
        provider,
        'namespace sw { void layout() {} }',
        'sw/source/core/layout/pagechg.cxx',
        (msg) => {
          warnings.push(msg);
        },
      );
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });

    it('suppresses expected missing Module scope warnings for LO-style .hxx files', () => {
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => [],
      });
      const result = extractParsedFile(
        provider,
        '#pragma once\nclass SfxObjectShell;',
        'include/sfx2/objsh.hxx',
        (msg) => {
          warnings.push(msg);
        },
      );
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });

    it('returns undefined when ScopeExtractor throws on malformed captures (overlap)', () => {
      // Siblings with overlapping ranges trip the ScopeTreeInvariantError
      // from #912. The helper catches it and returns undefined.
      const provider = fakeProvider({
        emitScopeCaptures: () => [
          moduleScopeMatch(),
          { '@scope.function': cap('@scope.function', 10, 0, 20, 0) },
          { '@scope.function': cap('@scope.function', 15, 0, 25, 0) }, // overlap
        ],
      });
      const result = extractParsedFile(provider, 'src', 'a.ts');
      expect(result).toBeUndefined();
    });

    it('still warns for unexpected scope errors in .cxx files', () => {
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => [
          moduleScopeMatch(),
          { '@scope.function': cap('@scope.function', 10, 0, 20, 0) },
          { '@scope.function': cap('@scope.function', 15, 0, 25, 0) }, // overlap
        ],
      });
      const result = extractParsedFile(
        provider,
        'src',
        'sw/source/core/layout/pagechg.cxx',
        (msg) => {
          warnings.push(msg);
        },
      );
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('overlap');
    });
  });
});
