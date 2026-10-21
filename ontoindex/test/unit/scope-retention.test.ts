import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BindingRef, ParsedFile, TypeRef } from 'ontoindex-shared';
import {
  decodeParsedFileRecord,
  encodeParsedFileRecord,
  ParsedFileRecordError,
} from '../../src/core/ingestion/pipeline-phases/parse-scope-codec.js';
import { ScopeRetentionStage } from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.js';
import type { ImportConfigObservations } from '../../src/core/ingestion/language-config.js';

function fixture(filePath = 'src/é😀\\"\n.ts'): ParsedFile {
  const moduleScope = `scope:${filePath}#module`;
  const child = `scope:${filePath}#child`;
  const range = { startLine: 1, startCol: 0, endLine: 20, endCol: 3 };
  const childRange = { startLine: 2, startCol: 0, endLine: 19, endCol: 0 };
  const def = {
    nodeId: `def:${filePath}:User`,
    filePath,
    type: 'Class' as const,
    qualifiedName: 'sample.User',
    parameterTypes: ['é', '\ud800'],
  };
  const imported = {
    localName: 'Alias',
    targetFile: 'other.ts',
    targetExportedName: 'Other',
    kind: 'alias' as const,
  };
  return {
    filePath,
    moduleScope,
    scopes: [
      {
        id: moduleScope,
        parent: null,
        kind: 'Module',
        range,
        filePath,
        bindings: new Map<string, readonly BindingRef[]>([
          ['z', [{ def, origin: 'local' as const }]],
          ['a', [{ def, origin: 'import' as const, via: imported }]],
        ]),
        ownedDefs: [def],
        imports: [imported],
        typeBindings: new Map<string, TypeRef>([
          [
            'z',
            {
              rawName: 'List',
              declaredAtScope: moduleScope,
              source: 'annotation' as const,
              typeArgs: [
                { rawName: 'User', declaredAtScope: moduleScope, source: 'annotation' as const },
              ],
            },
          ],
          ['a', { rawName: 'User', declaredAtScope: child, source: 'self' as const }],
        ]),
      },
      {
        id: child,
        parent: moduleScope,
        kind: 'Class',
        range: childRange,
        filePath,
        bindings: new Map(),
        typeBindings: new Map(),
        ownedDefs: [],
        imports: [],
      },
    ],
    parsedImports: [],
    localDefs: [def],
    referenceSites: [
      {
        name: 'save',
        atRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 6 },
        inScope: child,
        kind: 'call',
        callForm: 'member',
        explicitReceiver: { name: 'user' },
        arity: 2,
      },
    ],
  };
}

const options = (remainingBytes = 1024 * 1024) => ({
  deadline: Date.now() + 30_000,
  artifactAllowance: { remainingBytes },
});

