import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  BindingRef,
  ExplicitReceiver,
  GraphNode,
  GraphRelationship,
  ParsedFile,
  TypeRef,
} from 'ontoindex-shared';
import { SupportedLanguages } from 'ontoindex-shared';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { extractParsedFileOutcome } from '../../src/core/ingestion/scope-extractor-bridge.js';
import {
  decodeParsedFileRecord,
  encodeParsedFileRecord,
  encodeGraphNodeRecord,
  encodeGraphRelationshipRecord,
  ParsedFileRecordError,
  MAX_PARSED_FILE_RECORD_BYTES,
  MAX_GRAPH_RECORD_BYTES,
} from '../../src/core/ingestion/pipeline-phases/parse-scope-codec.js';
import {
  ScopeRetentionStage,
  type RetainedExportedType,
  type RetainedFileBinding,
  type ScopeRetentionFamily,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import {
  createResolutionContext,
  snapshotImportResolutionState,
} from '../../src/core/ingestion/model/resolution-context.js';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.js';
import type { ImportConfigObservations } from '../../src/core/ingestion/language-config.js';
import type {
  ExtractedAssignment,
  ExtractedCall,
  ExtractedORMQuery,
  FileConstructorBindings,
} from '../../src/core/ingestion/workers/parse-types.js';
import type { ExtractedHeritage } from '../../src/core/ingestion/model/heritage-map.js';
import {
  createSemanticModel,
  restoreSemanticModelRegistrations,
  type SemanticModelRegistrationEvent,
} from '../../src/core/ingestion/model/semantic-model.js';

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

describe('remaining parse extraction retention', () => {
  const cases = [
    [
      'fetch-calls',
      'captureFetchCalls',
      'iterateFetchCalls',
      { filePath: 'one.ts', fetchURL: '/api/é', lineNumber: 0 },
    ],
    [
      'routes',
      'captureRoutes',
      'iterateRoutes',
      {
        filePath: 'one.ts',
        httpMethod: 'GET',
        routePath: null,
        controllerName: null,
        methodName: 'list',
        middleware: ['auth', 'é'],
        prefix: null,
        lineNumber: 1,
      },
    ],
    [
      'decorator-routes',
      'captureDecoratorRoutes',
      'iterateDecoratorRoutes',
      {
        filePath: 'one.ts',
        httpMethod: 'GET',
        routePath: '/é',
        decoratorName: 'Get',
        lineNumber: 2,
      },
    ],
    [
      'tool-definitions',
      'captureToolDefinitions',
      'iterateToolDefinitions',
      { filePath: 'one.ts', toolName: 'search', description: 'é😀', lineNumber: 3 },
    ],
  ] as const;
  it.each(cases)(
    'roundtrips detached %s with bounded replay',
    async (family, capture, iterate, record) => {
      const stage = new ScopeRetentionStage(options(), { batchRecords: 1 });
      try {
        stage[capture]([record] as never);
        stage[capture]([record] as never);
        stage.markProducerCompleted(family);
        const batches = [];
        for await (const batch of stage[iterate]()) batches.push(batch);
        expect(batches).toEqual([[record], [record]]);
        expect(batches[0]![0]).not.toBe(record);
        expect(stage.producerCompletion[family]).toBe(true);
        expect(stage.seedReady).toBe(false);
      } finally {
        await stage.dispose();
      }
    },
  );
  it.each(cases)(
    'rejects malformed, proxy, and accessor %s without invoking user code',
    async (family, capture, iterate, record) => {
      const getter = vi.fn(() => record.filePath);
      const proxyTrap = vi.fn(() => {
        throw new Error('proxy trap');
      });
      const stage = new ScopeRetentionStage(options());
      try {
        const missing = { ...record } as Record<string, unknown>;
        delete missing.filePath;
        for (const bad of [
          missing,
          { ...record, extra: true },
          { ...record, lineNumber: -1 },
          new Proxy(record, { ownKeys: proxyTrap }),
          Object.defineProperty({ ...record }, 'filePath', { get: getter }),
        ]) {
          stage[capture]([bad] as never);
        }
        stage.markProducerCompleted(family);
        const retained = [];
        for await (const batch of stage[iterate]()) retained.push(...batch);
        expect(retained).toEqual([]);
        expect(getter).not.toHaveBeenCalled();
        expect(proxyTrap).not.toHaveBeenCalled();
        expect(stage.producerCompletion[family]).toBe(false);
      } finally {
        await stage.dispose();
      }
    },
  );
  it('rejects middleware accessors and proxies without reading them', async () => {
    const stage = new ScopeRetentionStage(options());
    const getter = vi.fn(() => 'auth');
    const record = cases[1][3];
    try {
      stage.captureRoutes([
        { ...record, middleware: Object.defineProperty([], '0', { get: getter }) },
      ]);
      stage.captureRoutes([{ ...record, middleware: new Proxy([], { get: getter }) }]);
      expect(getter).not.toHaveBeenCalled();
      expect(stage.routeRecordCount).toBe(0);
    } finally {
      await stage.dispose();
    }
  });
  it.each(cases)(
    'shares the record ceiling and byte allowance for %s',
    async (_family, capture, iterate, record) => {
      const request = options();
      const stage = new ScopeRetentionStage(request, { maxRecords: 1 });
      try {
        stage[capture]([record, record] as never);
        const retained = [];
        for await (const batch of stage[iterate]()) retained.push(...batch);
        expect(retained).toEqual([record]);
        expect(stage.reasons).toContain(`${_family}-count-limit`);
        expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024 - stage.bytes);
      } finally {
        await stage.dispose();
      }
      const bounded = new ScopeRetentionStage(options(), { maxRecordBytes: 1 });
      try {
        bounded[capture]([record] as never);
        expect(bounded.reasons).toContain(`${_family}-byte-limit`);
        expect(bounded.bytes).toBe(0);
      } finally {
        await bounded.dispose();
      }
    },
  );
});

describe('observed producer completion', () => {
  const families: ScopeRetentionFamily[] = [
    'parsed-files',
    'calls',
    'heritage',
    'assignments',
    'constructor-bindings',
    'exported-types',
    'file-bindings',
    'model-registrations',
    'import-states',
    'graph-nodes',
    'graph-relationships',
    'orm-queries',
    'fetch-calls',
    'routes',
    'decorator-routes',
    'tool-definitions',
  ];

  it('distinguishes untouched from completed empty output with detached frozen snapshots', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      const untouched = stage.producerCompletion;
      expect(Object.keys(untouched)).toEqual(families);
      expect(Object.values(untouched)).toEqual(families.map(() => false));
      for (const family of families) stage.markProducerCompleted(family);
      const completed = stage.producerCompletion;
      expect(Object.isFrozen(completed)).toBe(true);
      expect(completed).not.toBe(stage.producerCompletion);
      expect(Object.values(completed)).toEqual(families.map(() => true));
      expect(Object.values(untouched)).toEqual(families.map(() => false));
      expect(stage.graphNodesCaptured).toBe(true);
      expect(stage.graphRelationshipsCaptured).toBe(true);
      expect(stage.seedReady).toBe(false);

      stage.capture([]);
      stage.captureCalls([]);
      stage.captureHeritage([]);
      stage.captureAssignments([]);
      stage.captureORMQueries([]);
      stage.captureConstructorBindings([]);
      stage.captureExportedTypes([]);
      stage.captureFileBindings([]);
      expect(stage.producerCompletion).toEqual({
        'parsed-files': false,
        calls: false,
        heritage: false,
        assignments: false,
        'orm-queries': false,
        'fetch-calls': true,
        routes: true,
        'decorator-routes': true,
        'tool-definitions': true,
        'constructor-bindings': false,
        'exported-types': false,
        'file-bindings': false,
        'model-registrations': true,
        'import-states': true,
        'graph-nodes': true,
        'graph-relationships': true,
      });
      expect(Object.values(completed)).toEqual(families.map(() => true));
      stage.captureImportState(createResolutionContext());
      expect(stage.producerCompletion['import-states']).toBe(false);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['issue', 'input-issue', 'cancel', 'deadline', 'dispose'] as const)(
    'clears every reported completion on %s and refuses later marks',
    async (failure) => {
      const controller = new AbortController();
      const request = { ...options(), signal: controller.signal };
      const stage = new ScopeRetentionStage(request);
      try {
        for (const family of families) stage.markProducerCompleted(family);
        if (failure === 'issue') stage.markProducerIncomplete('file-bindings');
        if (failure === 'input-issue') stage.markParserCodeIdentityUnavailable();
        if (failure === 'cancel') controller.abort();
        if (failure === 'deadline') request.deadline = 0;
        if (failure === 'dispose') await stage.dispose();
        for (const family of families) stage.markProducerCompleted(family);
        expect(Object.values(stage.producerCompletion)).toEqual(families.map(() => false));
        expect(stage.graphNodesCaptured).toBe(false);
        expect(stage.graphRelationshipsCaptured).toBe(false);
        expect(stage.seedReady).toBe(false);
      } finally {
        await stage.dispose();
      }
    },
  );
});

function graphNodeFixture(): GraphNode {
  return {
    id: 'Function:src/é😀.ts:save',
    label: 'Function',
    properties: {
      name: 'save\\"\n\ud800',
      filePath: 'src/é😀.ts',
      startLine: 3,
      custom: {
        values: [null, true, 42, '界😀', { nested: 'value', omitted: undefined }],
        omitted: undefined,
      },
      omitted: undefined,
    },
  };
}

async function replayGraphNodes(stage: ScopeRetentionStage): Promise<GraphNode[]> {
  const nodes: GraphNode[] = [];
  for await (const batch of stage.iterateGraphNodes()) nodes.push(...batch);
  return nodes;
}

function graphRelationshipFixture(): GraphRelationship {
  return {
    id: 'edge:é😀\\"\n',
    sourceId: 'Class:one.ts:User',
    targetId: 'Method:one.ts:save',
    type: 'HAS_METHOD',
    confidence: 0.75,
    reason: 'structural\\"\n\ud800',
    step: 0,
    evidence: [
      { kind: 'declaration', weight: 0.75, note: '界😀' },
      { kind: 'syntax', weight: 0, note: undefined },
    ],
  };
}

async function replayGraphRelationships(stage: ScopeRetentionStage): Promise<GraphRelationship[]> {
  const edges: GraphRelationship[] = [];
  for await (const batch of stage.iterateGraphRelationships()) edges.push(...batch);
  return edges;
}

