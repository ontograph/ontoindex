import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'ontoindex-shared';
import { ScopeRetentionStage } from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import type { ExtractedCall } from '../../src/core/ingestion/workers/parse-types.js';

const maxRecords = 10;
const registration = JSON.stringify({ kind: 'model.clear' });

function createStage(): ScopeRetentionStage {
  return new ScopeRetentionStage(
    {
      deadline: Date.now() + 30_000,
      artifactAllowance: { remainingBytes: 1024 * 1024 },
    },
    { maxRecords },
  );
}

function parsedFile(index: number): ParsedFile {
  const filePath = `src/file-${index}.ts`;
  const moduleScope = `scope:${filePath}#module`;
  return {
    filePath,
    moduleScope,
    scopes: [
      {
        id: moduleScope,
        parent: null,
        kind: 'Module',
        range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
        filePath,
        bindings: new Map(),
        typeBindings: new Map(),
        ownedDefs: [],
        imports: [],
      },
    ],
    parsedImports: [],
    localDefs: [],
    referenceSites: [],
  };
}

describe('parsed-file record reservation', () => {
  it('preserves unreserved admission, including parsed-file starvation at the aggregate ceiling', async () => {
    const stage = createStage();
    try {
      for (let index = 0; index < maxRecords; index++) {
        expect(stage.captureModelRegistration(registration)).toBe(true);
      }
      expect(stage.captureModelRegistration(registration)).toBe(false);
      expect(stage.modelRegistrationRecordCount).toBe(maxRecords);
      expect(stage.reasons).toContain('model-registration-count-limit');

      stage.capture([parsedFile(0)]);
      expect(stage.recordCount).toBe(0);
      expect(stage.reasons).toContain('record-count-limit');
    } finally {
      await stage.dispose();
    }
  });

  it('keeps three parsed-file slots after model registrations reach their reserved ceiling', async () => {
    const stage = createStage();
    try {
      stage.reserveParsedFileRecords(3);
      for (let index = 0; index < maxRecords - 3; index++) {
        expect(stage.captureModelRegistration(registration)).toBe(true);
      }
      expect(stage.captureModelRegistration(registration)).toBe(false);
      expect(stage.modelRegistrationRecordCount).toBe(7);
      expect(stage.reasons).toContain('model-registration-count-limit');

      stage.capture([parsedFile(0), parsedFile(1), parsedFile(2)]);
      expect(stage.recordCount).toBe(3);
      const replayed: ParsedFile[] = [];
      for await (const batch of stage.iterate()) replayed.push(...batch);
      expect(replayed.map((file) => file.filePath)).toEqual([
        'src/file-0.ts',
        'src/file-1.ts',
        'src/file-2.ts',
      ]);
      expect(stage.reasons).not.toContain('record-count-limit');
    } finally {
      await stage.dispose();
    }
  });

  it('applies the same reserved aggregate ceiling to calls', async () => {
    const stage = createStage();
    const call: ExtractedCall = {
      filePath: 'src/caller.ts',
      calledName: 'save',
      sourceId: 'Function:src/caller.ts:caller',
      callForm: 'free',
      argCount: 0,
    };
    try {
      stage.reserveParsedFileRecords(3);
      stage.captureCalls(Array.from({ length: maxRecords }, () => ({ ...call })));
      expect(stage.callRecordCount).toBe(7);
      expect(stage.reasons).toContain('call-count-limit');

      stage.capture([parsedFile(0), parsedFile(1), parsedFile(2)]);
      expect(stage.recordCount).toBe(3);
      expect(stage.callRecordCount + stage.recordCount).toBe(maxRecords);
    } finally {
      await stage.dispose();
    }
  });

  it('releases each fulfilled reservation without consuming the slots still owed to parsed files', async () => {
    const stage = createStage();
    try {
      stage.reserveParsedFileRecords(3);
      stage.capture([parsedFile(0)]);
      for (let index = 0; index < maxRecords - 3; index++) {
        expect(stage.captureModelRegistration(registration)).toBe(true);
      }
      expect(stage.recordCount + stage.modelRegistrationRecordCount).toBe(maxRecords - (3 - 1));
      expect(stage.captureModelRegistration(registration)).toBe(false);

      stage.capture([parsedFile(1), parsedFile(2)]);
      expect([stage.recordCount, stage.modelRegistrationRecordCount]).toEqual([3, 7]);
      expect(stage.captureModelRegistration(registration)).toBe(false);
    } finally {
      await stage.dispose();
    }
  });

  it.each([-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid reservation %s without changing the existing reservation',
    async (invalid) => {
      const stage = createStage();
      try {
        stage.reserveParsedFileRecords(3);
        expect(() => stage.reserveParsedFileRecords(invalid)).toThrow(
          'Invalid parsed-file record reservation',
        );
        for (let index = 0; index < maxRecords - 3; index++) {
          expect(stage.captureModelRegistration(registration)).toBe(true);
        }
        expect(stage.captureModelRegistration(registration)).toBe(false);
        expect(stage.modelRegistrationRecordCount).toBe(7);
        stage.capture([parsedFile(0), parsedFile(1), parsedFile(2)]);
        expect(stage.recordCount).toBe(3);
      } finally {
        await stage.dispose();
      }
    },
  );

  it('clamps an oversized safe reservation to the aggregate ceiling', async () => {
    const stage = createStage();
    try {
      stage.reserveParsedFileRecords(Number.MAX_SAFE_INTEGER);
      expect(stage.captureModelRegistration(registration)).toBe(false);
      expect(stage.modelRegistrationRecordCount).toBe(0);
      expect(stage.reasons).toContain('model-registration-count-limit');
      stage.capture(Array.from({ length: maxRecords }, (_, index) => parsedFile(index)));
      expect(stage.recordCount).toBe(maxRecords);
      expect(stage.reasons).not.toContain('record-count-limit');
    } finally {
      await stage.dispose();
    }
  });
});
