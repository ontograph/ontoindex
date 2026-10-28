import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getLanguageFromFilename, SupportedLanguages, type ParsedFile } from 'ontoindex-shared';
import {
  decodeParsedFileRecord,
  encodeParsedFileRecord,
  MAX_PARSED_FILE_RECORD_BYTES,
} from '../../src/core/ingestion/pipeline-phases/parse-scope-codec.js';
import {
  createEmptyResult,
  hydrateParseWorkerInput,
  mergeParseWorkerResult,
  PARSE_WORKER_PROTOCOL_VERSION,
  resolveParseWorkerInputPath,
  type WorkerIncomingMessage,
  type WorkerOutgoingMessage,
} from '../../src/core/ingestion/workers/parse-types.js';

function parsedFileFixture(filePath: string) {
  const moduleScope = `scope:${filePath}#1:0-3:0:Module`;
  const definition = { nodeId: `Function:${filePath}:run`, filePath, type: 'Function' as const };
  return {
    filePath,
    moduleScope,
    scopes: [
      {
        id: moduleScope,
        parent: null,
        kind: 'Module' as const,
        range: { startLine: 1, startCol: 0, endLine: 3, endCol: 0 },
        filePath,
        bindings: new Map([['run', [{ def: definition, origin: 'local' as const }]]]),
        ownedDefs: [definition],
        imports: [],
        typeBindings: new Map([
          [
            'run',
            {
              rawName: 'Handler',
              declaredAtScope: moduleScope,
              source: 'annotation' as const,
            },
          ],
        ]),
      },
    ],
    parsedImports: [],
    localDefs: [definition],
    exports: new Map([['run', definition.nodeId]]),
    referenceSites: [
      {
        name: 'run',
        atRange: { startLine: 2, startCol: 0, endLine: 2, endCol: 3 },
        inScope: moduleScope,
        kind: 'call' as const,
        callForm: 'free' as const,
        arity: 0,
      },
    ],
  } satisfies ParsedFile;
}

function computedReadFixture() {
  return {
    kind: 'read' as const,
    selection: {
      kind: 'computed' as const,
      objectRange: { startLine: 2, startCol: 0, endLine: 2, endCol: 3 },
      indexRange: { startLine: 2, startCol: 4, endLine: 2, endCol: 7 },
    },
    atRange: { startLine: 2, startCol: 0, endLine: 2, endCol: 8 },
    inScope: 'scope:src/computed.ts#1:0-3:0:Module',
  };
}

