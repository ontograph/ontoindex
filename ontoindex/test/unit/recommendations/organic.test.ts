import { describe, expect, it } from 'vitest';

import {
  emitOrganicRecommendation,
  validateOrganicRecommendation,
} from '../../../src/core/recommendations/organic.js';

const callableToolNames = ['gn_help', 'gn_test_gap', 'gn_verify_diff'];

describe('organic recommendations', () => {
  it('rejects recommendations without evidence ids', () => {
    const result = validateOrganicRecommendation(
      {
        id: 'rec-1',
        action: 'review-test-gap',
        target: { kind: 'symbol', name: 'parseToken' },
        reason: 'parseToken is missing coverage in tg-1.',
        confidence: 'medium',
        evidenceIds: [],
        evidenceClasses: ['graph_evidence'],
        nextTools: ['gn_test_gap'],
      },
      { callableToolNames },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'evidenceIds',
        }),
      ]),
    );
  });

  it('rejects recommendations without a concrete target', () => {
    const result = validateOrganicRecommendation(
      {
        id: 'rec-2',
        action: 'review-test-gap',
        target: { kind: 'symbol', name: '   ' },
        reason: 'tg-1 shows parseToken has no linked test coverage.',
        confidence: 'medium',
        evidenceIds: ['tg-1'],
        evidenceClasses: ['graph_evidence'],
        nextTools: ['gn_test_gap'],
      },
      { callableToolNames },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'target.name',
        }),
      ]),
    );
  });

  it('rejects non-callable next tools unless they are explicit non-tool actions', () => {
    const invalid = validateOrganicRecommendation(
      {
        id: 'rec-3',
        action: 'manual-review',
        target: { kind: 'file', name: 'src/core/review.ts', filePath: 'src/core/review.ts' },
        reason: 'src/core/review.ts is called out by ev-7 for manual inspection.',
        confidence: 'low',
        evidenceIds: ['ev-7'],
        evidenceClasses: ['runtime_diagnostic'],
        nextTools: ['manual_patch_with_guard'],
      },
      { callableToolNames },
    );

    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error('expected validation failure');
    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'nextTools[0]',
        }),
      ]),
    );

    const valid = emitOrganicRecommendation(
      {
        id: 'rec-4',
        action: 'manual-review',
        target: { kind: 'file', name: 'src/core/review.ts', filePath: 'src/core/review.ts' },
        reason: 'src/core/review.ts is called out by ev-7 for manual inspection.',
        confidence: 'low',
        evidenceIds: ['ev-7'],
        evidenceClasses: ['runtime_diagnostic'],
        nextTools: [{ kind: 'non-tool-action', name: 'manual_patch_with_guard' }],
      },
      { callableToolNames },
    );

    expect(valid.nextTools).toEqual([]);
    expect(valid.nonToolActions).toEqual(['manual_patch_with_guard']);
  });

  it('rejects generic reasons that do not reference concrete evidence', () => {
    const result = validateOrganicRecommendation(
      {
        id: 'rec-5',
        action: 'review-test-gap',
        target: { kind: 'symbol', name: 'parseToken' },
        reason: 'Add tests before merging.',
        confidence: 'medium',
        evidenceIds: ['tg-1'],
        evidenceClasses: ['graph_evidence'],
        nextTools: ['gn_test_gap'],
      },
      { callableToolNames },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'reason',
        }),
      ]),
    );
  });

  it('accepts a valid evidence-backed recommendation', () => {
    const recommendation = emitOrganicRecommendation(
      {
        id: 'rec-6',
        action: 'review-test-gap',
        target: { kind: 'symbol', name: 'parseToken', filePath: 'src/core/auth.ts', startLine: 42 },
        reason: 'parseToken is referenced by tg-1 and lacks linked coverage in src/core/auth.ts.',
        confidence: 'high',
        evidenceIds: ['tg-1'],
        evidenceClasses: ['graph_evidence'],
        nextTools: ['gn_test_gap', 'gn_verify_diff'],
      },
      { callableToolNames },
    );

    expect(recommendation).toEqual({
      id: 'rec-6',
      action: 'review-test-gap',
      target: { kind: 'symbol', name: 'parseToken', filePath: 'src/core/auth.ts', startLine: 42 },
      reason: 'parseToken is referenced by tg-1 and lacks linked coverage in src/core/auth.ts.',
      confidence: 'high',
      evidenceIds: ['tg-1'],
      evidenceClasses: ['graph_evidence'],
      scoreTrace: undefined,
      nextTools: ['gn_test_gap', 'gn_verify_diff'],
      nonToolActions: [],
    });
  });

  it('rejects high confidence when evidence classes are low-authority only', () => {
    const result = validateOrganicRecommendation(
      {
        id: 'rec-7',
        action: 'review-runtime-warning',
        target: { kind: 'file', name: 'src/runtime.ts', filePath: 'src/runtime.ts' },
        reason: 'src/runtime.ts is flagged by ev-42 with runtime diagnostic drift.',
        confidence: 'high',
        evidenceIds: ['ev-42'],
        evidenceClasses: ['runtime_diagnostic', 'advisory_memory', 'docs_evidence'],
        nextTools: ['gn_verify_diff'],
      },
      { callableToolNames },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'confidence',
        }),
      ]),
    );
  });

  it('rejects docs, memory, and runtime diagnostics as standalone audit authority', () => {
    for (const evidenceClass of [
      'docs_evidence',
      'advisory_memory',
      'runtime_diagnostic',
    ] as const) {
      const result = validateOrganicRecommendation(
        {
          id: `rec-low-authority-${evidenceClass}`,
          action: 'accept-audit-finding',
          target: { kind: 'file', name: 'src/audit.ts', filePath: 'src/audit.ts' },
          reason: `src/audit.ts is only supported by ev-${evidenceClass}.`,
          confidence: 'high',
          evidenceIds: [`ev-${evidenceClass}`],
          evidenceClasses: [evidenceClass],
          nextTools: ['gn_verify_diff'],
        },
        { callableToolNames },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${evidenceClass} validation failure`);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'confidence',
            message: expect.stringContaining('high confidence requires authoritative evidence'),
          }),
        ]),
      );
    }
  });
});