async function replay(stage: ScopeRetentionStage): Promise<ParsedFile[]> {
  const files: ParsedFile[] = [];
  for await (const batch of stage.iterate()) files.push(...batch);
  return files;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function configuration(): ImportConfigObservations {
  const records: ImportConfigObservations['records'] = [
    {
      kind: 'directory',
      path: '.',
      status: 'present',
      entries: [{ name: 'src', kind: 'directory' }],
    },
  ];
  return {
    version: 1,
    complete: true,
    records,
    issues: [],
    digest: createHash('sha256')
      .update(JSON.stringify({ version: 1, records }))
      .digest('hex'),
  };
}

describe('scope retention consumed input evidence', () => {
  it('detaches and freezes original UTF-8 source identities and configuration records', async () => {
    const stage = new ScopeRetentionStage(options());
    const config = configuration();
    const expectedConfig = JSON.parse(JSON.stringify(config));
    const content = 'export const greeting = "é😀";\n';
    const source = { path: 'one.ts', content };
    try {
      stage.captureConfigObservations(config);
      stage.captureParserInputs([source]);
      stage.capture([fixture('one.ts')]);
      stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
      stage.reconcile(['one.ts']);
      source.path = 'changed.ts';
      source.content = 'changed';
      const directory = config.records[0];
      if (directory?.kind === 'directory') {
        (directory.entries as { name: string; kind: string }[])[0]!.name = 'changed';
      }
      const evidence = stage.inputEvidence;
      expect(evidence).toEqual({
        domain: 'parser-text-utf8',
        complete: true,
        configuration: expectedConfig,
        sources: [
          {
            filePath: 'one.ts',
            sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
            byteLength: Buffer.byteLength(content, 'utf8'),
          },
        ],
        reasons: [],
      });
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence.sources)).toBe(true);
      expect(Object.isFrozen(evidence.sources[0])).toBe(true);
      expect(Object.isFrozen(evidence.configuration)).toBe(true);
      expect(Object.isFrozen(evidence.configuration!.records)).toBe(true);
      const capturedDirectory = evidence.configuration!.records[0];
      if (capturedDirectory?.kind === 'directory') {
        expect(Object.isFrozen(capturedDirectory.entries)).toBe(true);
        expect(Object.isFrozen(capturedDirectory.entries![0])).toBe(true);
      }
      expect(stage.status).toBe('retained');
    } finally {
      await stage.dispose();
    }
  });

  it('deduplicates identical reads and keeps a conflicting source observation incomplete', async () => {
    const stage = new ScopeRetentionStage(options());
    const source = { path: 'one.ts', content: 'original' };
    try {
      stage.captureConfigObservations(configuration());
      stage.captureParserInputs([source, source]);
      stage.capture([fixture('one.ts')]);
      stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
      stage.reconcile(['one.ts']);
      const originalEvidence = stage.inputEvidence;
      expect(originalEvidence.complete).toBe(true);
      expect(originalEvidence.sources).toHaveLength(1);
      stage.captureParserInputs([{ ...source, content: 'changed' }]);
      stage.captureParserInputs([source]);
      stage.reconcile(['one.ts']);
      expect(stage.inputEvidence.complete).toBe(false);
      expect(stage.inputEvidence.reasons.length).toBeGreaterThan(0);
      expect(stage.inputEvidence.sources).toEqual(originalEvidence.sources);
      expect(originalEvidence.complete).toBe(true);
      expect(stage.status).toBe('retained');
    } finally {
      await stage.dispose();
    }
  });

  it.each(['missing source', 'missing configuration', 'incomplete configuration'] as const)(
    'refuses input completeness for %s while preserving retained artifacts',
    async (gap) => {
      const stage = new ScopeRetentionStage(options());
      try {
        const config = configuration();
        stage.captureConfigObservations(
          gap === 'missing configuration'
            ? undefined
            : gap === 'incomplete configuration'
              ? { ...config, complete: false, digest: null, issues: ['parse-error'] }
              : config,
        );
        if (gap !== 'missing source')
          stage.captureParserInputs([{ path: 'one.ts', content: 'original' }]);
        stage.capture([fixture('one.ts')]);
        stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
        stage.reconcile(['one.ts']);
        expect(stage.inputEvidence.complete).toBe(false);
        expect(stage.inputEvidence.reasons.length).toBeGreaterThan(0);
        expect(stage.status).toBe('retained');
        expect(await replay(stage)).toEqual([fixture('one.ts')]);
      } finally {
        await stage.dispose();
      }
    },
  );

  it('rejects a source outside the reconciled inventory without losing retained artifacts', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.captureConfigObservations(configuration());
      stage.captureParserInputs([
        { path: 'one.ts', content: 'original' },
        { path: 'extra.ts', content: 'extra' },
      ]);
      stage.capture([fixture('one.ts')]);
      stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
      stage.reconcile(['one.ts']);
      expect(stage.inputEvidence.complete).toBe(false);
      expect(stage.inputEvidence.reasons).toEqual(['unexpected-source']);
      expect(stage.status).toBe('retained');
      expect(stage.seedReady).toBe(false);
      expect(await replay(stage)).toEqual([fixture('one.ts')]);
    } finally {
      await stage.dispose();
    }
  });

  it.each([
    { path: 'one.ts', content: '\ud800' },
    { path: 'one.ts', content: '\udc00' },
    { path: 'bad\ud800.ts', content: 'original' },
    { path: 'bad\udc00.ts', content: 'original' },
  ])('rejects unpaired surrogates in parser identity: %j', async (source) => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureConfigObservations(configuration());
      const beforeSource = request.artifactAllowance.remainingBytes;
      stage.captureParserInputs([source]);
      expect(request.artifactAllowance.remainingBytes).toBe(beforeSource);
      stage.capture([fixture(source.path)]);
      stage.recordOutcomes([{ filePath: source.path, status: 'success' }]);
      stage.reconcile([source.path]);
      expect(stage.inputEvidence.complete).toBe(false);
      expect(stage.inputEvidence.sources).toEqual([]);
      expect(stage.inputEvidence.reasons).toEqual(['source-invalid-utf8', 'missing-source']);
      expect(stage.status).toBe('retained');
      expect(stage.seedReady).toBe(false);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it.each(['malformed digest', 'mismatched digest', 'unknown field'] as const)(
    'rejects configuration with %s while retaining artifacts',
    async (invalidity) => {
      const stage = new ScopeRetentionStage(options());
      try {
        const config = configuration();
        const invalid =
          invalidity === 'unknown field'
            ? { ...config, unknown: true }
            : { ...config, digest: invalidity === 'malformed digest' ? 'invalid' : '0'.repeat(64) };
        stage.captureConfigObservations(invalid);
        stage.captureParserInputs([{ path: 'one.ts', content: 'original' }]);
        stage.capture([fixture('one.ts')]);
        stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
        stage.reconcile(['one.ts']);
        expect(stage.inputEvidence.complete).toBe(false);
        expect(stage.inputEvidence.configuration).toBeNull();
        expect(stage.inputEvidence.reasons).toEqual([
          'configuration-invalid',
          'configuration-incomplete',
        ]);
        expect(stage.status).toBe('retained');
        expect(stage.seedReady).toBe(false);
      } finally {
        await stage.dispose();
      }
    },
  );

  it('keeps the first valid configuration and remembers a conflicting valid observation', async () => {
    const stage = new ScopeRetentionStage(options());
    const original = configuration();
    const records: ImportConfigObservations['records'] = [
      { kind: 'directory', path: '.', status: 'present', entries: [] },
    ];
    const changed: ImportConfigObservations = {
      ...configuration(),
      records,
      digest: createHash('sha256')
        .update(JSON.stringify({ version: 1, records }))
        .digest('hex'),
    };
    try {
      stage.captureConfigObservations(original);
      stage.captureConfigObservations(configuration());
      stage.captureParserInputs([{ path: 'one.ts', content: 'original' }]);
      stage.capture([fixture('one.ts')]);
      stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
      stage.reconcile(['one.ts']);
      expect(stage.inputEvidence.complete).toBe(true);
      stage.captureConfigObservations(changed);
      stage.captureConfigObservations(original);
      expect(stage.inputEvidence.complete).toBe(false);
      expect(stage.inputEvidence.configuration).toEqual(original);
      expect(stage.inputEvidence.reasons).toEqual(['configuration-conflict']);
      expect(stage.status).toBe('retained');
      expect(stage.seedReady).toBe(false);
    } finally {
      await stage.dispose();
    }
  });

  it('refuses input capture without allowance and releases all admitted bytes once', async () => {
    const refused = new ScopeRetentionStage(options(0));
    try {
      refused.captureConfigObservations(configuration());
      refused.captureParserInputs([{ path: 'one.ts', content: 'original' }]);
      refused.reconcile(['one.ts']);
      expect(refused.inputEvidence.complete).toBe(false);
      expect(refused.inputEvidence.reasons.length).toBeGreaterThan(0);
    } finally {
      await refused.dispose();
    }

    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureConfigObservations(configuration());
      stage.captureParserInputs([{ path: 'one.ts', content: 'original' }]);
      stage.capture([fixture('one.ts')]);
      expect(request.artifactAllowance.remainingBytes).toBeLessThan(allowance);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    await stage.dispose();
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    stage.captureParserInputs([{ path: 'late.ts', content: 'late' }]);
    expect(stage.inputEvidence.complete).toBe(false);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });
});