describe('parse worker protocol schema', () => {
  it('pins the serialized protocol version', () => {
    expect(PARSE_WORKER_PROTOCOL_VERSION).toBe(2);
  });

  it('creates the complete empty result shape used by worker and native boundaries', () => {
    expect(createEmptyResult()).toEqual({
      nodes: [],
      relationships: [],
      symbols: [],
      imports: [],
      calls: [],
      assignments: [],
      heritage: [],
      routes: [],
      fetchCalls: [],
      decoratorRoutes: [],
      toolDefs: [],
      ormQueries: [],
      constructorBindings: [],
      fileScopeBindings: [],
      parsedFiles: [],
      scopeExtractionOutcomes: [],
      processedPaths: [],
      parseErrorPaths: [],
      fileTimings: [],
      extractorTimings: [],
      skippedLanguages: {},
      fileCount: 0,
    });
  });

  it('merges result parts without spread-based array appends', () => {
    const target = createEmptyResult();
    const source = createEmptyResult();
    source.nodes.push({
      id: 'Function:src/a.ts:run',
      label: 'Function',
      properties: {
        name: 'run',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 3,
        language: SupportedLanguages.TypeScript,
        isExported: true,
      },
    });
    source.processedPaths.push('src/a.ts');
    source.fileTimings.push({
      filePath: 'src/a.ts',
      language: SupportedLanguages.TypeScript,
      durationMs: 7,
      status: 'processed',
    });
    source.skippedLanguages.ruby = 2;
    source.fileCount = 1;

    mergeParseWorkerResult(target, source);

    expect(target.nodes).toHaveLength(1);
    expect(target.processedPaths).toEqual(['src/a.ts']);
    expect(target.fileTimings).toEqual([
      {
        filePath: 'src/a.ts',
        language: 'typescript',
        durationMs: 7,
        status: 'processed',
      },
    ]);
    expect(target.skippedLanguages).toEqual({ ruby: 2 });
    expect(target.fileCount).toBe(1);
  });

  it('accepts the stable incoming and outgoing message variants at compile time', () => {
    const incoming: WorkerIncomingMessage[] = [
      [],
      {
        type: 'sub-batch',
        files: [{ path: 'src/a.ts', content: 'export const a = 1;' }],
        diagnostics: {
          workerIndex: 0,
          subBatchIndex: 1,
          subBatchSize: 1,
          workerChunkSize: 1,
          firstFilePath: 'src/a.ts',
          lastFilePath: 'src/a.ts',
        },
      },
      {
        type: 'sub-batch',
        files: [{ path: 'src/b.ts', contentSource: 'path', repoPath: '/repo' }],
      },
      { type: 'flush' },
    ];
    const outgoing: WorkerOutgoingMessage[] = [
      { type: 'progress', filesProcessed: 1, filePath: 'src/a.ts' },
      {
        type: 'diagnostic',
        diagnostics: {
          workerIndex: 0,
          subBatchIndex: 1,
          subBatchSize: 1,
          workerChunkSize: 1,
          currentFilePath: 'src/a.ts',
          phase: 'process-file',
        },
      },
      { type: 'warning', message: 'slow file' },
      { type: 'result-part', data: createEmptyResult() },
      { type: 'sub-batch-done' },
      {
        type: 'error',
        error: 'parse failed',
        diagnostics: { currentFilePath: 'src/a.ts', phase: 'process-file' },
      },
      { type: 'result', data: createEmptyResult() },
    ];

    expect(incoming.map((message) => (Array.isArray(message) ? 'legacy' : message.type))).toEqual([
      'legacy',
      'sub-batch',
      'sub-batch',
      'flush',
    ]);
    expect(outgoing.map((message) => message.type)).toEqual([
      'progress',
      'diagnostic',
      'warning',
      'result-part',
      'sub-batch-done',
      'error',
      'result',
    ]);
  });

  it('preserves ordered scope outcomes after merged source arrays are cleared', () => {
    const target = createEmptyResult();
    const first = createEmptyResult();
    const second = createEmptyResult();
    first.scopeExtractionOutcomes = [{ filePath: 'z.ts', status: 'success' }];
    second.scopeExtractionOutcomes = [
      { filePath: 'a.js', status: 'unsupported', reason: 'missing-scope-hook' },
      { filePath: 'b.ts', status: 'failed', reason: 'scope-extraction-error' },
      { filePath: 'c.cxx', status: 'failed', reason: 'missing-module-scope' },
    ];

    mergeParseWorkerResult(target, first);
    mergeParseWorkerResult(target, second);
    first.scopeExtractionOutcomes.length = 0;
    second.scopeExtractionOutcomes.length = 0;

    expect(target.scopeExtractionOutcomes).toEqual([
      { filePath: 'z.ts', status: 'success' },
      { filePath: 'a.js', status: 'unsupported', reason: 'missing-scope-hook' },
      { filePath: 'b.ts', status: 'failed', reason: 'scope-extraction-error' },
      { filePath: 'c.cxx', status: 'failed', reason: 'missing-module-scope' },
    ]);
    expect(target.parsedFiles).toEqual([]);
  });

  it('accepts legacy results without the optional scope outcome field', () => {
    const target = createEmptyResult();
    const legacy = createEmptyResult();
    delete legacy.scopeExtractionOutcomes;

    expect(() => mergeParseWorkerResult(target, legacy)).not.toThrow();
    expect(target.scopeExtractionOutcomes).toEqual([]);
  });

  it('retains ordered parsed artifacts and outcomes when producer arrays are cleared', () => {
    const target = createEmptyResult();
    const files = [parsedFileFixture('src/z.ts'), parsedFileFixture('src/a.ts')];
    const parts = files.map((file) => {
      const part = createEmptyResult();
      part.parsedFiles.push(file);
      part.scopeExtractionOutcomes!.push({ filePath: file.filePath, status: 'success' });
      return part;
    });

    for (const part of parts) {
      mergeParseWorkerResult(target, part);
      expect(target.parsedFiles).not.toBe(part.parsedFiles);
      expect(target.scopeExtractionOutcomes).not.toBe(part.scopeExtractionOutcomes);
      part.parsedFiles.length = 0;
      part.scopeExtractionOutcomes!.length = 0;
    }

    expect(target.parsedFiles.map((file) => file.filePath)).toEqual(['src/z.ts', 'src/a.ts']);
    expect(target.parsedFiles).toEqual(files);
    expect(target.scopeExtractionOutcomes).toEqual([
      { filePath: 'src/z.ts', status: 'success' },
      { filePath: 'src/a.ts', status: 'success' },
    ]);
    for (const [index, file] of target.parsedFiles.entries()) {
      // Merge owns the arrays; it deliberately reuses each ParsedFile object.
      expect(file).toBe(files[index]);
      expect(file.scopes[0].bindings).toBeInstanceOf(Map);
      expect(file.scopes[0].bindings.get('run')).toEqual([
        { def: files[index].localDefs[0], origin: 'local' },
      ]);
      expect(file.scopes[0].typeBindings).toBeInstanceOf(Map);
      expect(file.scopes[0].typeBindings.get('run')?.rawName).toBe('Handler');
      expect(file.exports).toBeInstanceOf(Map);
      expect(file.exports?.get('run')).toBe(files[index].localDefs[0].nodeId);
      expect(file.referenceSites).toEqual(files[index].referenceSites);
    }
  });

  it('round-trips a parsed artifact with detached maps and nested state', () => {
    const source = parsedFileFixture('src/z.ts');
    const encoded = encodeParsedFileRecord(source);
    const restored = decodeParsedFileRecord(encoded);

    expect(restored).toEqual(source);
    expect(restored).not.toBe(source);
    expect(restored.scopes).not.toBe(source.scopes);
    expect(restored.scopes[0]).not.toBe(source.scopes[0]);
    expect(restored.scopes[0].bindings).toBeInstanceOf(Map);
    expect(restored.scopes[0].bindings).not.toBe(source.scopes[0].bindings);
    expect(restored.scopes[0].bindings.get('run')).not.toBe(source.scopes[0].bindings.get('run'));
    expect(restored.scopes[0].bindings.get('run')?.[0].def).not.toBe(source.localDefs[0]);
    expect(restored.scopes[0].typeBindings).toBeInstanceOf(Map);
    expect(restored.scopes[0].typeBindings.get('run')).not.toBe(
      source.scopes[0].typeBindings.get('run'),
    );
    expect(restored.exports).toBeInstanceOf(Map);
    expect(restored.exports).not.toBe(source.exports);
    expect(restored.referenceSites).not.toBe(source.referenceSites);
    expect(restored.referenceSites[0].atRange).not.toBe(source.referenceSites[0].atRange);

    source.localDefs[0].nodeId = 'changed';
    source.scopes[0].range.endLine = 99;
    source.scopes[0].bindings.clear();
    source.scopes[0].typeBindings.get('run')!.rawName = 'Changed';
    source.exports.clear();
    source.referenceSites[0].atRange.startLine = 99;
    source.referenceSites.length = 0;

    expect(restored).toEqual(parsedFileFixture('src/z.ts'));
    expect(encodeParsedFileRecord(restored)).toBe(encoded);
  });

  it('decodes the exact legacy named reference envelope without adding selection fields', () => {
    const legacy =
      '{"version":1,"parsedFile":{"filePath":"legacy.ts","moduleScope":"module:legacy","scopes":[],"parsedImports":[],"localDefs":[],"referenceSites":[{"name":"run","atRange":{"startLine":2,"startCol":0,"endLine":2,"endCol":3},"inScope":"module:legacy","kind":"call","callForm":"free","arity":0}]}}\n';
    const restored = decodeParsedFileRecord(legacy);
    expect(restored.referenceSites).toEqual([
      {
        name: 'run',
        atRange: { startLine: 2, startCol: 0, endLine: 2, endCol: 3 },
        inScope: 'module:legacy',
        kind: 'call',
        callForm: 'free',
        arity: 0,
      },
    ]);
    expect(encodeParsedFileRecord(restored)).toBe(legacy);
  });

  it.each([false, true])('round-trips detached computed reads across lines: %s', (multiline) => {
    const source: ParsedFile = parsedFileFixture('src/computed.ts');
    const site = computedReadFixture();
    if (multiline) {
      site.selection.indexRange = { startLine: 3, startCol: 1, endLine: 3, endCol: 4 };
      site.atRange.endLine = 3;
      site.atRange.endCol = 5;
    }
    source.referenceSites = [site];
    const encoded = encodeParsedFileRecord(source);
    const restored = decodeParsedFileRecord(encoded);
    expect(JSON.parse(encoded).version).toBe(1);
    expect(restored).toEqual(source);
    const copy = restored.referenceSites[0];
    expect(copy).not.toBe(site);
    expect(copy.atRange).not.toBe(site.atRange);
    expect(copy.selection).not.toBe(site.selection);
    expect(copy.selection!.objectRange).not.toBe(site.selection.objectRange);
    expect(copy.selection!.indexRange).not.toBe(site.selection.indexRange);
    site.selection.objectRange.endCol = 2;
    site.selection.indexRange.startCol = 5;
    site.atRange.endCol = 99;
    expect(encodeParsedFileRecord(restored)).toBe(encoded);
  });

  it.each([
    { kind: 'call' },
    { kind: 'write' },
    { kind: null },
    { kind: undefined },
    { selection: null },
    { selection: undefined },
    { selection: {} },
    { selection: { ...computedReadFixture().selection, kind: 'named' } },
    { selection: { kind: 'computed', objectRange: computedReadFixture().selection.objectRange } },
    { selection: { kind: 'computed', indexRange: computedReadFixture().selection.indexRange } },
    { selection: { ...computedReadFixture().selection, extra: true } },
    { atRange: undefined },
    { inScope: undefined },
    { name: 'selected' },
    { name: undefined },
    { receiver: { name: 'bag' } },
    { explicitReceiver: { kind: 'unknown' } },
    { arity: 0 },
    { callForm: 'index' },
  ])('rejects malformed or conflicting computed variants on encode/decode: %j', (patch) => {
    const source = parsedFileFixture('src/computed.ts');
    const tampered = JSON.parse(encodeParsedFileRecord(source));
    const site = { ...computedReadFixture(), ...patch };
    Object.assign(source, { referenceSites: [site] });
    tampered.parsedFile.referenceSites = [site];
    expect(() => encodeParsedFileRecord(source)).toThrow();
    expect(() =>
      decodeParsedFileRecord(
        JSON.stringify(tampered, (_key, value) =>
          value === undefined ? { $undefined: true } : value,
        ),
      ),
    ).toThrow();
  });

  it.each([
    { field: 'atRange', range: { startLine: 2, startCol: 1, endLine: 2, endCol: 8 } },
    { field: 'atRange', range: { startLine: 2, startCol: 0, endLine: 2, endCol: 7 } },
    { field: 'objectRange', range: { startLine: 2, startCol: 0, endLine: 2, endCol: 4 } },
    { field: 'indexRange', range: { startLine: 2, startCol: 2, endLine: 2, endCol: 3 } },
    { field: 'indexRange', range: { startLine: 2, startCol: 8, endLine: 2, endCol: 9 } },
    { field: 'indexRange', range: { startLine: 2, startCol: 4, endLine: 2, endCol: 4 } },
    { field: 'objectRange', range: { startLine: 3, startCol: 0, endLine: 2, endCol: 3 } },
    { field: 'objectRange', range: { startLine: 0, startCol: 0, endLine: 2, endCol: 3 } },
    { field: 'indexRange', range: { startLine: 2, startCol: -1, endLine: 2, endCol: 7 } },
    { field: 'indexRange', range: { startLine: 2, startCol: 4.5, endLine: 2, endCol: 7 } },
    { field: 'indexRange', range: { startLine: 2.5, startCol: 4, endLine: 3, endCol: 7 } },
    {
      field: 'indexRange',
      range: { startLine: 2, startCol: 4, endLine: Number.MAX_SAFE_INTEGER + 1, endCol: 7 },
    },
    {
      field: 'indexRange',
      range: { startLine: 2, startCol: 4, endLine: 2, endCol: Number.MAX_SAFE_INTEGER + 1 },
    },
    { field: 'indexRange', range: { startLine: 2, startCol: 4, endLine: 2, endCol: Infinity } },
    { field: 'indexRange', range: { startLine: 2, startCol: 4, endLine: 2, endCol: NaN } },
    { field: 'objectRange', range: { startLine: 2, startCol: '0', endLine: 2, endCol: 3 } },
    {
      field: 'objectRange',
      range: { startLine: 2, startCol: 0, endLine: 2, endCol: 3, extra: true },
    },
  ])('rejects invalid computed $field range on encode/decode: $range', ({ field, range }) => {
    const source = parsedFileFixture('src/computed.ts');
    const tampered = JSON.parse(encodeParsedFileRecord(source));
    const site = computedReadFixture();
    Object.assign(field === 'atRange' ? site : site.selection, { [field]: range });
    Object.assign(source, { referenceSites: [site] });
    tampered.parsedFile.referenceSites = [site];
    expect(() => encodeParsedFileRecord(source)).toThrow();
    expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow();
  });

  it('rejects negative zero coordinates during both admission and decoding', () => {
    const source: ParsedFile = parsedFileFixture('src/computed.ts');
    const site = computedReadFixture();
    source.referenceSites = [site];
    const encoded = encodeParsedFileRecord(source);
    site.selection.objectRange.startCol = -0;
    expect(() => encodeParsedFileRecord(source)).toThrow('invalid-number');
    expect(() =>
      decodeParsedFileRecord(
        encoded.replace(
          '"objectRange":{"startLine":2,"startCol":0',
          '"objectRange":{"startLine":2,"startCol":-0',
        ),
      ),
    ).toThrow('invalid-number');
  });

  it('rejects a computed read missing its selection instead of inventing a named site', () => {
    const source = parsedFileFixture('src/computed.ts');
    const tampered = JSON.parse(encodeParsedFileRecord(source));
    const { selection: _selection, ...site } = computedReadFixture();
    Object.assign(source, { referenceSites: [site] });
    tampered.parsedFile.referenceSites = [site];
    expect(() => encodeParsedFileRecord(source)).toThrow('missing-field');
    expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow('missing-field');
  });

  it.each(['site', 'selection', 'range'] as const)(
    'rejects computed %s proxies without invoking their traps',
    (location) => {
      const site = computedReadFixture();
      let invoked = false;
      const proxy = (value: object) =>
        new Proxy(value, {
          get() {
            invoked = true;
            throw new Error('trap');
          },
          getOwnPropertyDescriptor() {
            invoked = true;
            throw new Error('trap');
          },
          getPrototypeOf() {
            invoked = true;
            throw new Error('trap');
          },
          ownKeys() {
            invoked = true;
            throw new Error('trap');
          },
        });
      const source = parsedFileFixture('src/computed.ts');
      if (location === 'selection') Object.assign(site, { selection: proxy(site.selection) });
      if (location === 'range')
        Object.assign(site.selection, { objectRange: proxy(site.selection.objectRange) });
      Object.assign(source, { referenceSites: [location === 'site' ? proxy(site) : site] });
      expect(() => encodeParsedFileRecord(source)).toThrow('invalid-object-or-cycle');
      expect(invoked).toBe(false);
    },
  );

  it.each(['selection', 'kind', 'objectRange', 'startCol'])(
    'rejects computed %s accessors without invoking them',
    (field) => {
      const site = computedReadFixture();
      const source = parsedFileFixture('src/computed.ts');
      let invoked = false;
      const owner =
        field === 'selection'
          ? site
          : field === 'startCol'
            ? site.selection.objectRange
            : site.selection;
      Object.defineProperty(owner, field, {
        enumerable: true,
        get() {
          invoked = true;
          throw new Error('accessor');
        },
      });
      Object.assign(source, { referenceSites: [site] });
      expect(() => encodeParsedFileRecord(source)).toThrow('invalid-property');
      expect(invoked).toBe(false);
    },
  );

  it('rejects a nonenumerable selection and enforces computed record byte admission', () => {
    const source: ParsedFile = parsedFileFixture('src/computed.ts');
    const site = computedReadFixture();
    source.referenceSites = [site];
    const encoded = encodeParsedFileRecord(source);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    expect(encodeParsedFileRecord(source, bytes)).toBe(encoded);
    expect(() => encodeParsedFileRecord(source, bytes - 1)).toThrow('record-byte-limit');
    Object.defineProperty(site, 'selection', { enumerable: false });
    expect(() => encodeParsedFileRecord(source)).toThrow('invalid-property');
  });

  it.each([
    { location: 'site', field: 'name' },
    { location: 'site', field: 'callForm' },
    { location: 'site', field: 'arity' },
    { location: 'site', field: 'explicitReceiver' },
    { location: 'selection', field: 'extra' },
    { location: 'range', field: 'extra' },
    { location: 'site', field: Symbol('extra') },
    { location: 'selection', field: Symbol('extra') },
    { location: 'range', field: Symbol('extra') },
  ])('rejects hidden and symbol computed extras at $location', ({ location, field }) => {
    const source: ParsedFile = parsedFileFixture('src/computed.ts');
    const site = computedReadFixture();
    const owner =
      location === 'site'
        ? site
        : location === 'selection'
          ? site.selection
          : site.selection.objectRange;
    let invoked = false;
    Object.defineProperty(owner, field, {
      enumerable: false,
      get() {
        invoked = true;
        throw new Error('hidden accessor');
      },
    });
    source.referenceSites = [site];
    expect(() => encodeParsedFileRecord(source)).toThrow('unknown-field');
    expect(invoked).toBe(false);
  });

  it.each([
    { name: 'handler' },
    { kind: 'unknown' as const },
    {
      kind: 'chain' as const,
      root: {
        name: 'handler',
        range: { startLine: 2, startCol: 0, endLine: 2, endCol: 7 },
      },
      steps: [
        {
          kind: 'call' as const,
          arity: 0,
          range: { startLine: 2, startCol: 0, endLine: 2, endCol: 9 },
        },
      ],
    },
  ])('round-trips a detached explicit receiver: %j', (explicitReceiver) => {
    const source: ParsedFile = parsedFileFixture('src/receiver.ts');
    Object.assign(source.referenceSites[0], { explicitReceiver });
    const encoded = encodeParsedFileRecord(source);
    const restored = decodeParsedFileRecord(encoded);

    expect(restored).toEqual(source);
    expect(restored.referenceSites[0].explicitReceiver).not.toBe(explicitReceiver);
    expect(encodeParsedFileRecord(restored)).toBe(encoded);
  });

  it.each([
    { kind: 'unknown', name: 'handler' },
    { kind: 'unknown', steps: [] },
    { kind: 'unknown', extra: true },
  ])('rejects extra fields on an unknown receiver on encode and decode: %j', (explicitReceiver) => {
    const source = parsedFileFixture('src/receiver.ts');
    const tampered = JSON.parse(encodeParsedFileRecord(source));
    Object.assign(source.referenceSites[0], { explicitReceiver });
    tampered.parsedFile.referenceSites[0].explicitReceiver = explicitReceiver;

    expect(() => encodeParsedFileRecord(source)).toThrow('unknown-field');
    expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow('unknown-field');
  });

  it.each(['invalid', '', null, 1])(
    'rejects an invalid receiver kind on encode and decode: %j',
    (kind) => {
      const source = parsedFileFixture('src/receiver.ts');
      const tampered = JSON.parse(encodeParsedFileRecord(source));
      Object.assign(source.referenceSites[0], { explicitReceiver: { kind } });
      tampered.parsedFile.referenceSites[0].explicitReceiver = { kind };

      expect(() => encodeParsedFileRecord(source)).toThrow('invalid-receiver-kind');
      expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow(
        'invalid-receiver-kind',
      );
    },
  );

  it.each(['absent', 'undefined', 'empty', 'populated'] as const)(
    'round-trips and merges %s declaration sources with detached serialized state',
    (state) => {
      const source: ParsedFile = parsedFileFixture('src/declarations.ts');
      const declaration = {
        defId: source.localDefs[0].nodeId,
        range: { startLine: 1, startCol: 0, endLine: 3, endCol: 0 },
        name: 'run',
        type: 'Function' as const,
      };
      const declarations = state === 'populated' ? [declaration] : [];
      if (state !== 'absent')
        Object.assign(source, {
          declarationSources: state === 'undefined' ? undefined : declarations,
        });

      const encoded = encodeParsedFileRecord(source);
      const restored = decodeParsedFileRecord(encoded);
      expect(restored).toEqual(source);
      expect(Object.hasOwn(restored, 'declarationSources')).toBe(state !== 'absent');
      expect(encodeParsedFileRecord(restored)).toBe(encoded);
      if (state === 'undefined') {
        expect(encoded).not.toBe(encodeParsedFileRecord(parsedFileFixture(source.filePath)));
      }
      if (source.declarationSources) {
        expect(restored.declarationSources).not.toBe(declarations);
      }
      if (state === 'populated') {
        expect(restored.declarationSources![0]).not.toBe(declaration);
        expect(restored.declarationSources![0].range).not.toBe(declaration.range);
      }

      const target = createEmptyResult();
      const part = createEmptyResult();
      part.parsedFiles.push(restored);
      mergeParseWorkerResult(target, part);
      part.parsedFiles.length = 0;
      declaration.name = 'changed';
      declaration.range.endLine = 99;
      declarations.length = 0;

      expect(target.parsedFiles).toEqual([restored]);
      expect(Object.hasOwn(target.parsedFiles[0], 'declarationSources')).toBe(state !== 'absent');
      expect(encodeParsedFileRecord(target.parsedFiles[0])).toBe(encoded);
    },
  );

  it.each([
    { label: 'null array', value: null },
    { label: 'object array', value: {} },
    { label: 'null record', value: [null] },
    { label: 'missing fields', value: [{ defId: 'def:run' }] },
    {
      label: 'numeric id',
      value: [
        {
          defId: 1,
          range: { startLine: 1, startCol: 0, endLine: 1, endCol: 3 },
          name: 'run',
          type: 'Function',
        },
      ],
    },
    {
      label: 'invalid range',
      value: [
        {
          defId: 'def:run',
          range: { startLine: '1', startCol: 0, endLine: 1, endCol: 3 },
          name: 'run',
          type: 'Function',
        },
      ],
    },
    {
      label: 'invalid name',
      value: [
        {
          defId: 'def:run',
          range: { startLine: 1, startCol: 0, endLine: 1, endCol: 3 },
          name: null,
          type: 'Function',
        },
      ],
    },
    {
      label: 'invalid type',
      value: [
        {
          defId: 'def:run',
          range: { startLine: 1, startCol: 0, endLine: 1, endCol: 3 },
          name: 'run',
          type: 'invalid',
        },
      ],
    },
    {
      label: 'unknown record field',
      value: [
        {
          defId: 'def:run',
          range: { startLine: 1, startCol: 0, endLine: 1, endCol: 3 },
          name: 'run',
          type: 'Function',
          extra: true,
        },
      ],
    },
    {
      label: 'unknown range field',
      value: [
        {
          defId: 'def:run',
          range: { startLine: 1, startCol: 0, endLine: 1, endCol: 3, extra: true },
          name: 'run',
          type: 'Function',
        },
      ],
    },
  ])('rejects declaration sources with $label on encode and decode', ({ value }) => {
    const source = parsedFileFixture('src/declarations.ts');
    const tampered = JSON.parse(encodeParsedFileRecord(source));
    Object.assign(source, { declarationSources: value });
    tampered.parsedFile.declarationSources = value;

    expect(() => encodeParsedFileRecord(source)).toThrow();
    expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow();
  });

  it('charges declaration sources against encoding and decoding byte limits', () => {
    const source = parsedFileFixture('src/declarations.ts');
    const legacyBytes = Buffer.byteLength(encodeParsedFileRecord(source), 'utf8');
    expect(() => encodeParsedFileRecord(source, legacyBytes)).not.toThrow();
    const declaration = {
      defId: source.localDefs[0].nodeId,
      range: { startLine: 1, startCol: 0, endLine: 3, endCol: 0 },
      name: 'run',
      type: 'Function',
    };
    Object.assign(source, { declarationSources: [declaration] });
    expect(() => encodeParsedFileRecord(source, legacyBytes)).toThrow('record-byte-limit');

    const encoded = encodeParsedFileRecord(source);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    expect(encodeParsedFileRecord(source, bytes)).toBe(encoded);
    expect(() => encodeParsedFileRecord(source, bytes - 1)).toThrow('record-byte-limit');
    declaration.name = 'x'.repeat(
      MAX_PARSED_FILE_RECORD_BYTES - bytes + declaration.name.length - 1,
    );
    const belowLimit = encodeParsedFileRecord(source);
    expect(Buffer.byteLength(belowLimit, 'utf8')).toBe(MAX_PARSED_FILE_RECORD_BYTES - 1);
    expect(() => decodeParsedFileRecord(belowLimit)).not.toThrow();

    const tampered = JSON.parse(belowLimit);
    declaration.name += 'xx';
    tampered.parsedFile.declarationSources[0].name = declaration.name;
    expect(() => encodeParsedFileRecord(source)).toThrow('record-byte-limit');
    expect(() => decodeParsedFileRecord(`${JSON.stringify(tampered)}\n`)).toThrow(
      'record-byte-limit',
    );
  });

  it.each(['type', 'value', 'both'] as const)(
    'round-trips a detached binding with the %s namespace deterministically',
    (namespace) => {
      const source = parsedFileFixture('src/namespace.ts');
      const binding = source.scopes[0].bindings.get('run')![0];
      Object.assign(binding, { namespace });

      const encoded = encodeParsedFileRecord(source);
      const restored = decodeParsedFileRecord(encoded);
      const restoredBinding = restored.scopes[0].bindings.get('run')![0];

      expect(restored).toEqual(source);
      expect(restoredBinding).not.toBe(binding);
      expect(restoredBinding.namespace).toBe(namespace);
      expect(encodeParsedFileRecord(restored)).toBe(encoded);
      Object.assign(binding, { namespace: 'changed' });
      expect(restoredBinding.namespace).toBe(namespace);
    },
  );

  it('preserves missing and explicitly undefined binding namespaces separately', () => {
    const source = parsedFileFixture('src/namespace.ts');
    const missingEncoded = encodeParsedFileRecord(source);
    const missing = decodeParsedFileRecord(missingEncoded);
    expect(Object.hasOwn(missing.scopes[0].bindings.get('run')![0], 'namespace')).toBe(false);
    expect(encodeParsedFileRecord(missing)).toBe(missingEncoded);

    Object.assign(source.scopes[0].bindings.get('run')![0], { namespace: undefined });
    const undefinedEncoded = encodeParsedFileRecord(source);
    const restored = decodeParsedFileRecord(undefinedEncoded);
    const restoredBinding = restored.scopes[0].bindings.get('run')![0];
    expect(Object.hasOwn(restoredBinding, 'namespace')).toBe(true);
    expect(restoredBinding.namespace).toBeUndefined();
    expect(restored).toEqual(source);
    expect(encodeParsedFileRecord(restored)).toBe(undefinedEncoded);
    expect(undefinedEncoded).not.toBe(missingEncoded);
  });

  it.each(['invalid', '', 'Type', 1, null, true, {}, []].map((namespace) => ({ namespace })))(
    'rejects invalid binding namespaces on encode and tampered decode: %j',
    ({ namespace }) => {
      const source = parsedFileFixture('src/namespace.ts');
      const tampered = JSON.parse(encodeParsedFileRecord(source));
      Object.assign(source.scopes[0].bindings.get('run')![0], { namespace });
      tampered.parsedFile.scopes[0].bindings.$map[0][1][0].namespace = namespace;

      expect(() => encodeParsedFileRecord(source)).toThrow('invalid-field');
      expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow('invalid-field');
    },
  );

  it('still rejects unknown binding fields on encode and tampered decode', () => {
    const source = parsedFileFixture('src/namespace.ts');
    const tampered = JSON.parse(encodeParsedFileRecord(source));
    Object.assign(source.scopes[0].bindings.get('run')![0], { namespace: 'type', extra: true });
    Object.assign(tampered.parsedFile.scopes[0].bindings.$map[0][1][0], {
      namespace: 'type',
      extra: true,
    });

    expect(() => encodeParsedFileRecord(source)).toThrow('unknown-field');
    expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow('unknown-field');
  });

  it.each(['absent', 'undefined', 'empty', 'distinct'] as const)(
    'retains %s namespace export maps deterministically and without aliases',
    (state) => {
      const source: ParsedFile = parsedFileFixture('src/exports.ts');
      if (state !== 'absent')
        Object.assign(source, {
          exportsByNamespace:
            state === 'undefined'
              ? undefined
              : {
                  type: new Map(state === 'distinct' ? [['Shared', 'def:type']] : []),
                  value: new Map(state === 'distinct' ? [['Shared', 'def:value']] : []),
                },
        });
      const encoded = encodeParsedFileRecord(source);
      const restored = decodeParsedFileRecord(encoded);
      expect(restored).toEqual(source);
      expect(Object.hasOwn(restored, 'exportsByNamespace')).toBe(state !== 'absent');
      if (source.exportsByNamespace) {
        expect(restored.exportsByNamespace).not.toBe(source.exportsByNamespace);
        expect(restored.exportsByNamespace!.type).not.toBe(source.exportsByNamespace.type);
        expect(restored.exportsByNamespace!.value).not.toBe(source.exportsByNamespace.value);
        (source.exportsByNamespace.type as Map<string, string>).clear();
        (source.exportsByNamespace.value as Map<string, string>).clear();
      }
      expect(encodeParsedFileRecord(restored)).toBe(encoded);
    },
  );

  it.each([
    null,
    {},
    { type: new Map() },
    { value: new Map() },
    { type: [], value: new Map() },
    { type: new Map(), value: {} },
    { type: new Map([['Shared', 1]]), value: new Map() },
    { type: new Map(), value: new Map(), extra: true },
  ])('rejects malformed namespace export maps on encode and decode: %j', (maps) => {
    const source = parsedFileFixture('src/exports.ts');
    Object.assign(source, { exportsByNamespace: maps });
    expect(() => encodeParsedFileRecord(source)).toThrow();
    const tampered = JSON.parse(encodeParsedFileRecord(parsedFileFixture('src/exports.ts')));
    tampered.parsedFile.exportsByNamespace = JSON.parse(
      JSON.stringify(maps, (_key, value) => (value instanceof Map ? { $map: [...value] } : value)),
    );
    expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow();
  });

  it.each(['type', 'value'] as const)(
    'rejects duplicate keys in the %s export map',
    (namespace) => {
      const tampered = JSON.parse(encodeParsedFileRecord(parsedFileFixture('src/exports.ts')));
      tampered.parsedFile.exportsByNamespace = {
        type: { $map: [] },
        value: { $map: [] },
        [namespace]: {
          $map: [
            ['Shared', 'def:one'],
            ['Shared', 'def:two'],
          ],
        },
      };
      expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow('invalid-map');
    },
  );

  it.each(['type', 'value', 'both', undefined] as const)(
    'retains import and edge namespaces %s, including binding provenance',
    (namespace) => {
      const source: ParsedFile = parsedFileFixture('src/imports.ts');
      const edge = {
        localName: 'Shared',
        targetFile: 'lib.ts',
        targetExportedName: 'Shared',
        kind: 'named' as const,
        namespace,
      };
      Object.assign(source, {
        parsedImports: [
          {
            kind: 'named',
            targetRaw: 'lib.ts',
            localName: 'Shared',
            importedName: 'Shared',
            namespace,
          },
          {
            kind: 'alias',
            targetRaw: 'lib.ts',
            localName: 'Shared',
            importedName: 'Shared',
            alias: 'Alias',
            namespace,
          },
          { kind: 'namespace', targetRaw: 'lib.ts', localName: 'ns', importedName: '*', namespace },
          { kind: 'wildcard', targetRaw: 'lib.ts', namespace },
          {
            kind: 'reexport',
            targetRaw: 'lib.ts',
            localName: 'Shared',
            importedName: 'Shared',
            namespace,
          },
          { kind: 'dynamic-unresolved', targetRaw: null, localName: 'dynamic', namespace },
        ],
      });
      Object.assign(source.scopes[0], { imports: [edge] });
      Object.assign(source.scopes[0].bindings.get('run')![0], { via: edge });
      const encoded = encodeParsedFileRecord(source);
      const restored = decodeParsedFileRecord(encoded);
      expect(restored).toEqual(source);
      expect(encodeParsedFileRecord(restored)).toBe(encoded);
      expect(restored.scopes[0].imports[0]).not.toBe(edge);
      expect(restored.scopes[0].bindings.get('run')![0].via).not.toBe(edge);
      Object.assign(edge, { namespace: 'changed' });
      expect(restored.scopes[0].imports[0].namespace).toBe(namespace);
      expect(restored.scopes[0].bindings.get('run')![0].via?.namespace).toBe(namespace);
    },
  );

  it.each(['import', 'edge', 'via'] as const)(
    'rejects an invalid namespace nested in %s on encode and decode',
    (location) => {
      const source = parsedFileFixture('src/imports.ts');
      const invalid = { namespace: 'invalid' };
      const edge = {
        localName: 'Shared',
        targetFile: 'lib.ts',
        targetExportedName: 'Shared',
        kind: 'named',
        ...invalid,
      };
      const tampered = JSON.parse(encodeParsedFileRecord(source));
      if (location === 'import') {
        const parsedImport = { kind: 'wildcard', targetRaw: 'lib.ts', ...invalid };
        Object.assign(source, { parsedImports: [parsedImport] });
        tampered.parsedFile.parsedImports = [parsedImport];
      } else if (location === 'edge') {
        Object.assign(source.scopes[0], { imports: [edge] });
        tampered.parsedFile.scopes[0].imports = [edge];
      } else {
        Object.assign(source.scopes[0].bindings.get('run')![0], { via: edge });
        tampered.parsedFile.scopes[0].bindings.$map[0][1][0].via = edge;
      }
      expect(() => encodeParsedFileRecord(source)).toThrow('invalid-field');
      expect(() => decodeParsedFileRecord(JSON.stringify(tampered))).toThrow('invalid-field');
    },
  );

  it('hydrates path-based inputs from parent-approved repo-relative paths', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-parse-worker-'));
    await fs.mkdir(path.join(repoPath, 'src'));
    await fs.writeFile(path.join(repoPath, 'src', 'path-mode.ts'), 'export const pathMode = 1;');

    const hydrated = await hydrateParseWorkerInput({
      path: 'src/path-mode.ts',
      contentSource: 'path',
      repoPath,
    });

    expect(hydrated.content).toBe('export const pathMode = 1;');
    expect(hydrated.path).toBe('src/path-mode.ts');
    expect(getLanguageFromFilename(hydrated.path)).toBe(SupportedLanguages.TypeScript);
  });

  it('rejects path-based inputs that escape the parent-approved repo root', () => {
    expect(() => resolveParseWorkerInputPath('/repo', '../outside.ts')).toThrow(
      'escapes repo root',
    );
    expect(() => resolveParseWorkerInputPath('/repo', '/repo/src/a.ts')).toThrow('repo-relative');
  });
});
