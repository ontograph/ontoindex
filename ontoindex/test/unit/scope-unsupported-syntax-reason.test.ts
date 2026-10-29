import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import type { LanguageProvider } from '../../src/core/ingestion/language-provider.js';
import { extractParsedFileOutcome } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { ScopeUnsupportedSyntaxError } from '../../src/core/ingestion/scope-unsupported-syntax.js';
import { ScopeRetentionStage } from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';

describe('unsupported scope syntax reasons', () => {
  it('preserves the typed refusal and message without node evidence', () => {
    const error = new ScopeUnsupportedSyntaxError('unsupported declaration');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ScopeUnsupportedSyntaxError);
    expect(error.name).toBe('ScopeUnsupportedSyntaxError');
    expect(error.message).toBe('unsupported declaration');
  });

  it.each([
    { type: 'generic_type', row: 0, column: 0 },
    { type: '_Node09', row: 3, column: 17 },
    { type: 'a'.repeat(64), row: Number.MAX_SAFE_INTEGER - 1, column: 0 },
  ])('adds bounded one-based evidence for $type at $row:$column', ({ type, row, column }) => {
    const node = {
      type,
      startPosition: { row, column },
      get text(): string {
        throw new Error('source text must not be read');
      },
    };
    const error = new ScopeUnsupportedSyntaxError('unsupported declaration', node);
    expect(error).toBeInstanceOf(ScopeUnsupportedSyntaxError);
    expect(error.message).toBe(
      `unsupported declaration [node=${type} at=${row + 1}:${column + 1}]`,
    );
  });

  it.each(['', '9node', 'generic-type', 'node kind', 'node\n', 'a'.repeat(65), '秘密'])(
    'omits invalid node kind %j without leaking source text',
    (type) => {
      const error = new ScopeUnsupportedSyntaxError('unsupported declaration', {
        type,
        startPosition: { row: 0, column: 0 },
      });
      expect(error.message).toBe('unsupported declaration');
    },
  );

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])('omits evidence for unsafe row or column %s', (position) => {
    for (const startPosition of [
      { row: position, column: 0 },
      { row: 0, column: position },
    ]) {
      const error = new ScopeUnsupportedSyntaxError('unsupported declaration', {
        type: 'generic_type',
        startPosition,
      });
      expect(error.message).toBe('unsupported declaration');
    }
  });

  it('distinguishes unsupported TypeScript accessors from supported functions', async () => {
    const provider = getProvider(SupportedLanguages.TypeScript);
    const parser = await createParserForLanguage(provider.id, 'a.ts');
    const warning = vi.fn();
    const unsupported = 'class Member { get value() { return 1; } }';
    const unsupportedTree = parser.parse(unsupported);
    expect(unsupportedTree.rootNode.hasError).toBe(false);
    expect(
      extractParsedFileOutcome(provider, unsupported, 'a.ts', warning, unsupportedTree.rootNode),
    ).toEqual({ status: 'failed', reason: 'unsupported-syntax' });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'scope extraction failed for a.ts: TS/JS captures require the supported module subset [node=method_definition at=1:16]',
    );

    const supported = 'export function ok() {}';
    const supportedTree = parser.parse(supported);
    const successWarning = vi.fn();
    expect(
      extractParsedFileOutcome(provider, supported, 'a.ts', successWarning, supportedTree.rootNode)
        .status,
    ).toBe('success');
    expect(successWarning).not.toHaveBeenCalled();
  });

  it.each([
    { error: new Error('boom'), reason: 'scope-extraction-error' },
    { error: new ScopeUnsupportedSyntaxError('x'), reason: 'unsupported-syntax' },
  ] as const)('preserves warnings while classifying $reason', ({ error, reason }) => {
    const provider = {
      emitScopeCaptures() {
        throw error;
      },
    } as unknown as LanguageProvider;
    const warning = vi.fn();

    expect(extractParsedFileOutcome(provider, '', 'a.ts', warning)).toEqual({
      status: 'failed',
      reason,
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      `scope extraction failed for a.ts: ${error.message}`,
    );
  });

  it('does not warn per file for unsupported Rust syntax', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warning = vi.fn();
    const provider = {
      emitScopeCaptures() {
        throw new ScopeUnsupportedSyntaxError('unsupported declaration');
      },
    } as unknown as LanguageProvider;
    try {
      for (const onWarn of [warning, undefined]) {
        expect(extractParsedFileOutcome(provider, '', 'src/lib.rs', onWarn)).toEqual({
          status: 'failed',
          reason: 'unsupported-syntax',
        });
      }
      expect(warning).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['unsupported-syntax', 'scope-extraction-error'] as const)(
    'retains failed inventory and distinguishes %s',
    async (reason) => {
      const stage = new ScopeRetentionStage({
        deadline: Date.now() + 30_000,
        artifactAllowance: { remainingBytes: 1024 * 1024 },
      });
      try {
        stage.reconcile(['a.ts']);
        stage.recordOutcomes([{ filePath: 'a.ts', status: 'failed', reason }]);
        expect(stage.reasons).toContain('failed');
        if (reason === 'unsupported-syntax') {
          expect(stage.reasons).toContain('unsupported-syntax');
        } else {
          expect(stage.reasons).not.toContain('unsupported-syntax');
        }
        stage.reconcile(['a.ts']);
        await stage.flush();
        expect(stage.status).toBe('incomplete');
        expect(stage.inventory).toEqual([
          reason === 'unsupported-syntax'
            ? { filePath: 'a.ts', status: 'failed', reason }
            : { filePath: 'a.ts', status: 'failed' },
        ]);
      } finally {
        await stage.dispose();
      }
    },
  );
});