describe('scope retention codec', () => {
  it('round trips ordered nested Maps, arrays and UTF-8 facts with isolated ownership', () => {
    const input = fixture();
    const restored = decodeParsedFileRecord(encodeParsedFileRecord(input));
    expect(restored).toEqual(input);
    expect([...restored.scopes[0]!.bindings.keys()]).toEqual(['z', 'a']);
    expect([...restored.scopes[0]!.typeBindings.keys()]).toEqual(['z', 'a']);
    (input.scopes[0]!.bindings as Map<string, unknown>).clear();
    expect(restored.scopes[0]!.bindings.size).toBe(2);
  });

  it('counts newline, escaping, multibyte characters and lone surrogates at the inclusive byte bound', () => {
    const input = fixture();
    const encoded = encodeParsedFileRecord(input);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encodeParsedFileRecord(input, bytes)).toBe(encoded);
    expect(() => encodeParsedFileRecord(input, bytes - 1)).toThrow(ParsedFileRecordError);
  });

  it('preserves explicit optional undefined values', () => {
    const input = fixture('undefined.ts');
    input.localDefs[0]!.returnType = undefined;
    const output = decodeParsedFileRecord(encodeParsedFileRecord(input));
    expect(Object.hasOwn(output.localDefs[0]!, 'returnType')).toBe(true);
    expect(output).toEqual(input);
  });

  it('rejects cycles, unknown properties, malformed values and unsupported versions', () => {
    const cyclic = fixture() as unknown as Record<string, unknown>;
    cyclic.scopes = cyclic;
    expect(() => encodeParsedFileRecord(cyclic)).toThrow(ParsedFileRecordError);
    expect(() => encodeParsedFileRecord({ ...fixture(), unknown: true })).toThrow(
      ParsedFileRecordError,
    );
    expect(() =>
      encodeParsedFileRecord({ ...fixture(), toString: 'unexpected own field' }),
    ).toThrow(ParsedFileRecordError);
    expect(() => encodeParsedFileRecord({ ...fixture(), scopes: null })).toThrow(
      ParsedFileRecordError,
    );
    expect(() => decodeParsedFileRecord('{')).toThrow();
    const wire = JSON.parse(encodeParsedFileRecord(fixture()));
    wire.version = 2;
    expect(() => decodeParsedFileRecord(JSON.stringify(wire))).toThrow(ParsedFileRecordError);
  });

  it('rejects duplicate Map keys and malformed tagged maps on replay', () => {
    const wire = JSON.parse(encodeParsedFileRecord(fixture()));
    const bindings = wire.parsedFile.scopes[0].bindings;
    bindings.$map.push(bindings.$map[0]);
    expect(() => decodeParsedFileRecord(JSON.stringify(wire))).toThrow(ParsedFileRecordError);
    bindings.$map = [['bad']];
    expect(() => decodeParsedFileRecord(JSON.stringify(wire))).toThrow(ParsedFileRecordError);
  });
});

