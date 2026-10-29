import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'ontoindex-shared';
import type { ScopeExtractionRecord } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { ScopeRetentionStage } from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';

const options = () => ({
  deadline: Date.now() + 30_000,
  artifactAllowance: { remainingBytes: 1024 * 1024 },
});

describe('scope retention refusal inventory reasons', () => {
  it('completes the parsed-file producer for unsupported Rust scopes with no consumer', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.recordOutcomes([
        { filePath: 'legacy.rs', status: 'failed', reason: 'unsupported-syntax' },
      ]);
      stage.reconcile(['legacy.rs']);
      stage.markProducerCompleted('parsed-files');
      expect(stage.inventory).toEqual([
        { filePath: 'legacy.rs', status: 'not-required', reason: 'unsupported-syntax' },
      ]);
      expect(stage.status).toBe('retained');
      expect(stage.producerCompletion['parsed-files']).toBe(true);
    } finally {
      await stage.dispose();
    }
  });

  it.each<ScopeExtractionRecord>([
    { filePath: 'used.ts', status: 'failed', reason: 'unsupported-syntax' },
    { filePath: 'legacy.rs', status: 'failed', reason: 'scope-extraction-error' },
    { filePath: 'legacy.rs', status: 'unsupported', reason: 'missing-scope-hook' },
  ])(
    'keeps required or unexpected scope failures incomplete: $filePath $reason',
    async (outcome) => {
      const stage = new ScopeRetentionStage(options());
      try {
        stage.recordOutcomes([outcome]);
        stage.reconcile([outcome.filePath]);
        stage.markProducerCompleted('parsed-files');
        expect(stage.status).toBe('incomplete');
        expect(stage.producerCompletion['parsed-files']).toBe(false);
      } finally {
        await stage.dispose();
      }
    },
  );

  it('exposes unsupported syntax only on the refused entry and preserves it in JSON', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.recordOutcomes([
        { filePath: 'refused.ts', status: 'failed', reason: 'unsupported-syntax' },
        { filePath: 'failed.ts', status: 'failed', reason: 'scope-extraction-error' },
        { filePath: 'ok.ts', status: 'success' },
      ]);
      const file: ParsedFile = {
        filePath: 'ok.ts',
        moduleScope: 'scope:ok.ts#module',
        scopes: [],
        localDefs: [],
        parsedImports: [],
        referenceSites: [],
      };
      stage.capture([file]);
      stage.reconcile(['refused.ts', 'failed.ts', 'ok.ts']);
      await stage.flush();

      const expected = [
        { filePath: 'refused.ts', status: 'failed', reason: 'unsupported-syntax' },
        { filePath: 'failed.ts', status: 'failed' },
        { filePath: 'ok.ts', status: 'retained' },
      ];
      expect(stage.inventory).toStrictEqual(expected);
      expect(stage.inventory[1]).not.toHaveProperty('reason');
      expect(stage.inventory[2]).not.toHaveProperty('reason');
      expect(JSON.parse(JSON.stringify(stage.inventory))).toStrictEqual(expected);
    } finally {
      await stage.dispose();
    }
  });

  it.each<{ outcome: ScopeExtractionRecord; expectedStatus: string }>([
    { outcome: { filePath: 'a.ts', status: 'success' }, expectedStatus: 'missing-artifact' },
    {
      outcome: { filePath: 'a.ts', status: 'failed', reason: 'scope-extraction-error' },
      expectedStatus: 'failed',
    },
    {
      outcome: { filePath: 'a.ts', status: 'unsupported', reason: 'missing-scope-hook' },
      expectedStatus: 'unsupported',
    },
  ])(
    'clears an earlier refusal reason after a $outcome.status outcome',
    async ({ outcome, expectedStatus }) => {
      const stage = new ScopeRetentionStage(options());
      try {
        stage.recordOutcomes([
          { filePath: 'a.ts', status: 'failed', reason: 'unsupported-syntax' },
        ]);
        stage.recordOutcomes([outcome]);
        expect(stage.inventory).toStrictEqual([{ filePath: 'a.ts', status: expectedStatus }]);
        expect(stage.inventory[0]).not.toHaveProperty('reason');
        expect(stage.reasons).toContain('duplicate-outcome');
      } finally {
        await stage.dispose();
      }
    },
  );
});