describe('observed parse structural graph relationship retention', () => {
  it('preserves evidence and step, projects undefined, and detaches producer and replay mutations', async () => {
    const input = graphRelationshipFixture();
    const expected = JSON.parse(JSON.stringify(input)) as GraphRelationship;
    const encoded = encodeGraphRelationshipRecord(input);
    expect(encoded).toBe(`${JSON.stringify({ version: 1, graphRelationship: expected })}\n`);
    expect(
      JSON.parse(encodeGraphRelationshipRecord({ ...input, step: undefined, evidence: undefined })),
    ).toEqual({
      version: 1,
      graphRelationship: {
        id: input.id,
        sourceId: input.sourceId,
        targetId: input.targetId,
        type: input.type,
        confidence: input.confidence,
        reason: input.reason,
      },
    });
    const request = options();
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    try {
      expect(stage.graphRelationshipsCaptured).toBe(false);
      stage.markGraphRelationshipsCaptured();
      expect(stage.graphRelationshipsCaptured).toBe(true);
      expect(await replayGraphRelationships(stage)).toEqual([]);
      expect(stage.captureGraphRelationship(input)).toBe(true);
      expect(stage.graphRelationshipsCaptured).toBe(false);
      expect(stage.captureGraphRelationship(input)).toBe(true);
      input.reason = 'producer mutation';
      (input.evidence as { kind: string }[])[0]!.kind = 'producer mutation';
      const batches: (readonly GraphRelationship[])[] = [];
      for await (const batch of stage.iterateGraphRelationships()) batches.push(batch);
      expect(batches).toEqual([[expected], [expected]]);
      expect(Object.hasOwn(batches[0]![0]!.evidence![1]!, 'note')).toBe(false);
      batches[0]![0]!.step = 99;
      (batches[0]![0]!.evidence as { kind: string }[])[0]!.kind = 'replay mutation';
      expect(await replayGraphRelationships(stage)).toEqual([expected, expected]);
      expect(stage.graphRelationshipRecordCount).toBe(2);
      expect(stage.graphRelationshipEvidenceScope).toBe('observed-parse-structural-graph');
      expect(stage.bytes).toBe(2 * Buffer.byteLength(encoded));
      stage.markGraphRelationshipsCaptured();
      expect(stage.graphRelationshipsCaptured).toBe(true);
      expect(stage.captureGraphRelationship(null)).toBe(false);
      stage.markGraphRelationshipsCaptured();
      expect(stage.graphRelationshipsCaptured).toBe(false);
      expect(stage.seedReady).toBe(false);
    } finally {
      await stage.dispose();
    }
    await stage.dispose();
    stage.markGraphRelationshipsCaptured();
    expect(stage.graphRelationshipsCaptured).toBe(false);
    expect(stage.graphRelationshipRecordCount).toBe(0);
    expect(await replayGraphRelationships(stage)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
  });

  it.each(['CALLS', 'ACCESSES'] as const)(
    'encodes %s but refuses its resolver-owned capture',
    async (type) => {
      const input = { ...graphRelationshipFixture(), type, reason: 'write' };
      expect(JSON.parse(encodeGraphRelationshipRecord(input)).graphRelationship.type).toBe(type);
      const request = options();
      const stage = new ScopeRetentionStage(request);
      try {
        stage.markGraphRelationshipsCaptured();
        expect(stage.captureGraphRelationship(input)).toBe(false);
        stage.markGraphRelationshipsCaptured();
        expect(stage.graphRelationshipsCaptured).toBe(false);
        expect(stage.graphRelationshipRecordCount).toBe(0);
        expect(stage.status).toBe('incomplete');
        expect(stage.reasons.some((reason) => reason.startsWith('graph-relationship-'))).toBe(true);
        expect(await replayGraphRelationships(stage)).toEqual([]);
        expect(stage.bytes).toBe(0);
        expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      } finally {
        await stage.dispose();
      }
    },
  );

  it('counts envelope, escaping, Unicode and newline at the exact byte boundary', async () => {
    const input = graphRelationshipFixture();
    const encoded = encodeGraphRelationshipRecord(input);
    const bytes = Buffer.byteLength(encoded);
    expect(bytes).toBeGreaterThan(encoded.length);
    expect(encodeGraphRelationshipRecord(input, bytes)).toBe(encoded);
    expect(() => encodeGraphRelationshipRecord(input, bytes - 1)).toThrow(ParsedFileRecordError);
    for (const allowance of [bytes - 1, bytes]) {
      const request = options(allowance);
      const stage = new ScopeRetentionStage(request, { maxRecordBytes: bytes, batchBytes: bytes });
      try {
        expect(stage.captureGraphRelationship(input)).toBe(allowance === bytes);
        expect(stage.bytes).toBe(allowance === bytes ? bytes : 0);
        expect(request.artifactAllowance.remainingBytes).toBe(allowance === bytes ? 0 : allowance);
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    }
  });

  it('rejects malformed fields, accessors and proxies without executing user code', async () => {
    const getter = vi.fn(() => 'hidden');
    const proxyTrap = vi.fn(() => {
      throw new Error('proxy executed');
    });
    const input = graphRelationshipFixture();
    const invalid: unknown[] = [
      null,
      [],
      new Date(),
      ...['id', 'sourceId', 'targetId', 'reason'].flatMap((key) => [
        { ...input, [key]: undefined },
        { ...input, [key]: 1 },
      ]),
      ...[undefined, '0.5', NaN, Infinity, -0].map((confidence) => ({ ...input, confidence })),
      ...[-0, Infinity, NaN, '1', null].map((step) => ({ ...input, step })),
      { ...input, type: 'NOT_A_RELATIONSHIP' },
      { ...input, extra: true },
      { ...input, evidence: {} },
      { ...input, evidence: new Array(1) },
      ...[
        { kind: 1, weight: 1 },
        { kind: 'x', weight: Infinity },
        { kind: 'x', weight: '1' },
        { kind: 'x', weight: 1, note: null },
        { kind: 'x', weight: 1, extra: true },
      ].map((item) => ({ ...input, evidence: [item] })),
      Object.defineProperty({ ...input }, 'reason', { enumerable: true, get: getter }),
      {
        ...input,
        evidence: [Object.defineProperty({ weight: 1 }, 'kind', { enumerable: true, get: getter })],
      },
      new Proxy(input, { ownKeys: proxyTrap }),
      { ...input, evidence: [new Proxy({}, { ownKeys: proxyTrap })] },
    ];
    const stage = new ScopeRetentionStage(options());
    try {
      for (const edge of invalid) {
        expect(() => encodeGraphRelationshipRecord(edge)).toThrow(ParsedFileRecordError);
        expect(stage.captureGraphRelationship(edge)).toBe(false);
      }
      expect(stage.graphRelationshipRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(getter).not.toHaveBeenCalled();
      expect(proxyTrap).not.toHaveBeenCalled();
    } finally {
      await stage.dispose();
    }
  });

  it('bounds record bytes, structural work and lifetime admission attempts', async () => {
    const input = graphRelationshipFixture();
    let deep: unknown = null;
    for (let depth = 0; depth < 65; depth++) deep = { nested: deep };
    for (const edge of [
      { ...input, reason: 'x'.repeat(256 * 1024) },
      { ...input, evidence: Array.from({ length: 34_000 }, () => ({ kind: 'x', weight: 1 })) },
      { ...input, evidence: [{ kind: 'x', weight: 1, note: deep }] },
    ]) {
      expect(() => encodeGraphRelationshipRecord(edge)).toThrow(ParsedFileRecordError);
    }
    const stage = new ScopeRetentionStage(options(), { maxRecords: 3, maxRecordBytes: 512 });
    try {
      expect(stage.captureGraphRelationship(input)).toBe(true);
      expect(stage.captureGraphRelationship(null)).toBe(false);
      expect(stage.captureGraphRelationship({ ...input, reason: 'x'.repeat(513) })).toBe(false);
      expect(stage.captureGraphRelationship(input)).toBe(false);
      expect(stage.reasons).toContain('graph-relationship-count-limit');
      expect(await replayGraphRelationships(stage)).toEqual([JSON.parse(JSON.stringify(input))]);
    } finally {
      await stage.dispose();
    }
  });

  const captureFamily = (
    stage: ScopeRetentionStage,
    family: 'node' | 'scope' | 'model' | 'import',
  ) => {
    if (family === 'node') stage.captureGraphNode(graphNodeFixture());
    if (family === 'scope') stage.capture([fixture('one.ts')]);
    if (family === 'model') stage.captureModelRegistration(modelRegistrationFixture());
    if (family === 'import') stage.captureImportState(createResolutionContext());
  };

  it.each(['node', 'scope', 'model', 'import'] as const)(
    'shares record limits and exact bytes with %s in both directions',
    async (family) => {
      const probe = new ScopeRetentionStage(options());
      captureFamily(probe, family);
      const totalBytes =
        probe.bytes + Buffer.byteLength(encodeGraphRelationshipRecord(graphRelationshipFixture()));
      await probe.dispose();
      for (const edgeFirst of [false, true]) {
        for (const maxRecords of [1, 2]) {
          const request = options(totalBytes);
          const stage = new ScopeRetentionStage(request, { maxRecords, maxBytes: totalBytes });
          try {
            if (edgeFirst)
              expect(stage.captureGraphRelationship(graphRelationshipFixture())).toBe(true);
            captureFamily(stage, family);
            if (!edgeFirst)
              expect(stage.captureGraphRelationship(graphRelationshipFixture())).toBe(
                maxRecords === 2,
              );
            expect(stage.graphRelationshipRecordCount).toBe(edgeFirst || maxRecords === 2 ? 1 : 0);
            const otherCount = {
              node: stage.graphNodeRecordCount,
              scope: stage.recordCount,
              model: stage.modelRegistrationRecordCount,
              import: stage.importStateRecordCount,
            }[family];
            expect(otherCount).toBe(!edgeFirst || maxRecords === 2 ? 1 : 0);
            if (maxRecords === 2) {
              expect(stage.bytes).toBe(totalBytes);
              expect(request.artifactAllowance.remainingBytes).toBe(0);
            } else expect(stage.status).toBe('incomplete');
          } finally {
            await stage.dispose();
          }
          expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
        }
      }
    },
  );

  it('shares the replay mutex with all retained families and releases it on iterator return', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.captureGraphRelationship(graphRelationshipFixture());
      for (const family of ['node', 'scope', 'model', 'import'] as const)
        captureFamily(stage, family);
      const iterator = stage.iterateGraphRelationships()[Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(false);
      for (const other of [
        stage.iterateGraphNodes(),
        stage.iterate(),
        stage.iterateCalls(),
        stage.iterateHeritage(),
        stage.iterateAssignments(),
        stage.iterateConstructorBindings(),
        stage.iterateExportedTypes(),
        stage.iterateFileBindings(),
        stage.iterateModelRegistrations(),
        stage.iterateImportStates(),
      ]) {
        await expect(other[Symbol.asyncIterator]().next()).rejects.toMatchObject({
          reason: 'concurrent-replay',
        });
      }
      await iterator.return?.();
      for (const other of [
        stage.iterateGraphNodes(),
        stage.iterate(),
        stage.iterateModelRegistrations(),
        stage.iterateImportStates(),
      ]) {
        const active = other[Symbol.asyncIterator]();
        expect((await active.next()).done).toBe(false);
        await expect(
          stage.iterateGraphRelationships()[Symbol.asyncIterator]().next(),
        ).rejects.toMatchObject({ reason: 'concurrent-replay' });
        await active.return?.();
      }
      expect(await replayGraphRelationships(stage)).toHaveLength(1);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'stops capture and suspended replay after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage(
        { ...request, signal: controller.signal },
        { batchRecords: 1 },
      );
      try {
        stage.captureGraphRelationship(graphRelationshipFixture());
        stage.captureGraphRelationship(graphRelationshipFixture());
        stage.markGraphRelationshipsCaptured();
        const iterator = stage.iterateGraphRelationships()[Symbol.asyncIterator]();
        expect((await iterator.next()).done).toBe(false);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') await stage.dispose();
        expect(stage.captureGraphRelationship(graphRelationshipFixture())).toBe(false);
        stage.markGraphRelationshipsCaptured();
        expect(stage.graphRelationshipsCaptured).toBe(false);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.reasons).toContain(guard);
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('rechecks cancellation before yielding the first relationship batch', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage({ ...options(), signal: controller.signal });
    try {
      stage.captureGraphRelationship(graphRelationshipFixture());
      const next = stage.iterateGraphRelationships()[Symbol.asyncIterator]().next();
      controller.abort();
      expect((await next).done).toBe(true);
    } finally {
      await stage.dispose();
    }
  });
});

describe('observed parse graph node retention', () => {
  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'invalidates completed graph markers immediately after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage({ ...request, signal: controller.signal });
      let disposal: Promise<void> | undefined;
      try {
        expect(stage.captureGraphNode(graphNodeFixture())).toBe(true);
        expect(stage.captureGraphRelationship(graphRelationshipFixture())).toBe(true);
        stage.markGraphNodesCaptured();
        stage.markGraphRelationshipsCaptured();
        expect(stage.graphNodesCaptured).toBe(true);
        expect(stage.graphRelationshipsCaptured).toBe(true);

        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') disposal = stage.dispose();

        expect(stage.graphNodesCaptured).toBe(false);
        expect(stage.graphRelationshipsCaptured).toBe(false);
        expect(await replayGraphNodes(stage)).toEqual([]);
        expect(await replayGraphRelationships(stage)).toEqual([]);
        expect(stage.reasons).toContain(guard);
      } finally {
        vi.restoreAllMocks();
        await (disposal ?? stage.dispose());
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('distinguishes an explicitly completed empty graph and invalidates completion on new capture', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      expect(stage.graphNodesCaptured).toBe(false);
      stage.markGraphNodesCaptured();
      expect(stage.graphNodesCaptured).toBe(true);
      expect(await replayGraphNodes(stage)).toEqual([]);
      expect(stage.captureGraphNode(graphNodeFixture())).toBe(true);
      expect(stage.graphNodesCaptured).toBe(false);
      stage.markGraphNodesCaptured();
      expect(stage.graphNodesCaptured).toBe(true);
      expect(stage.captureGraphNode(null)).toBe(false);
      stage.markGraphNodesCaptured();
      expect(stage.graphNodesCaptured).toBe(false);
      expect(stage.seedReady).toBe(false);
    } finally {
      await stage.dispose();
    }
  });

  it('projects extensible JSON properties exactly and detaches producer and replay mutations', async () => {
    const input = graphNodeFixture();
    const expected = JSON.parse(JSON.stringify(input)) as GraphNode;
    const encoded = encodeGraphNodeRecord(input);
    expect(encoded).toBe(`${JSON.stringify({ version: 1, graphNode: expected })}\n`);
    const request = options();
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    try {
      expect(stage.captureGraphNode(input)).toBe(true);
      expect(stage.captureGraphNode(input)).toBe(true);
      input.properties.name = 'producer mutation';
      (input.properties.custom as { values: unknown[] }).values.length = 0;
      const batches: (readonly GraphNode[])[] = [];
      for await (const batch of stage.iterateGraphNodes()) batches.push(batch);
      expect(batches).toEqual([[expected], [expected]]);
      expect(Object.hasOwn(batches[0]![0]!.properties, 'omitted')).toBe(false);
      batches[0]![0]!.properties.name = 'replay mutation';
      (batches[0]![0]!.properties.custom as { values: unknown[] }).values.length = 0;
      expect(await replayGraphNodes(stage)).toEqual([expected, expected]);
      expect(stage.graphNodeRecordCount).toBe(2);
      expect(stage.graphNodeEvidenceScope).toBe('observed-parse-graph');
      expect(stage.seedReady).toBe(false);
      expect(stage.bytes).toBe(2 * Buffer.byteLength(encoded));
    } finally {
      await stage.dispose();
    }
    await stage.dispose();
    expect(stage.graphNodeRecordCount).toBe(0);
    expect(await replayGraphNodes(stage)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
  });

  it('counts the envelope, newline, escapes and Unicode at the exact byte boundary', async () => {
    const input = graphNodeFixture();
    const encoded = encodeGraphNodeRecord(input);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    expect(bytes).toBeGreaterThan(encoded.length);
    expect(encodeGraphNodeRecord(input, bytes)).toBe(encoded);
    expect(() => encodeGraphNodeRecord(input, bytes - 1)).toThrow(ParsedFileRecordError);
    for (const allowance of [bytes - 1, bytes]) {
      const request = options(allowance);
      const stage = new ScopeRetentionStage(request, { maxRecordBytes: bytes, batchBytes: bytes });
      try {
        expect(stage.captureGraphNode(input)).toBe(allowance === bytes);
        expect(stage.bytes).toBe(allowance === bytes ? bytes : 0);
        expect(request.artifactAllowance.remainingBytes).toBe(allowance === bytes ? 0 : allowance);
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    }
  });

  it('rejects unsafe node properties without invoking user code', async () => {
    const getter = vi.fn(() => 'hidden');
    const proxyTrap = vi.fn(() => {
      throw new Error('proxy executed');
    });
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(1);
    const customArray = Object.assign([1], { extra: true });
    const unsupported = [
      undefined,
      1n,
      Symbol('value'),
      () => 1,
      -0,
      Infinity,
      NaN,
      accessor,
      cycle,
      sparse,
      customArray,
      new Date(),
      new Map(),
      Object.create({ inherited: true }),
      new Proxy({}, { ownKeys: proxyTrap }),
    ];
    const invalid: unknown[] = unsupported.map((value) => ({
      ...graphNodeFixture(),
      properties: { name: 'save', filePath: 'one.ts', extra: [value] },
    }));
    invalid.push(
      { ...graphNodeFixture(), properties: { name: undefined, filePath: 'one.ts' } },
      { ...graphNodeFixture(), properties: { name: 'save', filePath: undefined } },
      new Proxy(graphNodeFixture(), { ownKeys: proxyTrap }),
    );
    const stage = new ScopeRetentionStage(options());
    try {
      for (const node of invalid) {
        expect(() => encodeGraphNodeRecord(node)).toThrow(ParsedFileRecordError);
        expect(stage.captureGraphNode(node)).toBe(false);
      }
      expect(stage.graphNodeRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(await replayGraphNodes(stage)).toEqual([]);
      expect(getter).not.toHaveBeenCalled();
      expect(proxyTrap).not.toHaveBeenCalled();
    } finally {
      await stage.dispose();
    }
  });

  it('bounds depth, work, record bytes and cumulative failed admission attempts', async () => {
    let deep: unknown = null;
    for (let depth = 0; depth < 65; depth++) deep = { nested: deep };
    const wide = Array.from({ length: 34_000 }, () => [0]);
    for (const extra of [deep, wide, 'x'.repeat(256 * 1024)]) {
      expect(() =>
        encodeGraphNodeRecord({
          ...graphNodeFixture(),
          properties: { name: 'save', filePath: 'one.ts', extra },
        }),
      ).toThrow(ParsedFileRecordError);
    }
    const stage = new ScopeRetentionStage(options(), { maxRecords: 3, maxRecordBytes: 512 });
    try {
      expect(stage.captureGraphNode(graphNodeFixture())).toBe(true);
      expect(stage.captureGraphNode(null)).toBe(false);
      expect(
        stage.captureGraphNode({
          ...graphNodeFixture(),
          properties: { name: 'x'.repeat(513), filePath: 'one.ts' },
        }),
      ).toBe(false);
      expect(stage.captureGraphNode(graphNodeFixture())).toBe(false);
      expect(stage.reasons).toContain('graph-node-count-limit');
      expect(await replayGraphNodes(stage)).toEqual([
        JSON.parse(JSON.stringify(graphNodeFixture())),
      ]);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['scope', 'model', 'import'] as const)(
    'shares record admission with %s in both directions',
    async (family) => {
      for (const graphFirst of [false, true]) {
        const stage = new ScopeRetentionStage(options(), { maxRecords: 1 });
        const capture = () => {
          if (family === 'scope') stage.capture([fixture('one.ts')]);
          if (family === 'model') stage.captureModelRegistration(modelRegistrationFixture());
          if (family === 'import') stage.captureImportState(createResolutionContext());
        };
        try {
          if (graphFirst) expect(stage.captureGraphNode(graphNodeFixture())).toBe(true);
          capture();
          if (!graphFirst) expect(stage.captureGraphNode(graphNodeFixture())).toBe(false);
          expect(stage.graphNodeRecordCount).toBe(graphFirst ? 1 : 0);
          expect(
            {
              scope: stage.recordCount,
              model: stage.modelRegistrationRecordCount,
              import: stage.importStateRecordCount,
            }[family],
          ).toBe(graphFirst ? 0 : 1);
          expect(stage.status).toBe('incomplete');
        } finally {
          await stage.dispose();
        }
      }
    },
  );

  it.each(['scope', 'model', 'import'] as const)(
    'shares aggregate bytes and allowance with %s in both directions',
    async (family) => {
      const capture = (stage: ScopeRetentionStage) => {
        if (family === 'scope') stage.capture([fixture('one.ts')]);
        if (family === 'model') stage.captureModelRegistration(modelRegistrationFixture());
        if (family === 'import') stage.captureImportState(createResolutionContext());
      };
      const probe = new ScopeRetentionStage(options());
      capture(probe);
      const totalBytes = probe.bytes + Buffer.byteLength(encodeGraphNodeRecord(graphNodeFixture()));
      await probe.dispose();
      for (const graphFirst of [false, true]) {
        const request = options(totalBytes);
        const stage = new ScopeRetentionStage(request, { maxBytes: totalBytes });
        try {
          if (graphFirst) expect(stage.captureGraphNode(graphNodeFixture())).toBe(true);
          capture(stage);
          if (!graphFirst) expect(stage.captureGraphNode(graphNodeFixture())).toBe(true);
          expect(stage.bytes).toBe(totalBytes);
          expect(request.artifactAllowance.remainingBytes).toBe(0);
          expect(stage.captureGraphNode(graphNodeFixture())).toBe(false);
          expect(stage.bytes).toBe(totalBytes);
        } finally {
          await stage.dispose();
        }
        expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
      }
    },
  );

  it('shares replay exclusion with every retained family in both directions', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.captureGraphNode(graphNodeFixture());
      stage.capture([fixture('one.ts')]);
      stage.captureModelRegistration(modelRegistrationFixture());
      stage.captureImportState(createResolutionContext());
      const families = () => [
        stage.iterate(),
        stage.iterateCalls(),
        stage.iterateHeritage(),
        stage.iterateAssignments(),
        stage.iterateConstructorBindings(),
        stage.iterateExportedTypes(),
        stage.iterateFileBindings(),
        stage.iterateModelRegistrations(),
        stage.iterateImportStates(),
      ];
      const graph = stage.iterateGraphNodes()[Symbol.asyncIterator]();
      expect((await graph.next()).done).toBe(false);
      for (const other of families()) {
        await expect(other[Symbol.asyncIterator]().next()).rejects.toMatchObject({
          reason: 'concurrent-replay',
        });
      }
      await graph.return?.();
      for (const other of [
        stage.iterate(),
        stage.iterateModelRegistrations(),
        stage.iterateImportStates(),
      ]) {
        const iterator = other[Symbol.asyncIterator]();
        expect((await iterator.next()).done).toBe(false);
        await expect(
          stage.iterateGraphNodes()[Symbol.asyncIterator]().next(),
        ).rejects.toMatchObject({ reason: 'concurrent-replay' });
        await iterator.return?.();
      }
      expect(await replayGraphNodes(stage)).toHaveLength(1);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'stops capture and suspended graph replay after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage(
        { ...request, signal: controller.signal },
        { batchRecords: 1 },
      );
      try {
        stage.captureGraphNode(graphNodeFixture());
        stage.captureGraphNode(graphNodeFixture());
        const iterator = stage.iterateGraphNodes()[Symbol.asyncIterator]();
        expect((await iterator.next()).done).toBe(false);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') await stage.dispose();
        expect(stage.captureGraphNode(graphNodeFixture())).toBe(false);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.reasons).toContain(guard);
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('rechecks cancellation before yielding its first graph batch', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage({ ...options(), signal: controller.signal });
    try {
      stage.captureGraphNode(graphNodeFixture());
      const next = stage.iterateGraphNodes()[Symbol.asyncIterator]().next();
      controller.abort();
      expect((await next).done).toBe(true);
    } finally {
      await stage.dispose();
    }
  });
});

describe('retained final import state', () => {
  it('rebuilds aliased resolution from both retained families after the producer clears', async () => {
    const stage = new ScopeRetentionStage(options());
    const original = createResolutionContext({
      onRegistration: (encoded) => stage.captureModelRegistration(encoded),
      onRegistrationError: () => stage.markModelRegistrationsIncomplete(),
    });
    original.model.symbols.add('model.ts', 'User', 'class:user', 'Class');
    original.model.symbols.add('other.ts', 'User', 'class:decoy', 'Class');
    original.importMap.set('app.ts', new Set(['model.ts']));
    original.namedImportMap.set(
      'app.ts',
      new Map([['Alias', { sourcePath: 'model.ts', exportedName: 'User' }]]),
    );
    const expected = original.resolve('Alias', 'app.ts');
    expect(expected?.candidates.map((candidate) => candidate.nodeId)).toEqual(['class:user']);
    stage.captureImportState(original);
    const events = await replayModelRegistrations(stage);
    const imports = [];
    for await (const batch of stage.iterateImportStates()) imports.push(...batch);
    await stage.dispose();
    original.clear();
    const replayed = createResolutionContext({
      model: restoreSemanticModelRegistrations({ version: 1, events }),
      importState: imports[0]!,
    });
    expect(replayed.resolve('Alias', 'app.ts')).toEqual(expected);
    expect(replayed.getStats().cacheHits).toBe(0);
    expect(stage.seedReady).toBe(false);
  });

  it('preserves all map families and detaches producer and replay mutations', async () => {
    const request = options();
    const stage = new ScopeRetentionStage(request);
    const ctx = createResolutionContext();
    ctx.importMap.set('a.ts', new Set(['b.ts']));
    ctx.packageMap.set('a.ts', new Set(['/pkg/']));
    ctx.namedImportMap.set(
      'a.ts',
      new Map([['Alias', { sourcePath: 'b.ts', exportedName: 'User' }]]),
    );
    ctx.moduleAliasMap.set('a.ts', new Map([['mod', 'b.ts']]));
    ctx.importMap.set('empty.ts', new Set());
    const expected = snapshotImportResolutionState(ctx);
    stage.captureImportState(ctx);
    expect(stage.importStateRecordCount).toBe(1);
    expect(stage.importStateEvidenceScope).toBe('observed-resolution-inputs');
    expect(stage.bytes).toBe(Buffer.byteLength(JSON.stringify(expected), 'utf8'));
    ctx.clear();
    const first = [];
    for await (const batch of stage.iterateImportStates()) first.push(...batch);
    expect(first).toEqual([expected]);
    first[0]!.importMap.length = 0;
    const second = [];
    for await (const batch of stage.iterateImportStates()) second.push(...batch);
    expect(second).toEqual([expected]);
    expect(stage.seedReady).toBe(false);
    await stage.dispose();
    expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
  });

  it('shares record admission in both directions and refuses duplicate snapshots', async () => {
    const ctx = createResolutionContext();
    const first = new ScopeRetentionStage(options(), { maxRecords: 1 });
    first.captureImportState(ctx);
    expect(first.captureModelRegistration('{"kind":"model.clear"}')).toBe(false);
    first.captureImportState(ctx);
    expect(first.reasons).toContain('import-state-duplicate');
    const second = new ScopeRetentionStage(options(), { maxRecords: 1 });
    expect(second.captureModelRegistration('{"kind":"model.clear"}')).toBe(true);
    second.captureImportState(ctx);
    expect(second.importStateRecordCount).toBe(0);
    expect(second.reasons).toContain('import-state-count-limit');
    await first.dispose();
    await second.dispose();
  });

  it('admits exact bytes and refuses overflow without changing live resolution', async () => {
    const ctx = createResolutionContext();
    ctx.importMap.set('a.ts', new Set(['b.ts']));
    const bytes = Buffer.byteLength(JSON.stringify(snapshotImportResolutionState(ctx)), 'utf8');
    const request = options(bytes);
    const exact = new ScopeRetentionStage(request);
    exact.captureImportState(ctx);
    expect(exact.importStateRecordCount).toBe(1);
    expect(request.artifactAllowance.remainingBytes).toBe(0);
    const limitedRequest = options(bytes - 1);
    const limited = new ScopeRetentionStage(limitedRequest);
    limited.captureImportState(ctx);
    expect(limited.importStateRecordCount).toBe(0);
    expect(limited.reasons).toContain('import-state-incomplete');
    expect(limitedRequest.artifactAllowance.remainingBytes).toBe(bytes - 1);
    expect([...ctx.importMap.get('a.ts')!]).toEqual(['b.ts']);
    await exact.dispose();
    await limited.dispose();
    expect(request.artifactAllowance.remainingBytes).toBe(bytes);
  });

  it('keeps scope disk accounting, replay exclusion and cancellation intact', async () => {
    const controller = new AbortController();
    const request = { ...options(), signal: controller.signal };
    const stage = new ScopeRetentionStage(request);
    stage.capture([fixture()]);
    stage.captureImportState(createResolutionContext());
    await stage.flush();
    const imports = stage.iterateImportStates()[Symbol.asyncIterator]();
    expect((await imports.next()).done).toBe(false);
    await expect(stage.iterate().next()).rejects.toThrow();
    await imports.return?.();
    const files = [];
    for await (const batch of stage.iterate()) files.push(...batch);
    expect(files).toEqual([fixture()]);
    controller.abort();
    const cancelled = [];
    for await (const batch of stage.iterateImportStates()) cancelled.push(...batch);
    expect(cancelled).toEqual([]);
    expect(stage.reasons).toContain('cancelled');
    await stage.dispose();
    expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
  });
});

async function replay(stage: ScopeRetentionStage): Promise<ParsedFile[]> {
  const files: ParsedFile[] = [];
  for await (const batch of stage.iterate()) files.push(...batch);
  return files;
}

function callFixture(): ExtractedCall {
  return {
    filePath: 'one.ts',
    calledName: 'save',
    sourceId: 'Function:one.ts:caller',
    callForm: 'member',
    argCount: 3,
    receiverName: 'service',
    receiverMixedChain: [
      { kind: 'call', name: 'getUser' },
      { kind: 'field', name: 'profile' },
    ],
    argTypes: [undefined, 'string', undefined],
  };
}

async function replayCalls(stage: ScopeRetentionStage): Promise<ExtractedCall[]> {
  const calls: ExtractedCall[] = [];
  for await (const batch of stage.iterateCalls()) calls.push(...batch);
  return calls;
}

describe('original parser call retention', () => {
  it('detaches whole-call and multiline receiver-call ranges across capture and replay', async () => {
    const stage = new ScopeRetentionStage(options());
    const call: ExtractedCall = {
      ...callFixture(),
      atRange: { startLine: 2, startCol: 0, endLine: 4, endCol: 1 },
      receiverMixedChain: [
        {
          kind: 'call',
          name: 'getUser',
          atRange: { startLine: 2, startCol: 0, endLine: 3, endCol: 5 },
        },
        { kind: 'field', name: 'profile' },
        {
          kind: 'call',
          name: 'normalize',
          atRange: { startLine: 3, startCol: 6, endLine: 3, endCol: 17 },
        },
      ],
    };
    const expected = structuredClone(call);
    try {
      stage.captureCalls([call]);
      Reflect.set(call.atRange!, 'endLine', 20);
      const step = call.receiverMixedChain![0]!;
      if (step.kind === 'call') Reflect.set(step.atRange!, 'startCol', 20);
      const first = await replayCalls(stage);
      expect(first).toEqual([expected]);
      Reflect.set(first[0]!.atRange!, 'endLine', 30);
      const replayedStep = first[0]!.receiverMixedChain![0]!;
      if (replayedStep.kind === 'call') Reflect.set(replayedStep.atRange!, 'startCol', 30);
      expect(await replayCalls(stage)).toEqual([expected]);
    } finally {
      await stage.dispose();
    }
  });

  const validCallRange = { startLine: 2, startCol: 1, endLine: 2, endCol: 8 };
  const malformedCallRanges: unknown[] = [
    null,
    [],
    {},
    { ...validCallRange, extra: true },
    ...['startLine', 'startCol', 'endLine', 'endCol'].flatMap((key) => [
      ...[NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, -1, -0, '2', undefined].map(
        (value) => ({ ...validCallRange, [key]: value }),
      ),
      Object.fromEntries(Object.entries(validCallRange).filter(([name]) => name !== key)),
    ]),
    { ...validCallRange, startLine: 0 },
    { ...validCallRange, endLine: 0 },
    { ...validCallRange, endLine: 1 },
    { ...validCallRange, endCol: 0 },
    { ...validCallRange, endCol: 1 },
  ];
  it.each(
    malformedCallRanges.flatMap((atRange) => [
      { ...callFixture(), atRange },
      { ...callFixture(), receiverMixedChain: [{ kind: 'call', name: 'getUser', atRange }] },
    ]),
  )('rejects malformed call ranges without reserving bytes: %j', async (call) => {
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureCalls([call as unknown as ExtractedCall]);
      expect(stage.callRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.reasons).toContain('call-invalid');
    } finally {
      await stage.dispose();
    }
  });

  it.each(['call', 'step'] as const)(
    'rejects unsafe %s range objects without invoking accessors or proxy traps',
    async (location) => {
      let reads = 0;
      const getter = () => {
        reads++;
        return 2;
      };
      const unsafe = [
        new Proxy(validCallRange, {
          get() {
            reads++;
            throw new Error('proxy read');
          },
        }),
        Object.defineProperty({ ...validCallRange }, 'startLine', { get: getter }),
        Object.assign(
          Object.create({
            get startLine() {
              return getter();
            },
          }),
          { startCol: 1, endLine: 2, endCol: 8 },
        ),
      ];
      const stage = new ScopeRetentionStage(options());
      try {
        for (const atRange of unsafe) {
          stage.captureCalls([
            location === 'call'
              ? { ...callFixture(), atRange }
              : {
                  ...callFixture(),
                  receiverMixedChain: [{ kind: 'call', name: 'getUser', atRange }],
                },
          ]);
        }
        expect(reads).toBe(0);
        expect(stage.callRecordCount).toBe(0);
        expect(stage.reasons).toContain('call-invalid');
      } finally {
        await stage.dispose();
      }
    },
  );

  it('accepts an explicitly undefined receiver-call range and includes range bytes in admission', async () => {
    const call: ExtractedCall = {
      ...callFixture(),
      receiverMixedChain: [{ kind: 'call', name: 'getUser', atRange: undefined }],
    };
    const probe = new ScopeRetentionStage(options());
    let bytes: number;
    try {
      probe.captureCalls([call]);
      expect(await replayCalls(probe)).toEqual([
        {
          ...call,
          receiverMixedChain: [{ kind: 'call', name: 'getUser' }],
        },
      ]);
      bytes = probe.bytes;
    } finally {
      await probe.dispose();
    }
    const stage = new ScopeRetentionStage(options(), { maxRecordBytes: bytes });
    try {
      stage.captureCalls([{ ...call, atRange: validCallRange }]);
      expect(stage.callRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(stage.reasons).toContain('call-byte-limit');
    } finally {
      await stage.dispose();
    }
  });

  it('detaches nested calls before enrichment and producer cleanup, and isolates every replay', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    const calls = [callFixture(), { ...callFixture(), receiverTypeName: 'Original' }];
    const expected = structuredClone(calls);
    try {
      stage.captureCalls(calls);
      calls[0]!.receiverTypeName = 'Enriched';
      calls[0]!.receiverMixedChain![0]!.name = 'changed';
      calls[0]!.argTypes![1] = 'number';
      calls.length = 0;
      const batches: (readonly ExtractedCall[])[] = [];
      for await (const batch of stage.iterateCalls()) batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
      expect(batches.flat()).toEqual(expected);
      expect(Object.hasOwn(batches[0]![0]!, 'receiverTypeName')).toBe(false);
      expect(batches[0]![0]!.argTypes).toEqual([undefined, 'string', undefined]);
      expect(Object.hasOwn(batches[0]![0]!.argTypes!, 0)).toBe(true);
      batches[0]![0]!.receiverMixedChain![0]!.name = 'replay mutation';
      batches[0]![0]!.argTypes![0] = 'boolean';
      expect(await replayCalls(stage)).toEqual(expected);
      expect(stage.callRecordCount).toBe(2);
      expect(stage.recordCount).toBe(0);
      expect(stage.callEvidenceScope).toBe('observed-parser-inputs');
      expect(stage.seedReady).toBe(false);
      expect(request.artifactAllowance.remainingBytes).toBeLessThan(allowance);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    await stage.dispose();
    stage.captureCalls([callFixture()]);
    expect(await replayCalls(stage)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('accepts zero observed calls without claiming complete CALLS evidence', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.captureCalls([]);
      stage.reconcile([]);
      expect(stage.callRecordCount).toBe(0);
      expect(stage.callEvidenceScope).toBe('observed-parser-inputs');
      expect(stage.seedReady).toBe(false);
      expect(await replayCalls(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['scope first', 'call first'] as const)(
    'shares the record ceiling with scopes: %s',
    async (order) => {
      const stage = new ScopeRetentionStage(options(), { maxRecords: 1 });
      try {
        if (order === 'scope first') {
          stage.capture([fixture('one.ts')]);
          stage.captureCalls([{ ...callFixture(), argTypes: [] }]);
        } else {
          stage.captureCalls([{ ...callFixture(), argTypes: [] }]);
          stage.capture([fixture('one.ts')]);
        }
        expect(stage.callRecordCount + stage.recordCount).toBe(1);
        expect(stage.callRecordCount).toBe(order === 'call first' ? 1 : 0);
        expect(stage.status).toBe('incomplete');
        expect(stage.reasons).toContain(
          order === 'scope first' ? 'call-count-limit' : 'record-count-limit',
        );
        expect(stage.seedReady).toBe(false);
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['allowance', 'aggregate bytes', 'record bytes'] as const)(
    'refuses calls above the %s ceiling',
    async (ceiling) => {
      const request = options(ceiling === 'allowance' ? 0 : 1024 * 1024);
      const allowance = request.artifactAllowance.remainingBytes;
      const stage = new ScopeRetentionStage(
        request,
        ceiling === 'aggregate bytes'
          ? { maxBytes: 1 }
          : ceiling === 'record bytes'
            ? { maxRecordBytes: 1 }
            : undefined,
      );
      try {
        stage.captureCalls([callFixture()]);
        expect(stage.callRecordCount).toBe(0);
        expect(stage.status).toBe('incomplete');
        expect(stage.reasons).toContain('call-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    },
  );

  it.each([
    { ...callFixture(), unexpected: true },
    { ...callFixture(), argCount: -1 },
    { ...callFixture(), receiverMixedChain: [{ kind: 'call', name: 'getUser', unexpected: true }] },
    {
      ...callFixture(),
      receiverMixedChain: [{ kind: 'field', name: 'profile', atRange: validCallRange }],
    },
    {
      ...callFixture(),
      receiverMixedChain: [{ kind: 'field', name: 'profile', atRange: undefined }],
    },
    { ...callFixture(), argTypes: [null] },
  ])('rejects malformed or unknown call fields without reserving bytes: %j', async (invalid) => {
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureCalls([invalid as unknown as ExtractedCall]);
      expect(stage.callRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.status).toBe('incomplete');
      expect(stage.reasons).toContain('call-invalid');
      expect(await replayCalls(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it('counts invalid singleton batches toward the lifetime call attempt ceiling', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request, { maxRecords: 2 });
    try {
      stage.captureCalls([{ ...callFixture(), argCount: -1 }]);
      stage.captureCalls([{ ...callFixture(), argCount: -1 }]);
      stage.captureCalls([callFixture()]);
      expect(stage.callRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
      expect(stage.reasons).toEqual(expect.arrayContaining(['call-invalid', 'call-count-limit']));
      expect(await replayCalls(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it('preserves earlier valid calls when later invalid singleton batches exhaust attempts', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request, { maxRecords: 2 });
    try {
      stage.captureCalls([callFixture()]);
      const retainedBytes = stage.bytes;
      stage.captureCalls([{ ...callFixture(), argCount: -1 }]);
      stage.captureCalls([{ ...callFixture(), calledName: 'refused' }]);
      expect(stage.callRecordCount).toBe(1);
      expect(stage.bytes).toBe(retainedBytes);
      expect(request.artifactAllowance.remainingBytes).toBe(allowance - retainedBytes);
      expect(stage.reasons).toEqual(expect.arrayContaining(['call-invalid', 'call-count-limit']));
      expect(await replayCalls(stage)).toEqual([callFixture()]);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it.each(['receiverTypeName', 'kind', 'name'] as const)(
    'rejects inherited %s without invoking its getter',
    async (field) => {
      const request = options();
      const stage = new ScopeRetentionStage(request);
      const call = callFixture();
      if (field !== 'receiverTypeName') {
        const step = { kind: 'call', name: 'getUser' };
        Reflect.deleteProperty(step, field);
        call.receiverMixedChain = [step as { kind: 'call'; name: string }];
      }
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
      let getterCalls = 0;
      try {
        Object.defineProperty(Object.prototype, field, {
          configurable: true,
          get() {
            getterCalls++;
            return field === 'kind' ? 'call' : 'inherited';
          },
        });
        try {
          stage.captureCalls([call]);
        } finally {
          if (previous) Object.defineProperty(Object.prototype, field, previous);
          else Reflect.deleteProperty(Object.prototype, field);
        }
        expect(getterCalls).toBe(0);
        expect(stage.callRecordCount).toBe(0);
        expect(stage.bytes).toBe(0);
        expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
        expect(stage.reasons).toContain('call-invalid');
        expect(await replayCalls(stage)).toEqual([]);
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['kind', 'name'] as const)('requires an own mixed-chain %s field', async (field) => {
    const stage = new ScopeRetentionStage(options());
    const step = Object.assign(Object.create(null), { kind: 'call', name: 'getUser' });
    Reflect.deleteProperty(step, field);
    try {
      stage.captureCalls([{ ...callFixture(), receiverMixedChain: [step] }]);
      expect(stage.callRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(stage.reasons).toContain('call-invalid');
    } finally {
      await stage.dispose();
    }
  });

  it('accepts explicitly undefined optional call fields and preserves undefined argument slots', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.captureCalls([
        {
          ...callFixture(),
          argCount: undefined,
          callForm: undefined,
          receiverName: undefined,
          receiverTypeName: undefined,
          receiverMixedChain: undefined,
          atRange: undefined,
        },
      ]);
      expect(await replayCalls(stage)).toEqual([
        {
          filePath: 'one.ts',
          calledName: 'save',
          sourceId: 'Function:one.ts:caller',
          argTypes: [undefined, 'string', undefined],
        },
      ]);
      expect(stage.callRecordCount).toBe(1);
      expect(stage.reasons).not.toContain('call-invalid');
    } finally {
      await stage.dispose();
    }
  });

  it('admits exact combined scope and call bytes and refunds them once', async () => {
    const probe = new ScopeRetentionStage(options());
    probe.captureCalls([callFixture()]);
    const callBytes = probe.bytes;
    await probe.dispose();
    const file = fixture('one.ts');
    const totalBytes = callBytes + Buffer.byteLength(encodeParsedFileRecord(file));
    const request = options(totalBytes);
    const stage = new ScopeRetentionStage(request, { maxBytes: totalBytes });
    try {
      stage.capture([file]);
      stage.captureCalls([callFixture()]);
      expect(stage.recordCount).toBe(1);
      expect(stage.callRecordCount).toBe(1);
      expect(stage.bytes).toBe(totalBytes);
      expect(request.artifactAllowance.remainingBytes).toBe(0);
      stage.captureCalls([callFixture()]);
      expect(stage.callRecordCount).toBe(1);
      expect(stage.reasons).toContain('call-byte-limit');
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
    await stage.dispose();
    expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'guards call capture and replay after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage(
        { ...request, signal: controller.signal },
        { batchRecords: 1 },
      );
      try {
        stage.captureCalls([callFixture(), callFixture()]);
        const iterator = stage.iterateCalls()[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toHaveLength(1);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') {
          vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        }
        if (guard === 'disposed') await stage.dispose();
        stage.captureCalls([callFixture()]);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.callRecordCount).toBeLessThanOrEqual(2);
        expect(stage.status).toBe('incomplete');
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('stops an in-flight call replay when cancellation arrives before its yield', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage({ ...options(), signal: controller.signal });
    try {
      stage.captureCalls([callFixture()]);
      const next = stage.iterateCalls()[Symbol.asyncIterator]().next();
      controller.abort();
      expect((await next).done).toBe(true);
      expect(stage.reasons).toContain('cancelled');
    } finally {
      await stage.dispose();
    }
  });

  it('rejects concurrent call and scope replays and releases the replay guard on return', async () => {
    const stage = new ScopeRetentionStage(options(), { batchRecords: 1 });
    try {
      stage.captureCalls([callFixture(), callFixture()]);
      const first = stage.iterateCalls()[Symbol.asyncIterator]();
      expect((await first.next()).value).toHaveLength(1);
      await expect(stage.iterateCalls()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await expect(stage.iterate()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await first.return?.();
      expect(await replayCalls(stage)).toEqual([callFixture(), callFixture()]);
    } finally {
      await stage.dispose();
    }
  });
});

function heritageFixture(): ExtractedHeritage {
  return { filePath: 'one.ts', className: 'Child', parentName: 'Base', kind: 'extends' };
}

async function replayHeritage(stage: ScopeRetentionStage): Promise<ExtractedHeritage[]> {
  const heritage: ExtractedHeritage[] = [];
  for await (const batch of stage.iterateHeritage()) heritage.push(...batch);
  return heritage;
}

describe('original parser heritage retention', () => {
  it('detaches producer inputs, batches replay, isolates replay mutations, and refunds disposal once', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    const heritage = [heritageFixture(), { ...heritageFixture(), kind: 'provider-specific-kind' }];
    const expected = structuredClone(heritage);
    try {
      stage.captureHeritage(heritage);
      heritage[0]!.parentName = 'EnrichedBase';
      heritage[1]!.kind = 'changed';
      heritage.length = 0;
      const batches: (readonly ExtractedHeritage[])[] = [];
      for await (const batch of stage.iterateHeritage()) batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
      expect(batches.flat()).toEqual(expected);
      batches[0]![0]!.parentName = 'ReplayMutation';
      expect(await replayHeritage(stage)).toEqual(expected);
      expect(stage.heritageRecordCount).toBe(2);
      expect(stage.recordCount + stage.callRecordCount).toBe(0);
      expect(stage.heritageEvidenceScope).toBe('observed-parser-inputs');
      expect(stage.seedReady).toBe(false);
      expect(request.artifactAllowance.remainingBytes).toBeLessThan(allowance);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    await stage.dispose();
    stage.captureHeritage([heritageFixture()]);
    expect(await replayHeritage(stage)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('accepts empty observed heritage without claiming complete seed evidence', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.captureHeritage([]);
      expect(stage.heritageRecordCount).toBe(0);
      expect(stage.heritageEvidenceScope).toBe('observed-parser-inputs');
      expect(stage.seedReady).toBe(false);
      expect(await replayHeritage(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['scope', 'call', 'heritage'] as const)(
    'counts heritage with both scopes and calls when %s reaches the ceiling last',
    async (last) => {
      const stage = new ScopeRetentionStage(options(), { maxRecords: 2 });
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        heritage: () => stage.captureHeritage([heritageFixture()]),
      };
      try {
        for (const kind of ['scope', 'call', 'heritage'] as const)
          if (kind !== last) capture[kind]();
        capture[last]();
        expect(stage.recordCount + stage.callRecordCount + stage.heritageRecordCount).toBe(2);
        expect(stage.reasons).toContain(
          last === 'scope' ? 'record-count-limit' : `${last}-count-limit`,
        );
        expect(stage.status).toBe('incomplete');
        expect(stage.seedReady).toBe(false);
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['allowance', 'aggregate bytes', 'record bytes', 'batch bytes'] as const)(
    'refuses heritage above the %s ceiling',
    async (ceiling) => {
      const request = options(ceiling === 'allowance' ? 0 : 1024 * 1024);
      const allowance = request.artifactAllowance.remainingBytes;
      const stage = new ScopeRetentionStage(
        request,
        ceiling === 'aggregate bytes'
          ? { maxBytes: 1 }
          : ceiling === 'record bytes'
            ? { maxRecordBytes: 1 }
            : ceiling === 'batch bytes'
              ? { batchBytes: 1 }
              : undefined,
      );
      try {
        stage.captureHeritage([heritageFixture()]);
        expect(stage.heritageRecordCount).toBe(0);
        expect(stage.bytes).toBe(0);
        expect(stage.reasons).toContain('heritage-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    },
  );

  it('shares exact aggregate bytes across scopes, calls, and heritage', async () => {
    const probe = new ScopeRetentionStage(options());
    probe.captureCalls([callFixture()]);
    probe.captureHeritage([heritageFixture()]);
    const totalBytes = probe.bytes + Buffer.byteLength(encodeParsedFileRecord(fixture('one.ts')));
    await probe.dispose();
    const request = options(totalBytes + 1);
    const stage = new ScopeRetentionStage(request, { maxBytes: totalBytes });
    try {
      stage.capture([fixture('one.ts')]);
      stage.captureCalls([callFixture()]);
      stage.captureHeritage([heritageFixture()]);
      expect([stage.recordCount, stage.callRecordCount, stage.heritageRecordCount]).toEqual([
        1, 1, 1,
      ]);
      expect(stage.bytes).toBe(totalBytes);
      expect(request.artifactAllowance.remainingBytes).toBe(1);
      expect(await replay(stage)).toEqual([fixture('one.ts')]);
      expect(await replayCalls(stage)).toEqual([callFixture()]);
      expect(await replayHeritage(stage)).toEqual([heritageFixture()]);
      stage.captureHeritage([heritageFixture()]);
      expect(stage.heritageRecordCount).toBe(1);
      expect(stage.reasons).toContain('heritage-byte-limit');
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(totalBytes + 1);
  });

  it('rejects malformed, inherited, accessor, and proxy records without invoking their code', async () => {
    const getter = vi.fn(() => 'Base');
    const trap = vi.fn(() => {
      throw new Error('proxy trap invoked');
    });
    const accessor = Object.defineProperty(heritageFixture(), 'parentName', { get: getter });
    const inherited = Object.assign(Object.create({ parentName: 'Base' }), {
      filePath: 'one.ts',
      className: 'Child',
      kind: 'extends',
    });
    const invalid = [
      { ...heritageFixture(), extra: true },
      { ...heritageFixture(), parentName: 1 },
      { filePath: 'one.ts', className: 'Child', parentName: 'Base' },
      inherited,
      accessor,
      new Proxy(heritageFixture(), { ownKeys: trap, get: trap, getPrototypeOf: trap }),
    ];
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureHeritage(invalid as ExtractedHeritage[]);
      expect(getter).not.toHaveBeenCalled();
      expect(trap).not.toHaveBeenCalled();
      expect(stage.heritageRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.reasons).toContain('heritage-invalid');
      expect(await replayHeritage(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'stops heritage capture and active replay after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage(
        { ...request, signal: controller.signal },
        { batchRecords: 1 },
      );
      try {
        stage.captureHeritage([heritageFixture(), heritageFixture()]);
        const iterator = stage.iterateHeritage()[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toHaveLength(1);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') await stage.dispose();
        stage.captureHeritage([heritageFixture()]);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.heritageRecordCount).toBeLessThanOrEqual(2);
        expect(stage.reasons).toContain(guard);
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('checks cancellation again before yielding heritage', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage({ ...options(), signal: controller.signal });
    try {
      stage.captureHeritage([heritageFixture()]);
      const next = stage.iterateHeritage()[Symbol.asyncIterator]().next();
      controller.abort();
      expect((await next).done).toBe(true);
      expect(stage.reasons).toContain('cancelled');
    } finally {
      await stage.dispose();
    }
  });

  it('shares the replay guard with calls and scopes and releases it on return', async () => {
    const stage = new ScopeRetentionStage(options(), { batchRecords: 1 });
    try {
      stage.captureHeritage([heritageFixture(), heritageFixture()]);
      const iterator = stage.iterateHeritage()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toHaveLength(1);
      await expect(stage.iterateHeritage()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await expect(stage.iterateCalls()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await expect(stage.iterate()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await iterator.return?.();
      expect(await replayHeritage(stage)).toEqual([heritageFixture(), heritageFixture()]);
    } finally {
      await stage.dispose();
    }
  });
});

function exportedTypeFixture(): RetainedExportedType {
  return { filePath: 'one.ts', exportName: 'service', typeName: 'Service' };
}

async function replayExportedTypes(stage: ScopeRetentionStage): Promise<RetainedExportedType[]> {
  const records: RetainedExportedType[] = [];
  for await (const batch of stage.iterateExportedTypes()) records.push(...batch);
  return records;
}

describe('observed resolution exported type retention', () => {
  it.each(['byte overflow', 'exact byte boundary'] as const)(
    'batches unequal UTF-8 exported type records by %s',
    async (boundary) => {
      const records = [128, 132, 136].map((length) => ({
        ...exportedTypeFixture(),
        typeName: `${'界'.repeat(length)}😀\"\\\n`,
      }));
      const sizes = records.map((record) => Buffer.byteLength(JSON.stringify(record), 'utf8'));
      const batchBytes = boundary === 'byte overflow' ? Math.max(...sizes) : sizes[0]! + sizes[1]!;
      expect(new Set(sizes).size).toBe(3);
      expect(sizes.every((size) => size <= batchBytes)).toBe(true);
      if (boundary === 'byte overflow') {
        expect(sizes[0]! + sizes[1]!).toBeGreaterThan(batchBytes);
        expect(sizes[1]! + sizes[2]!).toBeGreaterThan(batchBytes);
        expect(JSON.stringify(records[0]).length + JSON.stringify(records[1]).length).toBeLessThan(
          batchBytes,
        );
      }
      const stage = new ScopeRetentionStage(options(), { batchRecords: 10, batchBytes });
      try {
        stage.captureExportedTypes(records);
        const batches: (readonly RetainedExportedType[])[] = [];
        for await (const batch of stage.iterateExportedTypes()) batches.push(batch);
        expect(batches).toEqual(
          boundary === 'byte overflow'
            ? records.map((record) => [record])
            : [[records[0], records[1]], [records[2]]],
        );
        for (const batch of batches) {
          expect(
            batch.reduce(
              (bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record), 'utf8'),
              0,
            ),
          ).toBeLessThanOrEqual(batchBytes);
        }
        expect(stage.exportedTypeRecordCount).toBe(3);
      } finally {
        await stage.dispose();
      }
    },
  );

  it('detaches producer and replay mutations while preserving duplicate order and Unicode', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    const records = [
      exportedTypeFixture(),
      { filePath: 'src/é😀.ts', exportName: 'service', typeName: '服务😀' },
      { ...exportedTypeFixture(), typeName: 'Replacement' },
    ];
    const expected = structuredClone(records);
    try {
      stage.captureExportedTypes(records);
      records[0]!.typeName = 'Enriched';
      records[1]!.filePath = 'changed.ts';
      records.length = 0;
      const batches: (readonly RetainedExportedType[])[] = [];
      for await (const batch of stage.iterateExportedTypes()) batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
      expect(batches.flat()).toEqual(expected);
      batches[0]![0]!.exportName = 'ReplayMutation';
      expect(await replayExportedTypes(stage)).toEqual(expected);
      expect(stage.exportedTypeRecordCount).toBe(3);
      expect(stage.recordCount).toBe(0);
      expect(stage.exportedTypeEvidenceScope).toBe('observed-resolution-inputs');
      expect(stage.seedReady).toBe(false);
      expect(request.artifactAllowance.remainingBytes).toBeLessThan(allowance);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    await stage.dispose();
    stage.captureExportedTypes([exportedTypeFixture()]);
    expect(await replayExportedTypes(stage)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('accepts empty observations without complete seed evidence or byte reservations', async () => {
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureExportedTypes([]);
      expect(await replayExportedTypes(stage)).toEqual([]);
      expect(stage.exportedTypeRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.exportedTypeEvidenceScope).toBe('observed-resolution-inputs');
      expect(stage.seedReady).toBe(false);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['scope', 'call', 'heritage', 'assignment', 'constructor', 'exported type'] as const)(
    'shares the record ceiling across six families with %s last',
    async (last) => {
      const stage = new ScopeRetentionStage(options(), { maxRecords: 5 });
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        heritage: () => stage.captureHeritage([heritageFixture()]),
        assignment: () => stage.captureAssignments([assignmentFixture()]),
        constructor: () => stage.captureConstructorBindings([constructorFixture()]),
        'exported type': () => stage.captureExportedTypes([exportedTypeFixture()]),
      };
      try {
        for (const kind of [
          'scope',
          'call',
          'heritage',
          'assignment',
          'constructor',
          'exported type',
        ] as const)
          if (kind !== last) capture[kind]();
        capture[last]();
        expect(
          stage.recordCount +
            stage.callRecordCount +
            stage.heritageRecordCount +
            stage.assignmentRecordCount +
            stage.constructorBindingRecordCount +
            stage.exportedTypeRecordCount,
        ).toBe(5);
        expect(stage.status).toBe('incomplete');
        expect(stage.reasons).toContain(
          last === 'scope'
            ? 'record-count-limit'
            : last === 'constructor'
              ? 'constructor-binding-count-limit'
              : last === 'exported type'
                ? 'exported-type-count-limit'
                : `${last}-count-limit`,
        );
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['allowance', 'aggregate bytes', 'record bytes', 'batch bytes'] as const)(
    'refuses exported types above the %s ceiling without leaking reservations',
    async (ceiling) => {
      const request = options(ceiling === 'allowance' ? 0 : 1024 * 1024);
      const allowance = request.artifactAllowance.remainingBytes;
      const stage = new ScopeRetentionStage(
        request,
        ceiling === 'aggregate bytes'
          ? { maxBytes: 1 }
          : ceiling === 'record bytes'
            ? { maxRecordBytes: 1 }
            : ceiling === 'batch bytes'
              ? { batchBytes: 1 }
              : undefined,
      );
      try {
        stage.captureExportedTypes([exportedTypeFixture()]);
        expect(stage.exportedTypeRecordCount).toBe(0);
        expect(stage.bytes).toBe(0);
        expect(stage.reasons).toContain('exported-type-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    },
  );

  it.each(['scope', 'call', 'heritage', 'assignment', 'constructor', 'exported type'] as const)(
    'shares exact aggregate bytes and preserves scope disk replay with %s last',
    async (last) => {
      const probe = new ScopeRetentionStage(options());
      probe.captureCalls([callFixture()]);
      probe.captureHeritage([heritageFixture()]);
      probe.captureAssignments([assignmentFixture()]);
      probe.captureConstructorBindings([constructorFixture()]);
      probe.captureExportedTypes([exportedTypeFixture()]);
      const totalBytes = probe.bytes + Buffer.byteLength(encodeParsedFileRecord(fixture('one.ts')));
      await probe.dispose();
      const request = options(totalBytes);
      const stage = new ScopeRetentionStage(request, { maxBytes: totalBytes });
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        heritage: () => stage.captureHeritage([heritageFixture()]),
        assignment: () => stage.captureAssignments([assignmentFixture()]),
        constructor: () => stage.captureConstructorBindings([constructorFixture()]),
        'exported type': () => stage.captureExportedTypes([exportedTypeFixture()]),
      };
      try {
        for (const kind of [
          'scope',
          'call',
          'heritage',
          'assignment',
          'constructor',
          'exported type',
        ] as const)
          if (kind !== last) capture[kind]();
        capture[last]();
        expect([
          stage.recordCount,
          stage.callRecordCount,
          stage.heritageRecordCount,
          stage.assignmentRecordCount,
          stage.constructorBindingRecordCount,
          stage.exportedTypeRecordCount,
        ]).toEqual([1, 1, 1, 1, 1, 1]);
        expect(stage.bytes).toBe(totalBytes);
        expect(request.artifactAllowance.remainingBytes).toBe(0);
        expect(await replay(stage)).toEqual([fixture('one.ts')]);
        expect(await replayCalls(stage)).toEqual([callFixture()]);
        expect(await replayHeritage(stage)).toEqual([heritageFixture()]);
        expect(await replayAssignments(stage)).toEqual([assignmentFixture()]);
        expect(await replayConstructors(stage)).toEqual([constructorFixture()]);
        expect(await replayExportedTypes(stage)).toEqual([exportedTypeFixture()]);
        stage.captureExportedTypes([exportedTypeFixture()]);
        expect(stage.exportedTypeRecordCount).toBe(1);
        expect(stage.bytes).toBe(totalBytes);
        expect(stage.reasons).toContain('exported-type-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
      await stage.dispose();
      expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
    },
  );

  it('bounds repeated invalid attempts and preserves earlier observed exported types', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request, { maxRecords: 2 });
    try {
      stage.captureExportedTypes([exportedTypeFixture()]);
      const bytes = stage.bytes;
      for (let i = 0; i < 20; i++)
        stage.captureExportedTypes([
          { ...exportedTypeFixture(), typeName: null } as unknown as RetainedExportedType,
        ]);
      stage.captureExportedTypes([exportedTypeFixture()]);
      expect(stage.exportedTypeRecordCount).toBe(1);
      expect(stage.bytes).toBe(bytes);
      expect(request.artifactAllowance.remainingBytes).toBe(allowance - bytes);
      expect(stage.reasons).toEqual(
        expect.arrayContaining(['exported-type-invalid', 'exported-type-count-limit']),
      );
      expect(await replayExportedTypes(stage)).toEqual([exportedTypeFixture()]);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('rejects malformed, inherited, accessor and proxy input without executing it', async () => {
    const getter = vi.fn(() => 'Service');
    const trap = vi.fn(() => {
      throw new Error('proxy trap invoked');
    });
    const proxy = (value: object) =>
      new Proxy(value, { ownKeys: trap, get: trap, getPrototypeOf: trap });
    const invalid: unknown[] = [
      { ...exportedTypeFixture(), extra: true },
      { ...exportedTypeFixture(), filePath: 1 },
      { ...exportedTypeFixture(), exportName: undefined },
      { ...exportedTypeFixture(), typeName: null },
      proxy(exportedTypeFixture()),
    ];
    for (const field of ['filePath', 'exportName', 'typeName'] as const) {
      const own = { ...exportedTypeFixture() };
      Reflect.deleteProperty(own, field);
      invalid.push(Object.assign(Object.create({ [field]: 'Inherited' }), own));
      invalid.push(Object.defineProperty(exportedTypeFixture(), field, { get: getter }));
    }
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureExportedTypes(invalid as RetainedExportedType[]);
      stage.captureExportedTypes(proxy([exportedTypeFixture()]) as RetainedExportedType[]);
      stage.captureExportedTypes(
        Object.defineProperty([exportedTypeFixture()], '0', {
          get: getter,
        }) as unknown as RetainedExportedType[],
      );
      expect(getter).not.toHaveBeenCalled();
      expect(trap).not.toHaveBeenCalled();
      expect(stage.exportedTypeRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.reasons).toContain('exported-type-invalid');
      expect(await replayExportedTypes(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'stops exported type capture and active replay after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage(
        { ...request, signal: controller.signal },
        { batchRecords: 1 },
      );
      try {
        stage.captureExportedTypes([exportedTypeFixture(), exportedTypeFixture()]);
        const iterator = stage.iterateExportedTypes()[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toHaveLength(1);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') await stage.dispose();
        stage.captureExportedTypes([exportedTypeFixture()]);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.exportedTypeRecordCount).toBeLessThanOrEqual(2);
        expect(stage.reasons).toContain(guard);
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('checks cancellation immediately before yielding exported types', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage({ ...options(), signal: controller.signal });
    try {
      stage.captureExportedTypes([exportedTypeFixture()]);
      const next = stage.iterateExportedTypes()[Symbol.asyncIterator]().next();
      controller.abort();
      expect((await next).done).toBe(true);
      expect(stage.reasons).toContain('cancelled');
    } finally {
      await stage.dispose();
    }
  });

  it('shares replay exclusion across all six families and releases it on return', async () => {
    const stage = new ScopeRetentionStage(options(), { batchRecords: 1 });
    try {
      stage.captureExportedTypes([exportedTypeFixture(), exportedTypeFixture()]);
      const iterator = stage.iterateExportedTypes()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toHaveLength(1);
      for (const other of [
        stage.iterateExportedTypes(),
        stage.iterateConstructorBindings(),
        stage.iterateAssignments(),
        stage.iterateHeritage(),
        stage.iterateCalls(),
        stage.iterate(),
      ]) {
        await expect(other[Symbol.asyncIterator]().next()).rejects.toThrow();
      }
      await iterator.return?.();
      expect(await replayExportedTypes(stage)).toEqual([
        exportedTypeFixture(),
        exportedTypeFixture(),
      ]);
    } finally {
      await stage.dispose();
    }
  });
});

async function replayModelRegistrations(
  stage: ScopeRetentionStage,
): Promise<SemanticModelRegistrationEvent[]> {
  const events: SemanticModelRegistrationEvent[] = [];
  for await (const batch of stage.iterateModelRegistrations()) events.push(...batch);
  return events;
}

function modelRegistrationFixture(): string {
  const events: string[] = [];
  const model = createSemanticModel({
    onRegistration: (encoded) => {
      events.push(encoded);
      return true;
    },
  });
  model.symbols.add('one.ts', 'User', 'class:User', 'Class');
  return events[0]!;
}

describe('observed semantic model registration retention', () => {
  it('retains the real chronological observer stream and replays final semantic state independently', async () => {
    const request = options();
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    const model = createSemanticModel({
      onRegistration: (encoded) => stage.captureModelRegistration(encoded),
      onRegistrationError: () => stage.markModelRegistrationsIncomplete(),
    });
    try {
      model.symbols.add('old.ts', 'Old', 'class:Old', 'Class');
      model.types.registerClass('Direct', 'app.Direct', {
        nodeId: 'class:Direct',
        filePath: 'direct.ts',
        type: 'Class',
      });
      model.types.clear();
      model.clear();
      model.symbols.add('new.ts', 'New', 'class:New', 'Class');
      model.symbols.add('new.ts', 'New', 'class:New', 'Class');
      const parameterTypes = ['服务😀'];
      model.methods.register('class:New', 'save', {
        nodeId: 'method:save',
        filePath: 'new.ts',
        type: 'Method',
        parameterTypes,
      });
      parameterTypes[0] = 'Producer mutation';
      const batches: (readonly SemanticModelRegistrationEvent[])[] = [];
      for await (const batch of stage.iterateModelRegistrations()) batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect(batches.flat().map((event) => event.kind)).toEqual([
        'symbol.add',
        'type.registerClass',
        'type.clear',
        'model.clear',
        'symbol.add',
        'symbol.add',
        'method.register',
      ]);
      const last = batches[6]![0]!;
      if (last.kind !== 'method.register') throw new Error('expected method registration');
      expect(last.def.parameterTypes).toEqual(['服务😀']);
      last.def.parameterTypes![0] = 'Replay mutation';
      const restored = restoreSemanticModelRegistrations({
        version: 1,
        events: await replayModelRegistrations(stage),
      });
      expect([...restored.symbols.getFiles()]).toEqual(['new.ts']);
      expect(restored.symbols.getStats()).toEqual(model.symbols.getStats());
      for (const name of ['Old', 'Direct', 'New'])
        expect(restored.types.lookupClassByName(name)).toEqual(model.types.lookupClassByName(name));
      expect(restored.methods.lookupMethodByOwner('class:New', 'save')!.parameterTypes).toEqual([
        '服务😀',
      ]);
      expect(stage.modelRegistrationRecordCount).toBe(7);
      expect(stage.seedReady).toBe(false);
      expect(model.snapshotRegistrations()).toBeUndefined();
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
  });

  it.each(['scope', 'call', 'model'] as const)(
    'shares the record ceiling with %s last',
    async (last) => {
      const stage = new ScopeRetentionStage(options(), { maxRecords: 2 });
      const encoded = modelRegistrationFixture();
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        model: () => stage.captureModelRegistration(encoded),
      };
      try {
        for (const family of ['scope', 'call', 'model'] as const)
          if (family !== last) capture[family]();
        const accepted = capture[last]();
        if (last === 'model') expect(accepted).toBe(false);
        expect([
          stage.recordCount,
          stage.callRecordCount,
          stage.modelRegistrationRecordCount,
        ]).toEqual(['scope', 'call', 'model'].map((family) => (family === last ? 0 : 1)));
        expect(stage.status).toBe('incomplete');
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['scope', 'call', 'model'] as const)(
    'shares aggregate bytes and allowance with %s last and refunds once',
    async (last) => {
      const encoded = modelRegistrationFixture();
      const probe = new ScopeRetentionStage(options());
      probe.captureCalls([callFixture()]);
      probe.captureModelRegistration(encoded);
      const totalBytes = probe.bytes + Buffer.byteLength(encodeParsedFileRecord(fixture('one.ts')));
      await probe.dispose();
      const request = options(totalBytes);
      const stage = new ScopeRetentionStage(request, { maxBytes: totalBytes });
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        model: () => stage.captureModelRegistration(encoded),
      };
      try {
        for (const family of ['scope', 'call', 'model'] as const)
          if (family !== last) capture[family]();
        capture[last]();
        expect([
          stage.recordCount,
          stage.callRecordCount,
          stage.modelRegistrationRecordCount,
        ]).toEqual([1, 1, 1]);
        expect(stage.bytes).toBe(totalBytes);
        expect(request.artifactAllowance.remainingBytes).toBe(0);
        expect(await replay(stage)).toEqual([fixture('one.ts')]);
        expect(await replayCalls(stage)).toEqual([callFixture()]);
        expect(await replayModelRegistrations(stage)).toEqual([JSON.parse(encoded)]);
        expect(stage.captureModelRegistration(encoded)).toBe(false);
        expect(stage.bytes).toBe(totalBytes);
        expect(stage.modelRegistrationRecordCount).toBe(1);
      } finally {
        await stage.dispose();
      }
      await stage.dispose();
      expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
    },
  );

  it('refuses byte capture and disables the model observer while preserving legacy additions', async () => {
    const request = options(0);
    const stage = new ScopeRetentionStage(request);
    const onRegistration = vi.fn((encoded: string) => stage.captureModelRegistration(encoded));
    const onRegistrationError = vi.fn(() => stage.markModelRegistrationsIncomplete());
    const model = createSemanticModel({ onRegistration, onRegistrationError });
    try {
      model.symbols.add('one.ts', 'First', 'class:First', 'Class');
      model.symbols.add('one.ts', 'Next', 'class:Next', 'Class');
      expect(onRegistration).toHaveBeenCalledTimes(1);
      expect(onRegistrationError).toHaveBeenCalledTimes(1);
      expect(model.types.lookupClassByName('First')).toHaveLength(1);
      expect(model.types.lookupClassByName('Next')).toHaveLength(1);
      expect(stage.modelRegistrationRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(stage.status).toBe('incomplete');
      expect(stage.seedReady).toBe(false);
      expect(await replayModelRegistrations(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(0);
  });

  it('counts invalid non-string singleton attempts for the lifetime without reserving bytes', async () => {
    const request = options();
    const stage = new ScopeRetentionStage(request, { maxRecords: 2 });
    try {
      expect(stage.captureModelRegistration(undefined as unknown as string)).toBe(false);
      expect(stage.captureModelRegistration(42 as unknown as string)).toBe(false);
      expect(stage.captureModelRegistration(modelRegistrationFixture())).toBe(false);
      expect(stage.modelRegistrationRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.status).toBe('incomplete');
    } finally {
      await stage.dispose();
    }
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'stops active model replay and capture after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage(
        { ...request, signal: controller.signal },
        { batchRecords: 1 },
      );
      try {
        const encoded = modelRegistrationFixture();
        expect(stage.captureModelRegistration(encoded)).toBe(true);
        expect(stage.captureModelRegistration(encoded)).toBe(true);
        const iterator = stage.iterateModelRegistrations()[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toEqual([JSON.parse(encoded)]);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') await stage.dispose();
        expect(stage.captureModelRegistration(encoded)).toBe(false);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.reasons).toContain(guard);
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(await replayModelRegistrations(stage)).toEqual([]);
    },
  );

  it('shares replay exclusion with disk scopes and calls in both directions', async () => {
    const request = options();
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    try {
      stage.capture([fixture('one.ts')]);
      stage.captureCalls([callFixture()]);
      const encoded = modelRegistrationFixture();
      stage.captureModelRegistration(encoded);
      const iterator = stage.iterateModelRegistrations()[Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(false);
      for (const other of [
        stage.iterate(),
        stage.iterateCalls(),
        stage.iterateModelRegistrations(),
      ])
        await expect(other[Symbol.asyncIterator]().next()).rejects.toThrow();
      await iterator.return?.();
      for (const other of [stage.iterate(), stage.iterateCalls()]) {
        const active = other[Symbol.asyncIterator]();
        expect((await active.next()).done).toBe(false);
        await expect(
          stage.iterateModelRegistrations()[Symbol.asyncIterator]().next(),
        ).rejects.toThrow();
        await active.return?.();
      }
      expect(await replayModelRegistrations(stage)).toEqual([JSON.parse(encoded)]);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
  });
});

function fileBindingFixture(): RetainedFileBinding {
  return { filePath: 'one.ts', varName: 'service', typeName: 'Service' };
}

async function replayFileBindings(stage: ScopeRetentionStage): Promise<RetainedFileBinding[]> {
  const records: RetainedFileBinding[] = [];
  for await (const batch of stage.iterateFileBindings()) records.push(...batch);
  return records;
}

describe('observed resolution file binding retention', () => {
  const families = [
    'scope',
    'call',
    'heritage',
    'assignment',
    'constructor',
    'exported type',
    'file binding',
  ] as const;
  function captures(stage: ScopeRetentionStage) {
    return {
      scope: () => stage.capture([fixture('one.ts')]),
      call: () => stage.captureCalls([callFixture()]),
      heritage: () => stage.captureHeritage([heritageFixture()]),
      assignment: () => stage.captureAssignments([assignmentFixture()]),
      constructor: () => stage.captureConstructorBindings([constructorFixture()]),
      'exported type': () => stage.captureExportedTypes([exportedTypeFixture()]),
      'file binding': () => stage.captureFileBindings([fileBindingFixture()]),
    };
  }
  const counts = (stage: ScopeRetentionStage) => [
    stage.recordCount,
    stage.callRecordCount,
    stage.heritageRecordCount,
    stage.assignmentRecordCount,
    stage.constructorBindingRecordCount,
    stage.exportedTypeRecordCount,
    stage.fileBindingRecordCount,
  ];
  const reasonPrefix = (family: (typeof families)[number]) =>
    family === 'scope'
      ? 'record'
      : family === 'constructor'
        ? 'constructor-binding'
        : family.replace(' ', '-');

  it('detaches records and every replay while preserving duplicate order and Unicode', async () => {
    const request = options();
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    const records = [
      fileBindingFixture(),
      { filePath: 'src/é😀.ts', varName: '服务😀', typeName: '类型\\"\n' },
      fileBindingFixture(),
      { ...fileBindingFixture(), typeName: 'Replacement' },
    ];
    const expected = structuredClone(records);
    try {
      stage.captureFileBindings(records);
      records[0]!.typeName = 'Changed';
      records.length = 0;
      const batches: (readonly RetainedFileBinding[])[] = [];
      for await (const batch of stage.iterateFileBindings()) batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1, 1]);
      expect(batches.flat()).toEqual(expected);
      batches[0]![0]!.varName = 'Changed';
      expect(await replayFileBindings(stage)).toEqual(expected);
      expect(stage.fileBindingRecordCount).toBe(4);
      expect(stage.fileBindingEvidenceScope).toBe('observed-resolution-inputs');
      expect(stage.seedReady).toBe(false);
      expect(request.artifactAllowance.remainingBytes).toBeLessThan(1024 * 1024);
    } finally {
      await stage.dispose();
    }
    await stage.dispose();
    stage.captureFileBindings([fileBindingFixture()]);
    expect(await replayFileBindings(stage)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
  });

  it('accepts empty observations without claiming a complete seed or reserving bytes', async () => {
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureFileBindings([]);
      expect(await replayFileBindings(stage)).toEqual([]);
      expect(stage.fileBindingRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(stage.fileBindingEvidenceScope).toBe('observed-resolution-inputs');
      expect(stage.seedReady).toBe(false);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['overflow', 'exact boundary'] as const)(
    'splits unequal UTF-8 records at the byte %s',
    async (boundary) => {
      const records = [128, 132, 136].map((length) => ({
        ...fileBindingFixture(),
        typeName: `${'界'.repeat(length)}😀\\"\n`,
      }));
      const sizes = records.map((record) => Buffer.byteLength(JSON.stringify(record), 'utf8'));
      const batchBytes = boundary === 'overflow' ? Math.max(...sizes) : sizes[0]! + sizes[1]!;
      expect(new Set(sizes).size).toBe(3);
      if (boundary === 'overflow') {
        expect(sizes[0]! + sizes[1]!).toBeGreaterThan(batchBytes);
        expect(JSON.stringify(records[0]).length + JSON.stringify(records[1]).length).toBeLessThan(
          batchBytes,
        );
      }
      const stage = new ScopeRetentionStage(options(), { batchRecords: 10, batchBytes });
      try {
        stage.captureFileBindings(records);
        const batches: (readonly RetainedFileBinding[])[] = [];
        for await (const batch of stage.iterateFileBindings()) batches.push(batch);
        expect(batches).toEqual(
          boundary === 'overflow'
            ? records.map((record) => [record])
            : [[records[0], records[1]], [records[2]]],
        );
        for (const batch of batches)
          expect(
            batch.reduce(
              (sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8'),
              0,
            ),
          ).toBeLessThanOrEqual(batchBytes);
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(families)('shares the seven-family record ceiling with %s refused last', async (last) => {
    const stage = new ScopeRetentionStage(options(), { maxRecords: 6 });
    try {
      const capture = captures(stage);
      for (const family of families) if (family !== last) capture[family]();
      capture[last]();
      expect(counts(stage)).toEqual(families.map((family) => (family === last ? 0 : 1)));
      expect(stage.reasons).toContain(`${reasonPrefix(last)}-count-limit`);
      expect(stage.status).toBe('incomplete');
    } finally {
      await stage.dispose();
    }
  });

  it.each(families)('shares exact byte admission and refuses the next %s record', async (last) => {
    const probe = new ScopeRetentionStage(options());
    for (const [family, capture] of Object.entries(captures(probe)))
      if (family !== 'scope') capture();
    const totalBytes = probe.bytes + Buffer.byteLength(encodeParsedFileRecord(fixture('one.ts')));
    await probe.dispose();
    const request = options(totalBytes);
    const stage = new ScopeRetentionStage(request, { maxBytes: totalBytes });
    try {
      const capture = captures(stage);
      for (const family of families) if (family !== last) capture[family]();
      capture[last]();
      expect(counts(stage)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect(stage.bytes).toBe(totalBytes);
      expect(request.artifactAllowance.remainingBytes).toBe(0);
      expect(await replay(stage)).toEqual([fixture('one.ts')]);
      expect(await replayFileBindings(stage)).toEqual([fileBindingFixture()]);
      capture[last]();
      expect(counts(stage)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect(stage.bytes).toBe(totalBytes);
      expect(stage.reasons).toContain(
        `${last === 'scope' ? 'artifact' : reasonPrefix(last)}-byte-limit`,
      );
    } finally {
      await stage.dispose();
    }
    await stage.dispose();
    expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
  });

  it.each(['allowance', 'aggregate bytes', 'record bytes', 'batch bytes'] as const)(
    'refuses the %s ceiling without reservations',
    async (ceiling) => {
      const request = options(ceiling === 'allowance' ? 0 : 1024 * 1024);
      const initial = request.artifactAllowance.remainingBytes;
      const stage = new ScopeRetentionStage(
        request,
        ceiling === 'aggregate bytes'
          ? { maxBytes: 1 }
          : ceiling === 'record bytes'
            ? { maxRecordBytes: 1 }
            : ceiling === 'batch bytes'
              ? { batchBytes: 1 }
              : undefined,
      );
      try {
        stage.captureFileBindings([fileBindingFixture()]);
        expect(stage.fileBindingRecordCount).toBe(0);
        expect(stage.bytes).toBe(0);
        expect(stage.reasons).toContain('file-binding-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(initial);
    },
  );

  it('charges invalid singleton attempts for the lifetime while retaining earlier observations', async () => {
    const request = options();
    const stage = new ScopeRetentionStage(request, { maxRecords: 2 });
    try {
      stage.captureFileBindings([fileBindingFixture()]);
      const bytes = stage.bytes;
      for (let i = 0; i < 20; i++)
        stage.captureFileBindings([
          { ...fileBindingFixture(), typeName: null } as unknown as RetainedFileBinding,
        ]);
      stage.captureFileBindings([fileBindingFixture()]);
      expect(await replayFileBindings(stage)).toEqual([fileBindingFixture()]);
      expect(stage.bytes).toBe(bytes);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024 - bytes);
      expect(stage.reasons).toEqual(
        expect.arrayContaining(['file-binding-invalid', 'file-binding-count-limit']),
      );
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
  });

  it('rejects invalid records, inherited fields, accessors and proxies without executing code', async () => {
    const getter = vi.fn(() => 'Service');
    const trap = vi.fn(() => {
      throw new Error('proxy trap invoked');
    });
    const proxy = (value: object) =>
      new Proxy(value, { ownKeys: trap, get: trap, getPrototypeOf: trap });
    const invalid: unknown[] = [
      { ...fileBindingFixture(), extra: true },
      proxy(fileBindingFixture()),
    ];
    for (const field of ['filePath', 'varName', 'typeName'] as const) {
      const own = { ...fileBindingFixture() };
      Reflect.deleteProperty(own, field);
      invalid.push(
        own,
        { ...fileBindingFixture(), [field]: null },
        Object.assign(Object.create({ [field]: 'Inherited' }), own),
        Object.defineProperty(fileBindingFixture(), field, { get: getter }),
      );
    }
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureFileBindings(invalid as RetainedFileBinding[]);
      stage.captureFileBindings(proxy([fileBindingFixture()]) as RetainedFileBinding[]);
      stage.captureFileBindings(
        Object.defineProperty([fileBindingFixture()], '0', {
          get: getter,
        }) as unknown as RetainedFileBinding[],
      );
      expect(getter).not.toHaveBeenCalled();
      expect(trap).not.toHaveBeenCalled();
      expect(await replayFileBindings(stage)).toEqual([]);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.reasons).toContain('file-binding-invalid');
    } finally {
      await stage.dispose();
    }
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'stops capture and suspended replay after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage(
        { ...request, signal: controller.signal },
        { batchRecords: 1 },
      );
      try {
        stage.captureFileBindings([fileBindingFixture(), fileBindingFixture()]);
        const iterator = stage.iterateFileBindings()[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toHaveLength(1);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') await stage.dispose();
        stage.captureFileBindings([fileBindingFixture()]);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.fileBindingRecordCount).toBeLessThanOrEqual(2);
        expect(stage.reasons).toContain(guard);
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('checks cancellation immediately before yielding', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage({ ...options(), signal: controller.signal });
    try {
      stage.captureFileBindings([fileBindingFixture()]);
      const next = stage.iterateFileBindings()[Symbol.asyncIterator]().next();
      controller.abort();
      expect((await next).done).toBe(true);
      expect(stage.reasons).toContain('cancelled');
    } finally {
      await stage.dispose();
    }
  });

  it('shares the replay mutex with every family in both directions and releases on return', async () => {
    const stage = new ScopeRetentionStage(options(), { batchRecords: 1 });
    try {
      for (const capture of Object.values(captures(stage))) capture();
      const others = [
        () => stage.iterate(),
        () => stage.iterateCalls(),
        () => stage.iterateHeritage(),
        () => stage.iterateAssignments(),
        () => stage.iterateConstructorBindings(),
        () => stage.iterateExportedTypes(),
      ];
      const iterator = stage.iterateFileBindings()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toHaveLength(1);
      for (const other of [...others, () => stage.iterateFileBindings()])
        await expect(other()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await iterator.return?.();
      for (const other of others) {
        const active = other()[Symbol.asyncIterator]();
        expect((await active.next()).done).toBe(false);
        await expect(stage.iterateFileBindings()[Symbol.asyncIterator]().next()).rejects.toThrow();
        await active.return?.();
      }
      expect(await replayFileBindings(stage)).toEqual([fileBindingFixture()]);
    } finally {
      await stage.dispose();
    }
  });
});

function constructorFixture(): FileConstructorBindings {
  return {
    filePath: 'one.ts',
    bindings: [{ scope: 'module', varName: 'service', calleeName: 'Service' }],
  };
}

async function replayConstructors(stage: ScopeRetentionStage): Promise<FileConstructorBindings[]> {
  const groups: FileConstructorBindings[] = [];
  for await (const batch of stage.iterateConstructorBindings()) groups.push(...batch);
  return groups;
}

describe('original parser constructor binding retention', () => {
  it.each(['byte overflow', 'exact byte boundary'] as const)(
    'batches unequal UTF-8 singleton constructor records by %s',
    async (boundary) => {
      const group = constructorFixture();
      group.bindings = [128, 132, 136].map((length) => ({
        ...group.bindings[0]!,
        calleeName: `${'界'.repeat(length)}😀\"\\\n`,
      }));
      const records = group.bindings.map((binding) => ({
        filePath: group.filePath,
        bindings: [binding],
      }));
      const sizes = records.map((record) => Buffer.byteLength(JSON.stringify(record), 'utf8'));
      const batchBytes = boundary === 'byte overflow' ? Math.max(...sizes) : sizes[0]! + sizes[1]!;
      expect(new Set(sizes).size).toBe(3);
      expect(sizes.every((size) => size <= batchBytes)).toBe(true);
      if (boundary === 'byte overflow') {
        expect(sizes[0]! + sizes[1]!).toBeGreaterThan(batchBytes);
        expect(sizes[1]! + sizes[2]!).toBeGreaterThan(batchBytes);
        expect(JSON.stringify(records[0]).length + JSON.stringify(records[1]).length).toBeLessThan(
          batchBytes,
        );
      }
      const stage = new ScopeRetentionStage(options(), { batchRecords: 10, batchBytes });
      try {
        stage.captureConstructorBindings([group]);
        const batches: (readonly FileConstructorBindings[])[] = [];
        for await (const batch of stage.iterateConstructorBindings()) batches.push(batch);
        expect(batches).toEqual(
          boundary === 'byte overflow'
            ? records.map((record) => [record])
            : [[records[0], records[1]], [records[2]]],
        );
        for (const batch of batches) {
          expect(
            batch.reduce(
              (bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record), 'utf8'),
              0,
            ),
          ).toBeLessThanOrEqual(batchBytes);
        }
        expect(stage.constructorBindingRecordCount).toBe(3);
      } finally {
        await stage.dispose();
      }
    },
  );

  it('detaches nested producer inputs, emits singleton groups, isolates replay, and refunds once', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    const groups = [constructorFixture()];
    groups[0]!.bindings.push({
      scope: 'class',
      varName: 'this.service',
      calleeName: 'Factory',
      receiverClassName: 'Client',
    });
    const expected = groups[0]!.bindings.map((binding) => ({
      filePath: 'one.ts',
      bindings: [{ ...binding }],
    }));
    try {
      stage.captureConstructorBindings(groups);
      groups[0]!.filePath = 'changed.ts';
      groups[0]!.bindings[0]!.calleeName = 'Enriched';
      groups[0]!.bindings[1]!.receiverClassName = 'EnrichedClient';
      groups[0]!.bindings.length = 0;
      groups.length = 0;
      const batches: (readonly FileConstructorBindings[])[] = [];
      for await (const batch of stage.iterateConstructorBindings()) batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
      expect(batches.flat()).toEqual(expected);
      batches[0]![0]!.filePath = 'replay.ts';
      batches[0]![0]!.bindings[0]!.varName = 'replayMutation';
      batches[1]![0]!.bindings.length = 0;
      expect(await replayConstructors(stage)).toEqual(expected);
      expect(stage.constructorBindingRecordCount).toBe(2);
      expect(stage.recordCount).toBe(0);
      expect(stage.constructorBindingEvidenceScope).toBe('observed-parser-inputs');
      expect(stage.seedReady).toBe(false);
      expect(request.artifactAllowance.remainingBytes).toBeLessThan(allowance);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    await stage.dispose();
    stage.captureConstructorBindings([constructorFixture()]);
    expect(await replayConstructors(stage)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('stores no records for empty groups and normalizes explicitly undefined optional receiver names', async () => {
    const stage = new ScopeRetentionStage(options(), { maxRecords: 2 });
    try {
      stage.captureConstructorBindings([]);
      stage.captureConstructorBindings([{ filePath: 'empty.ts', bindings: [] }]);
      expect(stage.bytes).toBe(0);
      expect(stage.constructorBindingRecordCount).toBe(0);
      const group = constructorFixture();
      group.bindings[0]!.receiverClassName = undefined;
      stage.captureConstructorBindings([group]);
      const replayed = await replayConstructors(stage);
      expect(replayed).toEqual([constructorFixture()]);
      expect(Object.hasOwn(replayed[0]!.bindings[0]!, 'receiverClassName')).toBe(false);
      expect(stage.constructorBindingRecordCount).toBe(1);
      expect(stage.seedReady).toBe(false);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['scope', 'call', 'heritage', 'assignment', 'constructor'] as const)(
    'shares the record ceiling across all five families with %s last',
    async (last) => {
      const stage = new ScopeRetentionStage(options(), { maxRecords: 4 });
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        heritage: () => stage.captureHeritage([heritageFixture()]),
        assignment: () => stage.captureAssignments([assignmentFixture()]),
        constructor: () => stage.captureConstructorBindings([constructorFixture()]),
      };
      try {
        for (const kind of ['scope', 'call', 'heritage', 'assignment', 'constructor'] as const)
          if (kind !== last) capture[kind]();
        capture[last]();
        expect(
          stage.recordCount +
            stage.callRecordCount +
            stage.heritageRecordCount +
            stage.assignmentRecordCount +
            stage.constructorBindingRecordCount,
        ).toBe(4);
        expect(stage.status).toBe('incomplete');
        expect(stage.reasons).toContain(
          last === 'scope'
            ? 'record-count-limit'
            : last === 'constructor'
              ? 'constructor-binding-count-limit'
              : `${last}-count-limit`,
        );
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['allowance', 'aggregate bytes', 'record bytes', 'batch bytes'] as const)(
    'refuses constructor bindings above the %s ceiling without leaking reservations',
    async (ceiling) => {
      const request = options(ceiling === 'allowance' ? 0 : 1024 * 1024);
      const allowance = request.artifactAllowance.remainingBytes;
      const stage = new ScopeRetentionStage(
        request,
        ceiling === 'aggregate bytes'
          ? { maxBytes: 1 }
          : ceiling === 'record bytes'
            ? { maxRecordBytes: 1 }
            : ceiling === 'batch bytes'
              ? { batchBytes: 1 }
              : undefined,
      );
      try {
        stage.captureConstructorBindings([constructorFixture()]);
        expect(stage.constructorBindingRecordCount).toBe(0);
        expect(stage.bytes).toBe(0);
        expect(stage.reasons).toContain('constructor-binding-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    },
  );

  it.each(['scope', 'call', 'heritage', 'assignment', 'constructor'] as const)(
    'shares exact aggregate bytes and preserves scope artifacts with %s admitted last',
    async (last) => {
      const probe = new ScopeRetentionStage(options());
      probe.captureCalls([callFixture()]);
      probe.captureHeritage([heritageFixture()]);
      probe.captureAssignments([assignmentFixture()]);
      probe.captureConstructorBindings([constructorFixture()]);
      const totalBytes = probe.bytes + Buffer.byteLength(encodeParsedFileRecord(fixture('one.ts')));
      await probe.dispose();
      const request = options(totalBytes);
      const stage = new ScopeRetentionStage(request, { maxBytes: totalBytes });
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        heritage: () => stage.captureHeritage([heritageFixture()]),
        assignment: () => stage.captureAssignments([assignmentFixture()]),
        constructor: () => stage.captureConstructorBindings([constructorFixture()]),
      };
      try {
        for (const kind of ['scope', 'call', 'heritage', 'assignment', 'constructor'] as const)
          if (kind !== last) capture[kind]();
        capture[last]();
        expect([
          stage.recordCount,
          stage.callRecordCount,
          stage.heritageRecordCount,
          stage.assignmentRecordCount,
          stage.constructorBindingRecordCount,
        ]).toEqual([1, 1, 1, 1, 1]);
        expect(stage.bytes).toBe(totalBytes);
        expect(request.artifactAllowance.remainingBytes).toBe(0);
        expect(await replay(stage)).toEqual([fixture('one.ts')]);
        expect(await replayCalls(stage)).toEqual([callFixture()]);
        expect(await replayHeritage(stage)).toEqual([heritageFixture()]);
        expect(await replayAssignments(stage)).toEqual([assignmentFixture()]);
        expect(await replayConstructors(stage)).toEqual([constructorFixture()]);
        stage.captureConstructorBindings([constructorFixture()]);
        expect(stage.constructorBindingRecordCount).toBe(1);
        expect(stage.bytes).toBe(totalBytes);
        expect(stage.reasons).toContain('constructor-binding-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
      await stage.dispose();
      expect(request.artifactAllowance.remainingBytes).toBe(totalBytes);
    },
  );

  it('bounds invalid wrapper attempts across batches and preserves previously retained bindings', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request, { maxRecords: 2 });
    try {
      stage.captureConstructorBindings([constructorFixture()]);
      const bytes = stage.bytes;
      for (let i = 0; i < 20; i++)
        stage.captureConstructorBindings([
          { filePath: 'invalid.ts', bindings: null } as unknown as FileConstructorBindings,
        ]);
      stage.captureConstructorBindings([constructorFixture()]);
      expect(stage.constructorBindingRecordCount).toBe(1);
      expect(stage.bytes).toBe(bytes);
      expect(request.artifactAllowance.remainingBytes).toBe(allowance - bytes);
      expect(stage.reasons).toEqual(
        expect.arrayContaining(['constructor-binding-invalid', 'constructor-binding-count-limit']),
      );
      expect(await replayConstructors(stage)).toEqual([constructorFixture()]);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('rejects malformed, inherited, accessor and proxy wrappers and nested bindings without executing them', async () => {
    const getter = vi.fn(() => 'Service');
    const trap = vi.fn(() => {
      throw new Error('proxy trap invoked');
    });
    const binding = constructorFixture().bindings[0]!;
    const proxy = (value: object) =>
      new Proxy(value, { ownKeys: trap, get: trap, getPrototypeOf: trap });
    const invalidBindings = [
      { ...binding, extra: true },
      { ...binding, scope: 1 },
      { ...binding, varName: null },
      { ...binding, calleeName: undefined },
      { ...binding, receiverClassName: 1 },
      Object.assign(Object.create({ calleeName: 'Service' }), {
        scope: 'module',
        varName: 'service',
      }),
      Object.assign(Object.create({ receiverClassName: 'Client' }), binding),
      Object.defineProperty({ ...binding }, 'calleeName', { get: getter }),
      Object.defineProperty({ ...binding }, 'receiverClassName', { get: getter }),
      proxy(binding),
    ];
    const invalid = [
      ...invalidBindings.map((record) => ({ filePath: 'one.ts', bindings: [record] })),
      { ...constructorFixture(), extra: true },
      Object.assign(Object.create({ filePath: 'one.ts' }), { bindings: [binding] }),
      Object.defineProperty(constructorFixture(), 'filePath', { get: getter }),
      Object.defineProperty(constructorFixture(), 'bindings', { get: getter }),
      { filePath: 'one.ts', bindings: proxy([binding]) },
      proxy(constructorFixture()),
    ];
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureConstructorBindings(invalid as FileConstructorBindings[]);
      stage.captureConstructorBindings(proxy([constructorFixture()]) as FileConstructorBindings[]);
      expect(getter).not.toHaveBeenCalled();
      expect(trap).not.toHaveBeenCalled();
      expect(stage.constructorBindingRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.reasons).toContain('constructor-binding-invalid');
      expect(await replayConstructors(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'stops capture and suspended replay after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage(
        { ...request, signal: controller.signal },
        { batchRecords: 1 },
      );
      try {
        stage.captureConstructorBindings([constructorFixture(), constructorFixture()]);
        const iterator = stage.iterateConstructorBindings()[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toHaveLength(1);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') await stage.dispose();
        stage.captureConstructorBindings([constructorFixture()]);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.constructorBindingRecordCount).toBeLessThanOrEqual(2);
        expect(stage.reasons).toContain(guard);
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('checks cancellation again before yielding constructor bindings', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage({ ...options(), signal: controller.signal });
    try {
      stage.captureConstructorBindings([constructorFixture()]);
      const next = stage.iterateConstructorBindings()[Symbol.asyncIterator]().next();
      controller.abort();
      expect((await next).done).toBe(true);
      expect(stage.reasons).toContain('cancelled');
    } finally {
      await stage.dispose();
    }
  });

  it('shares replay exclusion with every family and releases it on return', async () => {
    const stage = new ScopeRetentionStage(options(), { batchRecords: 1 });
    try {
      stage.captureConstructorBindings([constructorFixture(), constructorFixture()]);
      const iterator = stage.iterateConstructorBindings()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toHaveLength(1);
      for (const other of [
        stage.iterateConstructorBindings(),
        stage.iterateAssignments(),
        stage.iterateHeritage(),
        stage.iterateCalls(),
        stage.iterate(),
      ]) {
        await expect(other[Symbol.asyncIterator]().next()).rejects.toThrow();
      }
      await iterator.return?.();
      expect(await replayConstructors(stage)).toEqual([constructorFixture(), constructorFixture()]);
    } finally {
      await stage.dispose();
    }
  });
});

function assignmentFixture(): ExtractedAssignment {
  return {
    filePath: 'one.ts',
    sourceId: 'Function:one.ts:caller',
    receiverText: 'service',
    propertyName: 'value',
  };
}

async function replayAssignments(stage: ScopeRetentionStage): Promise<ExtractedAssignment[]> {
  const assignment: ExtractedAssignment[] = [];
  for await (const batch of stage.iterateAssignments()) assignment.push(...batch);
  return assignment;
}

describe('original parser assignment retention', () => {
  it('detaches producer inputs, batches replay, isolates replay mutations, and refunds disposal once', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    const assignment = [
      assignmentFixture(),
      { ...assignmentFixture(), receiverTypeName: 'Service' },
    ];
    const expected = structuredClone(assignment);
    try {
      stage.captureAssignments(assignment);
      assignment[0]!.propertyName = 'EnrichedProperty';
      assignment[1]!.receiverTypeName = 'EnrichedService';
      assignment.length = 0;
      const batches: (readonly ExtractedAssignment[])[] = [];
      for await (const batch of stage.iterateAssignments()) batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
      expect(batches.flat()).toEqual(expected);
      expect(Object.hasOwn(batches[0]![0]!, 'receiverTypeName')).toBe(false);
      batches[0]![0]!.propertyName = 'ReplayMutation';
      expect(await replayAssignments(stage)).toEqual(expected);
      expect(stage.assignmentRecordCount).toBe(2);
      expect(stage.recordCount + stage.callRecordCount).toBe(0);
      expect(stage.assignmentEvidenceScope).toBe('observed-parser-inputs');
      expect(stage.seedReady).toBe(false);
      expect(request.artifactAllowance.remainingBytes).toBeLessThan(allowance);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    await stage.dispose();
    stage.captureAssignments([assignmentFixture()]);
    expect(await replayAssignments(stage)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('accepts empty observed assignment without claiming complete seed evidence', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.captureAssignments([]);
      expect(stage.assignmentRecordCount).toBe(0);
      expect(stage.assignmentEvidenceScope).toBe('observed-parser-inputs');
      expect(stage.seedReady).toBe(false);
      expect(await replayAssignments(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['scope', 'call', 'heritage', 'assignment'] as const)(
    'counts assignment with both scopes and calls when %s reaches the ceiling last',
    async (last) => {
      const stage = new ScopeRetentionStage(options(), { maxRecords: 3 });
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        heritage: () => stage.captureHeritage([heritageFixture()]),
        assignment: () => stage.captureAssignments([assignmentFixture()]),
      };
      try {
        for (const kind of ['scope', 'call', 'heritage', 'assignment'] as const)
          if (kind !== last) capture[kind]();
        capture[last]();
        expect(
          stage.recordCount +
            stage.callRecordCount +
            stage.heritageRecordCount +
            stage.assignmentRecordCount,
        ).toBe(3);
        expect(stage.reasons).toContain(
          last === 'scope' ? 'record-count-limit' : `${last}-count-limit`,
        );
        expect(stage.status).toBe('incomplete');
        expect(stage.seedReady).toBe(false);
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['allowance', 'aggregate bytes', 'record bytes', 'batch bytes'] as const)(
    'refuses assignment above the %s ceiling',
    async (ceiling) => {
      const request = options(ceiling === 'allowance' ? 0 : 1024 * 1024);
      const allowance = request.artifactAllowance.remainingBytes;
      const stage = new ScopeRetentionStage(
        request,
        ceiling === 'aggregate bytes'
          ? { maxBytes: 1 }
          : ceiling === 'record bytes'
            ? { maxRecordBytes: 1 }
            : ceiling === 'batch bytes'
              ? { batchBytes: 1 }
              : undefined,
      );
      try {
        stage.captureAssignments([assignmentFixture()]);
        expect(stage.assignmentRecordCount).toBe(0);
        expect(stage.bytes).toBe(0);
        expect(stage.reasons).toContain('assignment-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    },
  );

  it.each(['scope', 'call', 'heritage', 'assignment'] as const)(
    'shares exact aggregate bytes across all four families with %s admitted last',
    async (last) => {
      const probe = new ScopeRetentionStage(options());
      probe.captureCalls([callFixture()]);
      probe.captureHeritage([heritageFixture()]);
      probe.captureAssignments([assignmentFixture()]);
      const totalBytes = probe.bytes + Buffer.byteLength(encodeParsedFileRecord(fixture('one.ts')));
      await probe.dispose();
      const request = options(totalBytes + 1);
      const stage = new ScopeRetentionStage(request, { maxBytes: totalBytes });
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        heritage: () => stage.captureHeritage([heritageFixture()]),
        assignment: () => stage.captureAssignments([assignmentFixture()]),
      };
      try {
        for (const kind of ['scope', 'call', 'heritage', 'assignment'] as const)
          if (kind !== last) capture[kind]();
        capture[last]();
        expect([
          stage.recordCount,
          stage.callRecordCount,
          stage.heritageRecordCount,
          stage.assignmentRecordCount,
        ]).toEqual([1, 1, 1, 1]);
        expect(stage.bytes).toBe(totalBytes);
        expect(request.artifactAllowance.remainingBytes).toBe(1);
        expect(await replay(stage)).toEqual([fixture('one.ts')]);
        expect(await replayCalls(stage)).toEqual([callFixture()]);
        expect(await replayHeritage(stage)).toEqual([heritageFixture()]);
        expect(await replayAssignments(stage)).toEqual([assignmentFixture()]);
        stage.captureAssignments([assignmentFixture()]);
        expect(stage.assignmentRecordCount).toBe(1);
        expect(stage.reasons).toContain('assignment-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(totalBytes + 1);
    },
  );

  it('omits an explicitly undefined optional receiver type', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      stage.captureAssignments([{ ...assignmentFixture(), receiverTypeName: undefined }]);
      const assignments = await replayAssignments(stage);
      expect(assignments).toEqual([assignmentFixture()]);
      expect(Object.hasOwn(assignments[0]!, 'receiverTypeName')).toBe(false);
    } finally {
      await stage.dispose();
    }
  });

  it('rejects malformed, inherited, accessor, and proxy records without invoking their code', async () => {
    const getter = vi.fn(() => 'Base');
    const trap = vi.fn(() => {
      throw new Error('proxy trap invoked');
    });
    const accessor = Object.defineProperty(assignmentFixture(), 'propertyName', { get: getter });
    const inherited = Object.assign(Object.create({ propertyName: 'Base' }), {
      filePath: 'one.ts',
      sourceId: 'Function:one.ts:caller',
      receiverText: 'service',
    });
    const invalid = [
      { ...assignmentFixture(), extra: true },
      { ...assignmentFixture(), propertyName: 1 },
      { ...assignmentFixture(), receiverTypeName: 1 },
      { filePath: 'one.ts', receiverText: 'service', propertyName: 'value' },
      inherited,
      accessor,
      new Proxy(assignmentFixture(), { ownKeys: trap, get: trap, getPrototypeOf: trap }),
    ];
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureAssignments(invalid as ExtractedAssignment[]);
      expect(getter).not.toHaveBeenCalled();
      expect(trap).not.toHaveBeenCalled();
      expect(stage.assignmentRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.reasons).toContain('assignment-invalid');
      expect(await replayAssignments(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'stops assignment capture and active replay after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage(
        { ...request, signal: controller.signal },
        { batchRecords: 1 },
      );
      try {
        stage.captureAssignments([assignmentFixture(), assignmentFixture()]);
        const iterator = stage.iterateAssignments()[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toHaveLength(1);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') await stage.dispose();
        stage.captureAssignments([assignmentFixture()]);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.assignmentRecordCount).toBeLessThanOrEqual(2);
        expect(stage.reasons).toContain(guard);
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('checks cancellation again before yielding assignment', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage({ ...options(), signal: controller.signal });
    try {
      stage.captureAssignments([assignmentFixture()]);
      const next = stage.iterateAssignments()[Symbol.asyncIterator]().next();
      controller.abort();
      expect((await next).done).toBe(true);
      expect(stage.reasons).toContain('cancelled');
    } finally {
      await stage.dispose();
    }
  });

  it('shares the replay guard with calls and scopes and releases it on return', async () => {
    const stage = new ScopeRetentionStage(options(), { batchRecords: 1 });
    try {
      stage.captureAssignments([assignmentFixture(), assignmentFixture()]);
      const iterator = stage.iterateAssignments()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toHaveLength(1);
      await expect(stage.iterateAssignments()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await expect(stage.iterateCalls()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await expect(stage.iterateHeritage()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await expect(stage.iterate()[Symbol.asyncIterator]().next()).rejects.toThrow();
      await iterator.return?.();
      expect(await replayAssignments(stage)).toEqual([assignmentFixture(), assignmentFixture()]);
    } finally {
      await stage.dispose();
    }
  });
});

function ormQueryFixture(): ExtractedORMQuery {
  return {
    filePath: 'src/é😀.ts',
    orm: 'prisma',
    model: 'User',
    method: 'findMany',
    lineNumber: 0,
  };
}

async function replayORMQueries(stage: ScopeRetentionStage): Promise<ExtractedORMQuery[]> {
  const records: ExtractedORMQuery[] = [];
  for await (const batch of stage.iterateORMQueries()) records.push(...batch);
  return records;
}

describe('original parser ORM query retention', () => {
  it('detaches inputs and each replay, batches records, and refunds disposal once', async () => {
    const request = options();
    const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
    const records = [ormQueryFixture(), { ...ormQueryFixture(), orm: 'supabase' as const }];
    const expected = structuredClone(records);
    try {
      stage.captureORMQueries(records);
      records[0]!.model = 'Enriched';
      records.length = 0;
      const batches: (readonly ExtractedORMQuery[])[] = [];
      for await (const batch of stage.iterateORMQueries()) batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
      expect(batches.flat()).toEqual(expected);
      batches[0]![0]!.method = 'ReplayMutation';
      expect(await replayORMQueries(stage)).toEqual(expected);
      expect(stage.ormQueryRecordCount).toBe(2);
      expect(stage.ormQueryEvidenceScope).toBe('observed-parser-inputs');
      expect(stage.seedReady).toBe(false);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024 - stage.bytes);
    } finally {
      await stage.dispose();
    }
    await stage.dispose();
    stage.captureORMQueries([ormQueryFixture()]);
    expect(await replayORMQueries(stage)).toEqual([]);
    expect(stage.ormQueryRecordCount).toBe(0);
    expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
  });

  it('distinguishes a successful empty producer from an unobserved one', async () => {
    const stage = new ScopeRetentionStage(options());
    try {
      expect(stage.producerCompletion['orm-queries']).toBe(false);
      stage.captureORMQueries([]);
      expect(stage.producerCompletion['orm-queries']).toBe(false);
      stage.markProducerCompleted('orm-queries');
      expect(stage.producerCompletion['orm-queries']).toBe(true);
      expect(stage.ormQueryRecordCount).toBe(0);
      expect(await replayORMQueries(stage)).toEqual([]);
      expect(stage.seedReady).toBe(false);
      stage.captureORMQueries([]);
      expect(stage.producerCompletion['orm-queries']).toBe(false);
    } finally {
      await stage.dispose();
    }
  });

  it('rejects malformed, inherited, proxy and accessor records without invoking their code', async () => {
    const getter = vi.fn(() => 'User');
    const trap = vi.fn(() => {
      throw new Error('proxy trap invoked');
    });
    const missing = { ...ormQueryFixture() } as Partial<ExtractedORMQuery>;
    delete missing.model;
    const invalid: unknown[] = [
      null,
      [],
      missing,
      { ...ormQueryFixture(), extra: true },
      { ...ormQueryFixture(), [Symbol('extra')]: true },
      { ...ormQueryFixture(), orm: 'other' },
      ...['filePath', 'model', 'method'].map((key) => ({ ...ormQueryFixture(), [key]: 1 })),
      ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined].map(
        (lineNumber) => ({ ...ormQueryFixture(), lineNumber }),
      ),
      Object.assign(Object.create({ model: 'User' }), missing),
      Object.defineProperty(ormQueryFixture(), 'model', { get: getter }),
      new Proxy(ormQueryFixture(), { ownKeys: trap, get: trap, getPrototypeOf: trap }),
    ];
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      stage.markProducerCompleted('orm-queries');
      stage.captureORMQueries(invalid as ExtractedORMQuery[]);
      stage.markProducerCompleted('orm-queries');
      expect(getter).not.toHaveBeenCalled();
      expect(trap).not.toHaveBeenCalled();
      expect(stage.ormQueryRecordCount).toBe(0);
      expect(stage.bytes).toBe(0);
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      expect(stage.reasons).toContain('orm-query-invalid');
      expect(stage.producerCompletion['orm-queries']).toBe(false);
      expect(await replayORMQueries(stage)).toEqual([]);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['allowance', 'aggregate bytes', 'record bytes', 'batch bytes'] as const)(
    'refuses queries above the %s ceiling',
    async (ceiling) => {
      const request = options(ceiling === 'allowance' ? 0 : 1024 * 1024);
      const allowance = request.artifactAllowance.remainingBytes;
      const stage = new ScopeRetentionStage(
        request,
        ceiling === 'aggregate bytes'
          ? { maxBytes: 1 }
          : ceiling === 'record bytes'
            ? { maxRecordBytes: 1 }
            : ceiling === 'batch bytes'
              ? { batchBytes: 1 }
              : undefined,
      );
      try {
        stage.captureORMQueries([ormQueryFixture()]);
        expect(stage.ormQueryRecordCount).toBe(0);
        expect(stage.reasons).toContain('orm-query-byte-limit');
        expect(stage.bytes).toBe(0);
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    },
  );

  it.each(['utf8', 'json escaping'] as const)(
    'bounds %s bytes before admitting records',
    async (mode) => {
      const stage = new ScopeRetentionStage(options(), { maxRecordBytes: 128 });
      try {
        stage.captureORMQueries([
          { ...ormQueryFixture(), model: mode === 'utf8' ? '界'.repeat(50) : '\n'.repeat(60) },
        ]);
        expect(stage.ormQueryRecordCount).toBe(0);
        expect(stage.bytes).toBe(0);
        expect(stage.reasons).toContain('orm-query-byte-limit');
      } finally {
        await stage.dispose();
      }
    },
  );

  it('counts rejected attempts and preserves parsed-file record reservations', async () => {
    const rejected = new ScopeRetentionStage(options(), { maxRecords: 1 });
    const reserved = new ScopeRetentionStage(options(), { maxRecords: 2 });
    try {
      rejected.captureORMQueries([{ ...ormQueryFixture(), lineNumber: -1 }]);
      rejected.captureORMQueries([ormQueryFixture()]);
      expect(rejected.ormQueryRecordCount).toBe(0);
      expect(rejected.reasons).toContain('orm-query-count-limit');
      reserved.reserveParsedFileRecords(1);
      reserved.captureORMQueries([ormQueryFixture(), ormQueryFixture()]);
      reserved.capture([fixture('one.ts')]);
      expect(reserved.ormQueryRecordCount).toBe(1);
      expect(reserved.recordCount).toBe(1);
      expect(await replay(reserved)).toEqual([fixture('one.ts')]);
    } finally {
      await rejected.dispose();
      await reserved.dispose();
    }
  });

  it.each(['scope', 'call', 'assignment', 'orm'] as const)(
    'shares record ceilings when %s is admitted last',
    async (last) => {
      const stage = new ScopeRetentionStage(options(), { maxRecords: 3 });
      const capture = {
        scope: () => stage.capture([fixture('one.ts')]),
        call: () => stage.captureCalls([callFixture()]),
        assignment: () => stage.captureAssignments([assignmentFixture()]),
        orm: () => stage.captureORMQueries([ormQueryFixture()]),
      };
      try {
        for (const kind of ['scope', 'call', 'assignment', 'orm'] as const)
          if (kind !== last) capture[kind]();
        capture[last]();
        expect(
          stage.recordCount +
            stage.callRecordCount +
            stage.assignmentRecordCount +
            stage.ormQueryRecordCount,
        ).toBe(3);
        expect(stage.reasons).toContain(
          last === 'scope'
            ? 'record-count-limit'
            : last === 'orm'
              ? 'orm-query-count-limit'
              : `${last}-count-limit`,
        );
      } finally {
        await stage.dispose();
      }
    },
  );

  it.each(['scope', 'orm'] as const)(
    'replays mixed parsed and ORM records at the exact shared byte ceiling with %s last',
    async (last) => {
      const ormBytes = Buffer.byteLength(JSON.stringify(ormQueryFixture()));
      const totalBytes = ormBytes + Buffer.byteLength(encodeParsedFileRecord(fixture('one.ts')));
      const request = options(totalBytes + 1);
      const stage = new ScopeRetentionStage(request, { maxBytes: totalBytes });
      try {
        if (last === 'scope') stage.captureORMQueries([ormQueryFixture()]);
        stage.capture([fixture('one.ts')]);
        if (last === 'orm') stage.captureORMQueries([ormQueryFixture()]);
        expect(stage.bytes).toBe(totalBytes);
        expect(request.artifactAllowance.remainingBytes).toBe(1);
        expect(await replay(stage)).toEqual([fixture('one.ts')]);
        expect(await replayORMQueries(stage)).toEqual([ormQueryFixture()]);
        stage.captureORMQueries([ormQueryFixture()]);
        expect(stage.ormQueryRecordCount).toBe(1);
        expect(stage.reasons).toContain('orm-query-byte-limit');
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(totalBytes + 1);
    },
  );

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'stops active ORM replay and capture after %s',
    async (guard) => {
      const controller = new AbortController();
      const request = { ...options(), signal: controller.signal };
      const stage = new ScopeRetentionStage(request, { batchRecords: 1 });
      try {
        stage.captureORMQueries([ormQueryFixture(), ormQueryFixture()]);
        const iterator = stage.iterateORMQueries()[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toHaveLength(1);
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') request.deadline = 0;
        if (guard === 'disposed') await stage.dispose();
        stage.captureORMQueries([ormQueryFixture()]);
        expect((await iterator.next()).done).toBe(true);
        expect(stage.ormQueryRecordCount).toBe(guard === 'disposed' ? 0 : 2);
        expect(stage.reasons).toContain(guard);
        expect(stage.producerCompletion['orm-queries']).toBe(false);
      } finally {
        await stage.dispose();
      }
      expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('checks cancellation before yielding and shares replay exclusion with other families', async () => {
    const controller = new AbortController();
    const stage = new ScopeRetentionStage(
      { ...options(), signal: controller.signal },
      { batchRecords: 1 },
    );
    try {
      stage.captureORMQueries([ormQueryFixture(), ormQueryFixture()]);
      const iterator = stage.iterateORMQueries()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toHaveLength(1);
      for (const other of [
        stage.iterateORMQueries(),
        stage.iterateCalls(),
        stage.iterateAssignments(),
        stage.iterate(),
      ]) {
        await expect(other[Symbol.asyncIterator]().next()).rejects.toMatchObject({
          reason: 'concurrent-replay',
        });
      }
      await iterator.return?.();
      expect(await replayORMQueries(stage)).toEqual([ormQueryFixture(), ormQueryFixture()]);
      const pending = stage.iterateORMQueries()[Symbol.asyncIterator]().next();
      controller.abort();
      expect((await pending).done).toBe(true);
      expect(stage.reasons).toContain('cancelled');
    } finally {
      await stage.dispose();
    }
  });
});

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
  it('retains one immutable parser code identity, deduplicates its bytes and refunds disposal once', async () => {
    const request = options();
    const allowance = request.artifactAllowance.remainingBytes;
    const stage = new ScopeRetentionStage(request);
    const identity = '0123456789abcdef'.repeat(4);
    try {
      expect(stage.inputEvidence.parserCodeIdentity).toBeNull();
      stage.captureParserCodeIdentity(identity);
      const remaining = request.artifactAllowance.remainingBytes;
      expect(remaining).toBeLessThan(allowance);
      const evidence = stage.inputEvidence;
      expect(evidence.parserCodeIdentity).toBe(identity);
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Reflect.set(evidence, 'parserCodeIdentity', '0'.repeat(64))).toBe(false);
      stage.captureParserCodeIdentity(identity);
      expect(request.artifactAllowance.remainingBytes).toBe(remaining);
      expect(stage.inputEvidence.parserCodeIdentity).toBe(identity);
      expect(stage.seedReady).toBe(false);
    } finally {
      await stage.dispose();
    }
    expect(stage.inputEvidence.parserCodeIdentity).toBeNull();
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    await stage.dispose();
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it.each([
    undefined,
    null,
    1,
    {},
    [],
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
  ])('rejects invalid parser code identity %j without reserving bytes', async (invalid) => {
    const request = options();
    const stage = new ScopeRetentionStage(request);
    try {
      const allowance = request.artifactAllowance.remainingBytes;
      stage.captureParserCodeIdentity(invalid);
      expect(stage.inputEvidence.parserCodeIdentity).toBeNull();
      expect(stage.inputEvidence.complete).toBe(false);
      expect(stage.inputEvidence.reasons).toContain('parser-code-identity-invalid');
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    } finally {
      await stage.dispose();
    }
  });

  it.each(['conflicting', 'unavailable'] as const)(
    'keeps the first parser code identity after a %s observation',
    async (observation) => {
      const request = options();
      const stage = new ScopeRetentionStage(request);
      try {
        stage.captureDiscovery(['one.ts'], [{ path: 'one.ts', size: 8 }], []);
        stage.captureConfigObservations(configuration());
        stage.captureParserInputs([{ path: 'one.ts', content: 'original' }]);
        stage.capture([fixture('one.ts')]);
        stage.recordOutcomes([{ filePath: 'one.ts', status: 'success' }]);
        stage.reconcile(['one.ts']);
        stage.captureParserCodeIdentity('a'.repeat(64));
        expect(stage.inputEvidence.complete).toBe(true);
        const remaining = request.artifactAllowance.remainingBytes;
        if (observation === 'conflicting') stage.captureParserCodeIdentity('b'.repeat(64));
        else stage.markParserCodeIdentityUnavailable();
        stage.captureParserCodeIdentity('a'.repeat(64));
        expect(stage.inputEvidence.parserCodeIdentity).toBe('a'.repeat(64));
        expect(stage.inputEvidence.complete).toBe(false);
        expect(stage.inputEvidence.reasons).toContain(
          observation === 'conflicting'
            ? 'parser-code-identity-conflict'
            : 'parser-code-identity-unavailable',
        );
        expect(request.artifactAllowance.remainingBytes).toBe(remaining);
        expect(stage.status).toBe('retained');
        expect(await replay(stage)).toEqual([fixture('one.ts')]);
      } finally {
        await stage.dispose();
      }
    },
  );

  it('refuses parser code identity without byte allowance', async () => {
    const request = options(0);
    const stage = new ScopeRetentionStage(request);
    try {
      stage.captureParserCodeIdentity('a'.repeat(64));
      expect(stage.inputEvidence.parserCodeIdentity).toBeNull();
      expect(stage.inputEvidence.complete).toBe(false);
      expect(stage.inputEvidence.reasons).toContain('input-byte-limit');
      expect(request.artifactAllowance.remainingBytes).toBe(0);
    } finally {
      await stage.dispose();
    }
    expect(request.artifactAllowance.remainingBytes).toBe(0);
  });

  it.each(['cancelled', 'deadline', 'disposed'] as const)(
    'guards parser code identity capture after %s',
    async (guard) => {
      const request = options();
      const controller = new AbortController();
      const stage = new ScopeRetentionStage({ ...request, signal: controller.signal });
      try {
        if (guard === 'cancelled') controller.abort();
        if (guard === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(request.deadline + 1);
        if (guard === 'disposed') await stage.dispose();
        stage.captureParserCodeIdentity('a'.repeat(64));
        stage.markParserCodeIdentityUnavailable();
        expect(stage.inputEvidence.parserCodeIdentity).toBeNull();
        expect(stage.inputEvidence.complete).toBe(false);
        expect(request.artifactAllowance.remainingBytes).toBe(1024 * 1024);
      } finally {
        vi.restoreAllMocks();
        await stage.dispose();
      }
    },
  );

  it('detaches and freezes original UTF-8 source identities and configuration records', async () => {
    const stage = new ScopeRetentionStage(options());
    const config = configuration();
    const expectedConfig = JSON.parse(JSON.stringify(config));
    const content = 'export const greeting = "é😀";\n';
    const source = { path: 'one.ts', content };
    try {
      stage.captureDiscovery(
        ['one.ts'],
        [{ path: 'one.ts', size: Buffer.byteLength(content) }],
        [],
      );
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
        parserCodeIdentity: null,
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
      stage.captureDiscovery(['one.ts'], [{ path: 'one.ts', size: 8 }], []);
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
      stage.captureDiscovery(['one.ts'], [{ path: 'one.ts', size: 8 }], []);
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
      expect(stage.inputEvidence.reasons).toEqual([
        'source-invalid-utf8',
        'discovery-incomplete',
        'missing-source',
      ]);
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
        stage.captureDiscovery(['one.ts'], [{ path: 'one.ts', size: 8 }], []);
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
      stage.captureDiscovery(['one.ts'], [{ path: 'one.ts', size: 8 }], []);
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
  it('round trips a 400 KiB parsed file while retaining separate hard graph and parsed-file bounds', () => {
    const input = fixture('large.ts');
    input.referenceSites = Array.from({ length: 3100 }, (_, index) => ({
      name: `reference${index}`,
      inScope: input.moduleScope,
      kind: 'read' as const,
      atRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
    }));
    const encoded = encodeParsedFileRecord(input);
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(350 * 1024);
    expect(Buffer.byteLength(encoded)).toBeLessThan(450 * 1024);
    expect(decodeParsedFileRecord(encoded)).toEqual(input);
    expect(() => encodeParsedFileRecord(input, MAX_PARSED_FILE_RECORD_BYTES + 1)).toThrow(
      'invalid-limit',
    );
    expect(() => encodeGraphNodeRecord({}, MAX_GRAPH_RECORD_BYTES + 1)).toThrow('invalid-limit');
    expect(() => encodeGraphRelationshipRecord({}, MAX_GRAPH_RECORD_BYTES + 1)).toThrow(
      'invalid-limit',
    );
    input.referenceSites[0]!.name = 'x'.repeat(MAX_PARSED_FILE_RECORD_BYTES);
    expect(() => encodeParsedFileRecord(input)).toThrow('record-byte-limit');
    expect(() => decodeParsedFileRecord(' '.repeat(MAX_PARSED_FILE_RECORD_BYTES + 1))).toThrow(
      'record-byte-limit',
    );
  });

  it.each([undefined, null, 'def:exact-owner'] as const)(
    'round trips scope owner metadata %s without conflating absent and null',
    (ownerDefId) => {
      const input = fixture();
      if (ownerDefId !== undefined) Object.assign(input.scopes[1]!, { ownerDefId });
      const encoded = encodeParsedFileRecord(input);
      const restored = decodeParsedFileRecord(encoded);
      expect(restored).toEqual(input);
      expect(Object.hasOwn(restored.scopes[1]!, 'ownerDefId')).toBe(ownerDefId !== undefined);
      expect(restored.scopes[1]!.ownerDefId).toBe(ownerDefId);
      expect(encodeParsedFileRecord(restored)).toBe(encoded);
    },
  );

  it.each([42, true, {}, []])(
    'rejects invalid scope owner metadata during capture and replay: %j',
    (ownerDefId) => {
      const input = fixture();
      Object.assign(input.scopes[1]!, { ownerDefId });
      expect(() => encodeParsedFileRecord(input)).toThrow(ParsedFileRecordError);
      const wire = JSON.parse(encodeParsedFileRecord(fixture()));
      wire.parsedFile.scopes[1].ownerDefId = ownerDefId;
      expect(() => decodeParsedFileRecord(JSON.stringify(wire))).toThrow(ParsedFileRecordError);
    },
  );

  const receiverRange = { startLine: 3, startCol: 0, endLine: 3, endCol: 4 };
  const chainReceiver = () => ({
    kind: 'chain' as const,
    root: { name: 'user', range: { ...receiverRange } },
    steps: [
      { kind: 'member' as const, name: 'profile', range: { ...receiverRange } },
      { kind: 'call' as const, arity: 0, range: { ...receiverRange } },
    ],
  });
  const withReceiver = (receiver: unknown) => {
    const file = fixture();
    (file.referenceSites[0] as { explicitReceiver: ExplicitReceiver }).explicitReceiver =
      receiver as ExplicitReceiver;
    return file;
  };

  it('preserves legacy receiver encoding and envelope version', () => {
    const encoded = encodeParsedFileRecord(fixture());
    expect(encoded).toContain('"explicitReceiver":{"name":"user"},"arity":2');
    expect(JSON.parse(encoded).version).toBe(1);
    expect(encodeParsedFileRecord(decodeParsedFileRecord(encoded))).toBe(encoded);
  });

  it('round trips detached receiver chains and includes them in exact byte admission', () => {
    const receiver = chainReceiver();
    const input = withReceiver(receiver);
    const encoded = encodeParsedFileRecord(input);
    const bytes = Buffer.byteLength(encoded);
    expect(encodeParsedFileRecord(input, bytes)).toBe(encoded);
    expect(() => encodeParsedFileRecord(input, bytes - 1)).toThrow(ParsedFileRecordError);
    const restored = decodeParsedFileRecord(encoded);
    expect(restored).toEqual(input);
    expect(restored.referenceSites[0]!.explicitReceiver).not.toBe(receiver);
    receiver.root.name = 'changed';
    receiver.root.range.startCol = 100;
    receiver.steps[0]!.range.startCol = 100;
    receiver.steps.splice(0);
    expect(restored.referenceSites[0]!.explicitReceiver).toEqual(chainReceiver());
  });

  it('accepts the inclusive receiver step and arity bounds', () => {
    const receiver = chainReceiver();
    receiver.steps = Array.from({ length: 64 }, () => ({
      kind: 'call' as const,
      arity: Number.MAX_SAFE_INTEGER,
      range: { ...receiverRange },
    }));
    const input = withReceiver(receiver);
    expect(decodeParsedFileRecord(encodeParsedFileRecord(input))).toEqual(input);
  });

  it.each([
    { name: 'user', kind: 'unknown' },
    { kind: null, name: 'user' },
    { kind: 'member', name: 'user' },
    { ...chainReceiver(), name: 'extra' },
    { ...chainReceiver(), root: { name: 'user' } },
    { ...chainReceiver(), steps: [] },
    { ...chainReceiver(), steps: Array.from({ length: 65 }, () => chainReceiver().steps[0]) },
    { ...chainReceiver(), steps: [{ kind: 'unknown', range: receiverRange }] },
    { ...chainReceiver(), steps: [{ kind: 'member', name: 'x', range: receiverRange, arity: 0 }] },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((arity) => ({
      ...chainReceiver(),
      steps: [{ kind: 'call', arity, range: receiverRange }],
    })),
    { ...chainReceiver(), steps: [{ kind: 'call', range: receiverRange }] },
  ])('rejects malformed receivers during capture and replay: %j', (receiver) => {
    expect(() => encodeParsedFileRecord(withReceiver(receiver))).toThrow(ParsedFileRecordError);
    const wire = JSON.parse(encodeParsedFileRecord(fixture()));
    wire.parsedFile.referenceSites[0].explicitReceiver = receiver;
    expect(() => decodeParsedFileRecord(JSON.stringify(wire))).toThrow(ParsedFileRecordError);
  });

  it.each([NaN, Infinity, -Infinity, -0])('rejects invalid receiver arity %s', (arity) => {
    const receiver = { ...chainReceiver(), steps: [{ kind: 'call', arity, range: receiverRange }] };
    expect(() => encodeParsedFileRecord(withReceiver(receiver))).toThrow(ParsedFileRecordError);
  });

  it('rejects an explicitly undefined receiver discriminator', () => {
    expect(() => encodeParsedFileRecord(withReceiver({ kind: undefined, name: 'user' }))).toThrow(
      ParsedFileRecordError,
    );
    const wire = JSON.parse(encodeParsedFileRecord(fixture()));
    wire.parsedFile.referenceSites[0].explicitReceiver.kind = { $undefined: true };
    expect(() => decodeParsedFileRecord(JSON.stringify(wire))).toThrow(ParsedFileRecordError);
  });

  it('rejects receiver accessors and proxies without invoking them', () => {
    const getter = vi.fn(() => {
      throw new Error('must not execute');
    });
    const proxy = (value: object) =>
      new Proxy(value, {
        get: getter,
        getOwnPropertyDescriptor: getter,
        getPrototypeOf: getter,
        ownKeys: getter,
      });
    const malformed: unknown[] = [proxy(chainReceiver())];
    for (const key of ['kind', 'root', 'steps']) {
      malformed.push(Object.defineProperty(chainReceiver(), key, { get: getter }));
    }
    malformed.push({ ...chainReceiver(), root: proxy(chainReceiver().root) });
    malformed.push({ ...chainReceiver(), steps: proxy(chainReceiver().steps) });
    malformed.push({ ...chainReceiver(), steps: [proxy(chainReceiver().steps[0]!)] });
    malformed.push({
      ...chainReceiver(),
      steps: [Object.defineProperty(chainReceiver().steps[0]!, 'kind', { get: getter })],
    });
    malformed.push({
      ...chainReceiver(),
      steps: [Object.defineProperty(chainReceiver().steps[1]!, 'arity', { get: getter })],
    });
    malformed.push({
      ...chainReceiver(),
      root: {
        name: 'user',
        range: Object.defineProperty({ ...receiverRange }, 'startLine', { get: getter }),
      },
    });
    malformed.push({ ...chainReceiver(), steps: Object.defineProperty([], '0', { get: getter }) });
    malformed.push({
      ...chainReceiver(),
      steps: Object.defineProperty([], '0', {
        value: chainReceiver().steps[0],
        enumerable: false,
      }),
    });
    for (const receiver of malformed)
      expect(() => encodeParsedFileRecord(withReceiver(receiver))).toThrow(ParsedFileRecordError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['absent', 'undefined', 'empty', 'populated'] as const)(
    'round trips %s export metadata without collapsing presence or order',
    (state) => {
      const input = fixture();
      if (state !== 'absent')
        input.exports =
          state === 'undefined'
            ? undefined
            : new Map(
                state === 'empty'
                  ? []
                  : [
                      ['PublicZ', 'def:z'],
                      ['PublicA', 'def:a'],
                    ],
              );
      const output = decodeParsedFileRecord(encodeParsedFileRecord(input));
      expect(output).toEqual(input);
      expect(Object.hasOwn(output, 'exports')).toBe(state !== 'absent');
      if (state === 'populated') {
        expect([...output.exports!]).toEqual([
          ['PublicZ', 'def:z'],
          ['PublicA', 'def:a'],
        ]);
        (input.exports as Map<string, string>).clear();
        expect(output.exports!.size).toBe(2);
      }
    },
  );

  it('includes export names and definition IDs in the exact byte allowance', () => {
    const input = fixture();
    const withoutExports = Buffer.byteLength(encodeParsedFileRecord(input), 'utf8');
    input.exports = new Map([['é😀\\"\n', 'def:é😀']]);
    const encoded = encodeParsedFileRecord(input);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    expect(bytes).toBeGreaterThan(withoutExports);
    expect(encodeParsedFileRecord(input, bytes)).toBe(encoded);
    expect(() => encodeParsedFileRecord(input, bytes - 1)).toThrow(ParsedFileRecordError);
    expect(() => encodeParsedFileRecord(input, withoutExports)).toThrow(ParsedFileRecordError);
  });

  it.each([
    { $map: [[1, 'def:X']] },
    { $map: [['X', 1]] },
    {
      $map: [
        ['X', 'def:X'],
        ['X', 'def:Y'],
      ],
    },
    { $map: [['X']] },
    { $map: 'invalid' },
    { $map: [['X', 'def:X']], extra: true },
  ])('rejects malformed export map tags on replay: %j', (exports) => {
    const wire = JSON.parse(encodeParsedFileRecord(fixture()));
    wire.parsedFile.exports = exports;
    expect(() => decodeParsedFileRecord(JSON.stringify(wire))).toThrow(ParsedFileRecordError);
  });

  it.each([new Map([[1, 'def:X']]), new Map([['X', 1]])])(
    'rejects malformed export keys or values during capture: %j',
    (exports) => {
      expect(() => encodeParsedFileRecord({ ...fixture(), exports })).toThrow(
        ParsedFileRecordError,
      );
    },
  );

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
  it.each(['ts', 'tsx', 'js', 'jsx'])(
    'replays real %s module captures with detached exports and cross-file finalization parity',
    async (extension) => {
      const libPath = `lib.${extension}`;
      const appPath = `app.${extension}`;
      const sources = [
        { filePath: libPath, content: 'export function Public() {}\nfunction Private() {}' },
        {
          filePath: appPath,
          content: "import { Public as Alias, Private } from './lib';\nAlias();\nmissing();",
        },
      ];
      const files: ParsedFile[] = [];
      for (const { filePath, content } of sources) {
        const provider = getProvider(
          extension === 'js' || extension === 'jsx'
            ? SupportedLanguages.JavaScript
            : SupportedLanguages.TypeScript,
        );
        const parser = await createParserForLanguage(provider.id, filePath);
        const root = parser.parse(content).rootNode;
        expect(root.hasError).toBe(false);
        const outcome = extractParsedFileOutcome(provider, content, filePath, undefined, root);
        expect(outcome.status).toBe('success');
        if (outcome.status !== 'success')
          throw new Error(`scope extraction failed for ${filePath}`);
        const detached = structuredClone(outcome.parsedFile);
        parser.parse('export function replacement() {}');
        expect(outcome.parsedFile).toEqual(detached);
        files.push(outcome.parsedFile);
      }
      const expected = structuredClone(files);
      const [lib, app] = expected;
      const publicDef = lib!.localDefs.find((def) => def.qualifiedName === 'Public')!;
      expect(lib!.exports).toEqual(new Map([['Public', publicDef.nodeId]]));
      expect(lib!.localDefs.map((def) => def.qualifiedName)).toEqual(['Public', 'Private']);
      expect(app!.exports).toEqual(new Map());
      expect(app!.referenceSites.map((site) => site.name)).toEqual(['Alias', 'missing']);

      // Fixture target resolution only; production import resolution is outside this fixture.
      const finalizeFiles = (input: readonly ParsedFile[]) =>
        finalizeScopeModel(input, {
          hooks: { resolveImportTarget: (raw) => (raw === './lib' ? libPath : null) },
        });
      const contents = (model: ReturnType<typeof finalizeScopeModel>) => ({
        scopes: model.scopeTree.byId,
        defs: model.defs.byId,
        qualifiedNames: model.qualifiedNames.byQualifiedName,
        moduleScopes: model.moduleScopes.byFilePath,
        imports: model.imports,
        bindings: model.bindings,
        referenceSites: model.referenceSites,
        sccs: model.sccs,
        stats: model.stats,
      });
      const direct = finalizeFiles(files);
      expect(files).toEqual(expected);
      const expectedContents = structuredClone(contents(direct));
      const stage = new ScopeRetentionStage(options(), { batchRecords: 1, readChunkBytes: 7 });
      try {
        stage.capture(files);
        stage.recordOutcomes(files.map(({ filePath }) => ({ filePath, status: 'success' })));
        stage.reconcile(files.map(({ filePath }) => filePath));
        for (const file of files) {
          const exports = file.exports as Map<string, string>;
          exports.clear();
          exports.set('mutated', 'def:mutated');
          for (const scope of file.scopes) {
            (scope.bindings as Map<string, readonly BindingRef[]>).clear();
            (scope.typeBindings as Map<string, TypeRef>).clear();
          }
        }
        await stage.flush();
        const replayed = await replay(stage);
        expect(replayed).toEqual(expected);
        expect(stage.status).toBe('retained');
        expect(stage.seedReady).toBe(false);
        const actual = finalizeFiles(replayed);
        expect(contents(actual)).toEqual(expectedContents);
        expect(replayed).toEqual(expected);
        const imports = actual.imports.get(app!.moduleScope)!;
        expect(imports).toHaveLength(2);
        expect(imports.find((edge) => edge.localName === 'Alias')).toMatchObject({
          targetFile: libPath,
          targetDefId: publicDef.nodeId,
          targetExportedName: 'Public',
        });
        expect(imports.find((edge) => edge.localName === 'Private')).toMatchObject({
          linkStatus: 'unresolved',
        });
        const bindings = actual.bindings.get(app!.moduleScope)!;
        expect(bindings.get('Alias')).toMatchObject([{ def: publicDef, origin: 'import' }]);
        expect(bindings.has('Private')).toBe(false);
        expect(bindings.has('missing')).toBe(false);
      } finally {
        await stage.dispose();
      }
    },
  );

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