describe('bounded scope retention stage', () => {
  it('requires reconciliation before claiming retained status and after new observations', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      expect(stage.status).toBe('incomplete');
      stage.capture([fixture('one.ts')]);
      stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
      expect(stage.status).toBe('incomplete');
      stage.reconcile(['one.ts']);
      expect(stage.status).toBe('retained');
      stage.capture([fixture('two.ts')]);
      stage.recordOutcomes([{ filePath: 'two.ts', status: 'success' }]);
      expect(stage.status).toBe('incomplete');
      stage.reconcile(['one.ts', 'two.ts']);
      expect(stage.status).toBe('retained');
    } finally {
      await stage.dispose();
    }
  });

  it('rejects duplicate expected paths even when their artifact and outcome are retained', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.capture([fixture('one.ts')]);
      stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
      stage.reconcile(['one.ts', 'one.ts']);
      expect(stage.status).toBe('incomplete');
      expect(stage.reasons).toContain('duplicate-expected-path');
    } finally {
      await stage.dispose();
    }
  });

  it('rejects concurrent replay without preventing later sequential replay', async () => {
    const files = [fixture('one.ts'), fixture('two.ts')];
    const stage = new ScopeRetentionStage(options(), { batchRecords: 1 });
    try {
      stage.capture(files);
      stage.recordOutcomes(files.map(({ filePath }) => ({ filePath, status: 'success' })));
      stage.reconcile(files.map(({ filePath }) => filePath));
      const first = stage.iterate()[Symbol.asyncIterator]();
      expect((await first.next()).value).toEqual([files[0]]);
      const second = stage.iterate()[Symbol.asyncIterator]();
      await expect(second.next()).rejects.toBeInstanceOf(ParsedFileRecordError);
      const third = stage.iterate()[Symbol.asyncIterator]();
      await expect(third.next()).rejects.toMatchObject({ reason: 'concurrent-replay' });
      expect(stage.status).toBe('retained');
      expect((await first.next()).value).toEqual([files[1]]);
      expect((await first.next()).done).toBe(true);
      expect(await replay(stage)).toEqual(files);
    } finally {
      await stage.dispose();
    }
  });

  it('disposes a suspended yielded replay without waiting for its consumer and clears inventory', async () => {
    const config = options();
    const initialAllowance = config.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(config, { batchRecords: 1 });
    try {
      stage.capture([fixture('one.ts'), fixture('two.ts')]);
      const iterator = stage.iterate()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toHaveLength(1);
      await stage.dispose();
      expect(stage.inventory).toEqual([]);
      expect(config.artifactAllowance.remainingBytes).toBe(initialAllowance);
      expect((await iterator.next()).done).toBe(true);
    } finally {
      await stage.dispose();
    }
  });

  it('waits for a pending replay open and its late handle close before disposal settles', async () => {
    const stage = new ScopeRetentionStage(options());
    const opened = deferred();
    const releaseOpen = deferred();
    const closing = deferred();
    const releaseClose = deferred();
    const originalOpen = fs.open.bind(fs);
    const originalRm = fs.rm.bind(fs);
    let restoreClose: (() => void) | undefined;
    let handleClosed = false;
    let disposal: Promise<void> | undefined;
    let settled = false;
    stage.capture([fixture('one.ts')]);
    await stage.flush();
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalClose = handle.close.bind(handle);
      const closeSpy = vi.spyOn(handle, 'close').mockImplementation(async () => {
        closing.resolve();
        await releaseClose.promise;
        await originalClose();
        handleClosed = true;
      });
      restoreClose = () => closeSpy.mockRestore();
      opened.resolve();
      await releaseOpen.promise;
      return handle;
    });
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
      expect(handleClosed).toBe(true);
      await originalRm(...args);
    });
    try {
      const next = stage.iterate()[Symbol.asyncIterator]().next();
      await opened.promise;
      disposal = stage.dispose().then(() => {
        settled = true;
      });
      expect(settled).toBe(false);
      releaseOpen.resolve();
      await closing.promise;
      expect(settled).toBe(false);
      releaseClose.resolve();
      await disposal;
      expect((await next).done).toBe(true);
      expect(settled).toBe(true);
      expect(stage.inventory).toEqual([]);
    } finally {
      releaseOpen.resolve();
      releaseClose.resolve();
      await (disposal ?? stage.dispose());
      restoreClose?.();
      openSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  it('marks write failures incomplete even after inventory reconciliation', async () => {
    const stage = new ScopeRetentionStage(options());
    const failure = new Error('append failed');
    const appendSpy = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(failure);
    try {
      stage.capture([fixture('one.ts')]);
      stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
      stage.reconcile(['one.ts']);
      expect(stage.status).toBe('retained');
      await expect(stage.flush()).rejects.toBe(failure);
      expect(stage.status).toBe('incomplete');
      expect(stage.reasons).toContain('write-failed');
    } finally {
      appendSpy.mockRestore();
      await stage.dispose();
    }
  });

  it('detaches synchronously before caller cleanup and replays ordered bounded batches', async () => {
    const input = [fixture('z.ts'), fixture('a.ts'), fixture('m.ts')];
    const expected = input.map((file) => decodeParsedFileRecord(encodeParsedFileRecord(file)));
    const stage = new ScopeRetentionStage(options(), { batchRecords: 1, readChunkBytes: 7 });
    try {
      stage.capture(input);
      stage.recordOutcomes(input.map(({ filePath }) => ({ filePath, status: 'success' })));
      stage.reconcile(input.map(({ filePath }) => filePath));
      for (const file of input) (file.scopes[0]!.bindings as Map<string, unknown>).clear();
      input.length = 0;
      await stage.flush();
      const batches: (readonly ParsedFile[])[] = [];
      for await (const batch of stage.iterate()) batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
      expect(batches.flat()).toEqual(expected);
      expect(stage.status).toBe('retained');
      // This parity check uses a small fixture; finalization itself collects all files.
      const actualModel = finalizeScopeModel(batches.flat());
      const expectedModel = finalizeScopeModel(expected);
      expect(actualModel.stats).toEqual(expectedModel.stats);
      expect(actualModel.defs.byId).toEqual(expectedModel.defs.byId);
      expect(actualModel.defs.size).toBe(expectedModel.defs.size);
      expect(actualModel.moduleScopes.byFilePath).toEqual(expectedModel.moduleScopes.byFilePath);
      expect(actualModel.moduleScopes.size).toBe(expectedModel.moduleScopes.size);
      expect(actualModel.referenceSites).toEqual(expectedModel.referenceSites);
    } finally {
      await stage.dispose();
    }
  });

  it('enforces inclusive aggregate and record-count bounds without claiming complete inventory', async () => {
    const one = fixture('one.ts');
    const bytes = Buffer.byteLength(encodeParsedFileRecord(one));
    const shared = options(bytes);
    const stage = new ScopeRetentionStage(shared, { maxBytes: bytes, maxRecords: 1 });
    try {
      stage.capture([one]);
      expect(stage.bytes).toBe(bytes);
      expect(shared.artifactAllowance.remainingBytes).toBe(0);
      stage.capture([fixture('two.ts')]);
      stage.reconcile(['one.ts', 'two.ts']);
      await stage.flush();
      expect(stage.recordCount).toBe(1);
      expect(stage.status).toBe('incomplete');
      expect(stage.reasons.length).toBeGreaterThan(0);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['missing', 'failed', 'unsupported', 'skipped'] as const)(
    'records %s extraction as incomplete inventory',
    async (outcome) => {
      const stage = new ScopeRetentionStage(options());
      try {
        if (outcome === 'failed')
          stage.recordOutcomes([
            { filePath: 'gap.ts', status: 'failed', reason: 'scope-extraction-error' },
          ]);
        if (outcome === 'unsupported')
          stage.recordOutcomes([
            { filePath: 'gap.ts', status: 'unsupported', reason: 'missing-scope-hook' },
          ]);
        stage.reconcile(['gap.ts'], outcome === 'skipped' ? ['gap.ts'] : []);
        await stage.flush();
        expect(stage.status).toBe('incomplete');
        expect(stage.inventory).toEqual([expect.objectContaining({ filePath: 'gap.ts' })]);
        expect(await replay(stage)).toEqual([]);
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['deadline', 'cancelled', 'shared allowance', 'record bytes'])(
    'refuses capture after %s admission fails',
    async (reason) => {
      const config = options(reason === 'shared allowance' ? 0 : 1024 * 1024);
      const controller = new AbortController();
      if (reason === 'deadline') config.deadline = Date.now() - 1;
      if (reason === 'cancelled') controller.abort();
      const stage = new ScopeRetentionStage(
        { ...config, signal: controller.signal },
        reason === 'record bytes' ? { maxRecordBytes: 1 } : undefined,
      );
      try {
        stage.capture([fixture('refused.ts')]);
        stage.reconcile(['refused.ts']);
        await stage.flush();
        expect(stage.status).toBe('incomplete');
        expect(stage.recordCount).toBe(0);
        expect(stage.reasons.length).toBeGreaterThan(0);
      } finally {
        await stage.dispose();
      }
    },
  );

  it('shares the caller allowance across stage instances', async () => {
    const file = fixture('one.ts');
    const shared = options(Buffer.byteLength(encodeParsedFileRecord(file)));
    const first = new ScopeRetentionStage(shared);
    const second = new ScopeRetentionStage(shared);
    try {
      first.capture([file]);
      second.capture([file]);
      await first.flush();
      await second.flush();
      expect(first.recordCount).toBe(1);
      expect(second.recordCount).toBe(0);
      expect(second.status).toBe('incomplete');
    } finally {
      await first.dispose();
      await second.dispose();
    }
    expect(shared.artifactAllowance.remainingBytes).toBe(
      Buffer.byteLength(encodeParsedFileRecord(file)),
    );
    await first.dispose();
    expect(shared.artifactAllowance.remainingBytes).toBe(
      Buffer.byteLength(encodeParsedFileRecord(file)),
    );
  });

  it.each(['bytes', 'records'] as const)(
    'enforces the independent %s ceiling exactly and one over',
    async (ceiling) => {
      const files = [fixture('one.ts'), fixture('two.ts')];
      const bytes = Buffer.byteLength(encodeParsedFileRecord(files[0]));
      const stage = new ScopeRetentionStage(
        options(),
        ceiling === 'bytes' ? { maxBytes: bytes } : { maxRecords: 1 },
      );
      try {
        stage.capture([files[0]]);
        expect(stage.recordCount).toBe(1);
        stage.capture([files[1]]);
        expect(stage.recordCount).toBe(1);
        expect(stage.bytes).toBe(bytes);
        expect(stage.status).toBe('incomplete');
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['duplicate', 'unexpected'] as const)(
    'refuses a complete claim for %s artifacts',
    async (kind) => {
      const stage = new ScopeRetentionStage(options());
      try {
        stage.capture([fixture('one.ts')]);
        stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
        if (kind === 'duplicate') stage.capture([fixture('one.ts')]);
        stage.reconcile(kind === 'unexpected' ? [] : ['one.ts']);
        expect(stage.status).toBe('incomplete');
      } finally {
        await stage.dispose();
      }
    },
  );

  it('labels an empty observed inventory without claiming seed readiness', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.reconcile([]);
      expect(stage.inventory).toEqual([]);
      expect(stage.seedReady).toBe(false);
      expect(stage.evidenceScope).toBe('observed-inventory');
      expect(await replay(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it('stops replay after cancellation between yielded batches', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage(
      { ...options(), signal: controller.signal },
      { batchRecords: 1 },
    );
    try {
      stage.capture([fixture('one.ts'), fixture('two.ts')]);
      await stage.flush();
      const iterator = stage.iterate()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toHaveLength(1);
      controller.abort();
      expect((await iterator.next()).done).toBe(true);
      expect(stage.status).toBe('incomplete');
    } finally {
      await stage.dispose();
    }
  });
});
