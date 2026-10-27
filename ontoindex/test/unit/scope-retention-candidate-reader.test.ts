import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedFile } from 'ontoindex-shared';
import type { ImportConfigObservations } from '../../src/core/ingestion/language-config.js';
import { ScopeRetentionStage } from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import {
  persistScopeRetentionCandidate,
  type ScopeRetentionCandidateManifest,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import {
  loadScopeRetentionCandidate,
  verifyScopeRetentionCandidate,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import { summarizeScopeRetentionCoverage } from '../../src/core/ingestion/pipeline-phases/scope-retention-coverage.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';

const identity = {
  sourceManifestDigest: 'a'.repeat(64),
  targetCommit: 'head',
  baseGenerationId: null,
};
const parserCodeIdentity = 'b'.repeat(64);
const expected = { identity, parserCodeIdentity };
const directories: string[] = [];
const stages: ScopeRetentionStage[] = [];

async function setup(capture?: (stage: ScopeRetentionStage) => void) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-candidate-reader-test-'));
  directories.push(directory);
  const request = {
    deadline: Date.now() + 60_000,
    artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
  };
  const stage = new ScopeRetentionStage(request);
  stages.push(stage);
  stage.captureParserCodeIdentity(parserCodeIdentity);
  capture?.(stage);
  const manifest = await persistScopeRetentionCandidate(stage, directory, identity, request);
  return {
    directory,
    request,
    manifest,
    candidate: path.join(directory, 'scope-retention-candidate'),
  };
}

// Keep accounting honest so structural tampering cannot fail only on a stale byte total.
async function mutateManifest(
  candidate: string,
  mutate: (manifest: ScopeRetentionCandidateManifest) => void,
) {
  const file = path.join(candidate, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as ScopeRetentionCandidateManifest;
  mutate(manifest);
  const familyBytes = manifest.families.reduce((sum, family) => sum + family.bytes, 0);
  let encoded: string;
  for (;;) {
    encoded = `${JSON.stringify(manifest)}\n`;
    const total = familyBytes + Buffer.byteLength(encoded);
    if (manifest.totalBytes === total && manifest.artifactBytes === total) break;
    manifest.totalBytes = total;
    manifest.artifactBytes = total;
  }
  await fs.writeFile(file, encoded);
}

async function replaceFamilyRecords(candidate: string, name: string, records: unknown[]) {
  const data = records.map((record) => `${JSON.stringify(record)}\n`).join('');
  await fs.writeFile(path.join(candidate, `${name}.jsonl`), data);
  await mutateManifest(candidate, (manifest) => {
    const family = manifest.families.find((entry) => entry.name === name)!;
    family.bytes = Buffer.byteLength(data);
    family.sha256 = createHash('sha256').update(data).digest('hex');
    family.recordCount = records.length;
    manifest.totalRecordCount = manifest.families.reduce(
      (sum, entry) => sum + entry.recordCount,
      0,
    );
  });
}

const symbolRegistration = {
  kind: 'symbol.add',
  filePath: 'src/example.ts',
  name: 'example',
  nodeId: 'function:example',
  type: 'Function',
};
const emptyImportState = {
  version: 1,
  importMap: [],
  packageMap: [],
  namedImportMap: [],
  moduleAliasMap: [],
};
const auxiliaryCall: Parameters<ScopeRetentionStage['captureCalls']>[0][number] = {
  filePath: 'src/example.ts',
  calledName: 'save',
  sourceId: 'Function:src/example.ts:example',
  atRange: { startLine: 2, startCol: 0, endLine: 4, endCol: 12 },
  argCount: 3,
  callForm: 'member',
  receiverName: 'service',
  receiverTypeName: 'Service',
  receiverMixedChain: [
    {
      kind: 'call',
      name: 'getUser',
      atRange: { startLine: 2, startCol: 0, endLine: 3, endCol: 8 },
    },
    { kind: 'field', name: 'address' },
    {
      kind: 'call',
      name: 'normalize',
      atRange: { startLine: 3, startCol: 9, endLine: 3, endCol: 20 },
    },
  ],
  argTypes: [undefined, 'string', undefined],
};
const auxiliaryHeritage = {
  filePath: 'src/example.ts',
  className: 'Example',
  parentName: 'Base',
  kind: 'provider-defined',
};
const auxiliaryAssignment = {
  filePath: 'src/example.ts',
  sourceId: 'Function:src/example.ts:example',
  receiverText: 'user',
  propertyName: 'address',
  receiverTypeName: 'User',
};
const auxiliaryConstructor = {
  filePath: 'src/example.ts',
  bindings: [
    { scope: 'function:example', varName: 'user', calleeName: 'create', receiverClassName: 'User' },
  ],
};
const auxiliaryExport = { filePath: 'src/example.ts', exportName: 'PublicUser', typeName: 'User' };
const auxiliaryFileBinding = { filePath: 'src/example.ts', varName: 'user', typeName: 'User' };
const ormQuery = {
  filePath: 'src/example.ts',
  orm: 'prisma' as const,
  model: 'user',
  method: 'findMany',
  lineNumber: 0,
};
const parsedFile: ParsedFile = {
  filePath: 'src/example.ts',
  moduleScope: 'module:example',
  parsedImports: [],
  localDefs: [],
  referenceSites: [],
  scopes: [
    {
      id: 'module:example',
      parent: null,
      kind: 'Module',
      filePath: 'src/example.ts',
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
      bindings: new Map(),
      typeBindings: new Map(),
      ownedDefs: [],
      imports: [],
    },
  ],
};

function captureCompleteInputs(stage: ScopeRetentionStage) {
  stage.captureDiscovery(
    [parsedFile.filePath, 'package.json'],
    [
      { path: parsedFile.filePath, size: 0 },
      { path: 'package.json', size: 0 },
    ],
    [],
  );
  const records: ImportConfigObservations['records'] = [
    {
      kind: 'directory',
      path: '.',
      status: 'present',
      entries: [{ name: 'src', kind: 'directory' }],
    },
  ];
  stage.captureConfigObservations({
    version: 1,
    complete: true,
    records,
    issues: [],
    digest: createHash('sha256')
      .update(JSON.stringify({ version: 1, records }))
      .digest('hex'),
  });
  stage.captureParserInputs([{ path: parsedFile.filePath, content: 'export {};' }]);
  stage.capture([parsedFile]);
  stage.recordOutcomes([{ filePath: parsedFile.filePath, status: 'success' }]);
  stage.reconcile([parsedFile.filePath]);
  stage.captureImportState(createResolutionContext());
  for (const family of Object.keys(stage.producerCompletion)) {
    stage.markProducerCompleted(family as keyof typeof stage.producerCompletion);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stage of stages.splice(0)) await stage.dispose();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe('scope retention candidate verification', () => {
  it('retains, persists and hydrates a parsed file above the former 256 KiB bound', async () => {
    const large: ParsedFile = {
      ...parsedFile,
      referenceSites: Array.from({ length: 3100 }, (_, index) => ({
        name: `reference${index}`,
        inScope: parsedFile.moduleScope,
        kind: 'read' as const,
        atRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
      })),
    };
    const { directory, request, manifest } = await setup((stage) => stage.capture([large]));
    expect(manifest.families[0]!.bytes).toBeGreaterThan(350 * 1024);
    expect(manifest.families[0]!.recordCount).toBe(1);
    expect(
      (await loadScopeRetentionCandidate(directory, expected, request)).families.parsedFiles,
    ).toEqual([large]);
  });

  const extractionCases = [
    [
      'fetch-calls',
      'captureFetchCalls',
      { filePath: 'src/example.ts', fetchURL: '/api/é', lineNumber: 0 },
    ],
    [
      'routes',
      'captureRoutes',
      {
        filePath: 'src/example.ts',
        httpMethod: 'POST',
        routePath: null,
        controllerName: 'Example',
        methodName: null,
        middleware: ['auth'],
        prefix: null,
        lineNumber: 1,
      },
    ],
    [
      'decorator-routes',
      'captureDecoratorRoutes',
      {
        filePath: 'src/example.ts',
        routePath: null,
        httpMethod: 'GET',
        decoratorName: 'Get',
        lineNumber: 2,
      },
    ],
    [
      'tool-definitions',
      'captureToolDefinitions',
      { filePath: 'src/example.ts', toolName: 'search', description: 'é😀', lineNumber: 3 },
    ],
  ] as const;
  it('hydrates all sixteen families from the verified read with owned decoded records', async () => {
    const node: Parameters<ScopeRetentionStage['captureGraphNode']>[0] = {
      id: 'file:example',
      label: 'File',
      properties: { name: 'example.ts', filePath: parsedFile.filePath },
    };
    const relationship: Parameters<ScopeRetentionStage['captureGraphRelationship']>[0] = {
      id: 'contains:example',
      sourceId: 'file:example',
      targetId: 'function:example',
      type: 'CONTAINS',
      confidence: 1,
      reason: 'fixture',
    };
    const { directory, request, manifest } = await setup((stage) => {
      stage.captureCalls([auxiliaryCall]);
      stage.captureHeritage([auxiliaryHeritage]);
      stage.captureAssignments([auxiliaryAssignment]);
      stage.captureConstructorBindings([auxiliaryConstructor]);
      stage.captureExportedTypes([auxiliaryExport]);
      stage.captureFileBindings([auxiliaryFileBinding]);
      stage.captureORMQueries([ormQuery]);
      for (const [_family, capture, record] of extractionCases) stage[capture]([record] as never);
      expect(stage.captureModelRegistration(JSON.stringify(symbolRegistration))).toBe(true);
      expect(stage.captureGraphNode(node)).toBe(true);
      expect(stage.captureGraphRelationship(relationship)).toBe(true);
      captureCompleteInputs(stage);
    });
    const open = vi.spyOn(fs, 'open');
    const loaded = await loadScopeRetentionCandidate(directory, expected, request);
    expect(loaded).toEqual({
      manifest,
      families: {
        parsedFiles: [parsedFile],
        calls: [auxiliaryCall],
        heritage: [auxiliaryHeritage],
        assignments: [auxiliaryAssignment],
        constructors: [auxiliaryConstructor],
        exportedTypes: [auxiliaryExport],
        fileBindings: [auxiliaryFileBinding],
        events: [symbolRegistration],
        importStates: [emptyImportState],
        declarationNodes: [node],
        structuralRelationships: [relationship],
        ormQueries: [ormQuery],
        fetchCalls: [extractionCases[0][2]],
        routes: [extractionCases[1][2]],
        decoratorRoutes: [extractionCases[2][2]],
        toolDefinitions: [extractionCases[3][2]],
      },
    });
    for (const family of manifest.families) {
      const familyPath = path.join(directory, 'scope-retention-candidate', family.fileName);
      expect(open.mock.calls.filter(([file]) => String(file) === familyPath)).toHaveLength(1);
    }
    loaded.families.parsedFiles[0]!.filePath = 'changed.ts';
    expect(parsedFile.filePath).toBe('src/example.ts');
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
  });

  it('hydrates records across scratch validation windows', async () => {
    const { directory, candidate, request } = await setup(captureCompleteInputs);
    const records = Array.from({ length: 1100 }, (_, lineNumber) => ({
      ...extractionCases[0][2],
      lineNumber,
    }));
    await replaceFamilyRecords(candidate, 'fetch-calls', records);
    expect(
      (await loadScopeRetentionCandidate(directory, expected, request)).families.fetchCalls,
    ).toEqual(records);
  });

  it.each(['late hash', 'cancelled', 'final manifest'] as const)(
    'never returns provisional families after %s failure',
    async (kind) => {
      const { directory, candidate, request } = await setup((stage) => {
        stage.captureCalls([auxiliaryCall]);
        stage.captureToolDefinitions([extractionCases[3][2]]);
        captureCompleteInputs(stage);
      });
      const controller = new AbortController();
      if (kind === 'late hash') {
        await mutateManifest(candidate, (manifest) => {
          manifest.families.at(-1)!.sha256 = '0'.repeat(64);
        });
      } else {
        const open = fs.open.bind(fs);
        let manifestReads = 0;
        vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          if (String(args[0]).endsWith('manifest.json') && ++manifestReads === 2) {
            if (kind === 'cancelled') controller.abort();
            else await fs.appendFile(path.join(candidate, 'manifest.json'), '\n');
          }
          return open(...args);
        });
      }
      const returned = vi.fn();
      await expect(
        loadScopeRetentionCandidate(directory, expected, {
          ...request,
          signal: controller.signal,
        }).then((result) => {
          returned(result);
          return result;
        }),
      ).rejects.toThrow(
        kind === 'late hash'
          ? 'family integrity mismatch'
          : kind === 'cancelled'
            ? 'cancelled'
            : 'manifest changed',
      );
      expect(returned).not.toHaveBeenCalled();
    },
  );
  it.each(extractionCases)('persists and strictly reopens %s', async (family, capture, record) => {
    const { directory, candidate, request, manifest } = await setup((stage) => {
      stage[capture]([record] as never);
      captureCompleteInputs(stage);
    });
    expect(manifest.version).toBe(5);
    expect(manifest.families).toHaveLength(16);
    expect(manifest.retention.producerCompletion[family]).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(candidate, `${family}.jsonl`), 'utf8'))).toEqual(
      record,
    );
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
    expect(manifest.seedReady).toBe(false);
  });
  it.each(extractionCases)(
    'rejects correctly hashed malformed %s',
    async (family, _capture, record) => {
      const { directory, candidate, request } = await setup(captureCompleteInputs);
      for (const bad of [
        { ...record, lineNumber: -1 },
        { ...record, extra: true },
        { ...record, lineNumber: '0' },
        { ...record, filePath: 42 },
      ]) {
        await replaceFamilyRecords(candidate, family, [bad]);
        await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
          `invalid ${family} record`,
        );
      }
    },
  );
  it.each(extractionCases)(
    'rejects noninventory ownership in %s',
    async (family, _capture, record) => {
      const { directory, candidate, request } = await setup(captureCompleteInputs);
      await replaceFamilyRecords(candidate, family, [{ ...record, filePath: 'src/outside.ts' }]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary record file not retained',
      );
    },
  );
  it.each(extractionCases)('requires even an empty %s family', async (family) => {
    const { directory, candidate, request } = await setup();
    await fs.unlink(path.join(candidate, `${family}.jsonl`));
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
      'missing directory entry',
    );
  });
  it('rejects route field shape changes after hashes are updated', async () => {
    const { directory, candidate, request } = await setup(captureCompleteInputs);
    const route = extractionCases[1][2];
    for (const bad of [
      { ...route, routePath: 42 },
      { ...route, middleware: [42] },
      { ...route, middleware: null },
      { ...route, controllerName: [] },
    ]) {
      await replaceFamilyRecords(candidate, 'routes', [bad]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'invalid routes record',
      );
    }
  });
  it('verifies extraction families across scratch validation windows', async () => {
    const { directory, candidate, request } = await setup(captureCompleteInputs);
    await replaceFamilyRecords(
      candidate,
      'fetch-calls',
      Array.from({ length: 1100 }, (_, lineNumber) => ({
        ...extractionCases[0][2],
        lineNumber,
      })),
    );
    const manifest = await verifyScopeRetentionCandidate(directory, expected, request);
    expect(manifest.families.find((family) => family.name === 'fetch-calls')?.recordCount).toBe(
      1100,
    );
  });
  const malformedCoverage: [string, (manifest: ScopeRetentionCandidateManifest) => void][] = [
    [
      'changed count',
      (manifest) => {
        manifest.coverage.languages[0]!.files++;
      },
    ],
    [
      'dropped language',
      (manifest) => {
        manifest.coverage.languages.pop();
      },
    ],
    [
      'extra key',
      (manifest) => {
        Object.assign(manifest.coverage, { extra: true });
      },
    ],
    [
      'extra language key',
      (manifest) => {
        Object.assign(manifest.coverage.languages[0]!, { extra: true });
      },
    ],
    [
      'missing count',
      (manifest) => {
        Reflect.deleteProperty(manifest.coverage.languages[0]!, 'skipped');
      },
    ],
    [
      'missing unparsed',
      (manifest) => {
        Reflect.deleteProperty(manifest.coverage.languages[0]!, 'unparsed');
      },
    ],
    [
      'negative unparsed',
      (manifest) => {
        manifest.coverage.languages[0]!.unparsed = -1;
      },
    ],
    [
      'non-integer unparsed',
      (manifest) => {
        manifest.coverage.languages[0]!.unparsed = 0.5;
      },
    ],
    [
      'missing coverage',
      (manifest) => {
        Reflect.deleteProperty(manifest, 'coverage');
      },
    ],
    [
      'null coverage',
      (manifest) => {
        Object.assign(manifest, { coverage: null });
      },
    ],
    [
      'flipped completeness',
      (manifest) => {
        manifest.coverage.complete = !manifest.coverage.complete;
      },
    ],
    [
      'wrong version',
      (manifest) => {
        Object.assign(manifest.coverage, { version: 2 });
      },
    ],
  ];
  it.each(malformedCoverage)('rejects coverage tampering: %s', async (_name, mutate) => {
    const { directory, candidate, request, manifest } = await setup((stage) =>
      stage.capture([parsedFile]),
    );
    await mutateManifest(candidate, mutate);
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
      'coverage mismatch',
    );
    expect(manifest.seedReady).toBe(false);
  });

  it('verifies coverage with reordered object keys and an explicit unsupported-syntax reason', async () => {
    const { directory, candidate, request } = await setup();
    await mutateManifest(candidate, (manifest) => {
      manifest.retention.inventory = [
        { filePath: 'refused.py', status: 'failed', reason: 'unsupported-syntax' },
      ];
      const coverage = summarizeScopeRetentionCoverage(manifest.retention.inventory);
      manifest.coverage = {
        complete: coverage.complete,
        languages: coverage.languages,
        version: coverage.version,
      };
    });
    const verified = await verifyScopeRetentionCandidate(directory, expected, request);
    expect(verified.coverage.languages[0]!.refusalReasons).toEqual([
      { reason: 'unsupported-syntax', count: 1 },
    ]);
    expect(verified.seedReady).toBe(false);
  });

  it.each([42, null, 'other-reason'])('rejects invalid inventory reason %s', async (reason) => {
    const { directory, candidate, request } = await setup();
    await mutateManifest(candidate, (manifest) => {
      Object.assign(manifest.retention, {
        inventory: [{ filePath: 'refused.py', status: 'failed', reason }],
      });
    });
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
      'invalid retention metadata',
    );
  });

  it.each(['changed count', 'extra key', 'missing reason'])(
    'rejects refusal reason tampering: %s',
    async (kind) => {
      const { directory, candidate, request } = await setup();
      await mutateManifest(candidate, (manifest) => {
        manifest.retention.inventory = [
          { filePath: 'refused.py', status: 'unsupported', reason: 'unsupported-syntax' },
        ];
        manifest.coverage = summarizeScopeRetentionCoverage(manifest.retention.inventory);
        const reason = manifest.coverage.languages[0]!.refusalReasons[0]!;
        if (kind === 'changed count') reason.count++;
        else if (kind === 'extra key') Object.assign(reason, { extra: true });
        else Reflect.deleteProperty(reason, 'reason');
      });
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'coverage mismatch',
      );
    },
  );

  it('verifies persisted incomplete evidence without charging allowance or claiming seed readiness', async () => {
    const { directory, candidate, request, manifest } = await setup();
    const allowance = request.artifactAllowance.remainingBytes;
    const before = await fs.readFile(path.join(candidate, 'manifest.json'));
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
    expect(manifest.retention.status).toBe('incomplete');
    expect(manifest.seedReady).toBe(false);
    expect(Object.values(manifest.retention.producerCompletion)).toEqual(Array(16).fill(false));
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    expect(await fs.readFile(path.join(candidate, 'manifest.json'))).toEqual(before);
  });

  it('verifies producer-complete persisted input evidence', async () => {
    const { directory, request, manifest } = await setup(captureCompleteInputs);
    expect(manifest.retention.status).toBe('retained');
    expect(manifest.retention.inputEvidence.complete).toBe(true);
    expect(manifest.retention.inputEvidence.reasons).toEqual([]);
    expect(Object.values(manifest.retention.producerCompletion)).toEqual(Array(16).fill(true));
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
  });

  it.each([
    'unsafe',
    'duplicate',
    'invalid-language',
    'missing-path',
    'unrecorded-source',
    'skipped-source',
  ] as const)('rejects malformed or incomplete discovery: %s', async (mode) => {
    const { directory, candidate, request } = await setup(captureCompleteInputs);
    await mutateManifest(candidate, (manifest) => {
      const discovery = structuredClone(manifest.retention.discovery!);
      if (mode === 'unsafe')
        Object.assign(discovery, { allPaths: ['../outside.json', ...discovery.allPaths] });
      if (mode === 'duplicate')
        Object.assign(discovery, { allPaths: [...discovery.allPaths, 'package.json'] });
      if (mode === 'invalid-language')
        Object.assign(discovery, {
          scanned: [{ path: 'package.json', language: 'invalid' }, ...discovery.scanned.slice(1)],
        });
      if (mode === 'missing-path') Object.assign(discovery, { allPaths: ['package.json'] });
      if (mode === 'unrecorded-source')
        Object.assign(discovery, {
          allPaths: ['extra.py', ...discovery.allPaths],
          scanned: [{ path: 'extra.py', language: 'python' }, ...discovery.scanned],
        });
      if (mode === 'skipped-source')
        Object.assign(discovery, {
          skipped: [{ path: 'large.ts', size: 100_000_000 }],
        });
      Object.assign(manifest.retention, { discovery });
    });
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
      /discovery/,
    );
  });

  it.each(['missing fields', 'stale digest', 'invalid record kind'] as const)(
    'rejects malformed configuration evidence with %s through both reader APIs',
    async (kind) => {
      const { directory, candidate, request } = await setup(captureCompleteInputs);
      await mutateManifest(candidate, (manifest) => {
        const configuration = manifest.retention.inputEvidence.configuration!;
        if (kind === 'missing fields') {
          Object.assign(manifest.retention.inputEvidence, { configuration: { complete: true } });
        } else if (kind === 'stale digest') {
          Object.assign(configuration.records[0]!, { path: 'private-config-path' });
        } else {
          Object.assign(configuration, { records: [{ kind: 'private-invalid-kind', path: '.' }] });
          Object.assign(configuration, {
            digest: createHash('sha256')
              .update(JSON.stringify({ version: 1, records: configuration.records }))
              .digest('hex'),
          });
        }
      });
      const allowance = request.artifactAllowance.remainingBytes;
      const dispose = vi.spyOn(ScopeRetentionStage.prototype, 'dispose');
      for (const read of [verifyScopeRetentionCandidate, loadScopeRetentionCandidate]) {
        await expect(read(directory, expected, request)).rejects.toThrow(
          /^scope-retention-candidate: invalid configuration evidence$/,
        );
      }
      expect(dispose).toHaveBeenCalledTimes(2);
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    },
  );

  it('accepts valid incomplete configuration evidence without charging the caller allowance', async () => {
    const configuration: ImportConfigObservations = {
      version: 1,
      complete: false,
      digest: null,
      records: [{ kind: 'parse-error', path: 'tsconfig.json' }],
      issues: ['parse-error'],
    };
    const { directory, request, manifest } = await setup((stage) => {
      stage.captureConfigObservations(configuration);
    });
    const allowance = request.artifactAllowance.remainingBytes;
    const dispose = vi.spyOn(ScopeRetentionStage.prototype, 'dispose');
    expect(manifest.retention.inputEvidence.configuration).toEqual(configuration);
    expect(manifest.retention.inputEvidence.complete).toBe(false);
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
    expect((await loadScopeRetentionCandidate(directory, expected, request)).manifest).toEqual(
      manifest,
    );
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('preserves cancellation during configuration validation and disposes the temporary owner', async () => {
    const { directory, request } = await setup(captureCompleteInputs);
    const controller = new AbortController();
    const capture = ScopeRetentionStage.prototype.captureConfigObservations;
    vi.spyOn(ScopeRetentionStage.prototype, 'captureConfigObservations').mockImplementation(
      function (observations) {
        capture.call(this, observations);
        controller.abort();
      },
    );
    const dispose = vi.spyOn(ScopeRetentionStage.prototype, 'dispose');
    await expect(
      loadScopeRetentionCandidate(directory, expected, { ...request, signal: controller.signal }),
    ).rejects.toThrow(/^scope-retention-candidate: cancelled$/);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  const inconsistentInputCompleteness: [
    string,
    (manifest: ScopeRetentionCandidateManifest) => void,
  ][] = [
    [
      'complete with input reasons',
      (manifest) => {
        Object.assign(manifest.retention.inputEvidence, { reasons: ['missing-source'] });
      },
    ],
    [
      'incomplete without input reasons',
      (manifest) => {
        Object.assign(manifest.retention.inputEvidence, { complete: false });
      },
    ],
    [
      'complete with incomplete retention',
      (manifest) => {
        manifest.retention.status = 'incomplete';
      },
    ],
    [
      'complete with retention reasons',
      (manifest) => {
        Object.assign(manifest.retention, { reasons: ['artifact-incomplete'] });
      },
    ],
    [
      'complete without configuration',
      (manifest) => {
        Object.assign(manifest.retention.inputEvidence, { configuration: null });
      },
    ],
    [
      'complete with incomplete configuration',
      (manifest) => {
        manifest.retention.inputEvidence.configuration!.complete = false;
      },
    ],
    [
      'complete with a missing source',
      (manifest) => {
        Object.assign(manifest.retention.inputEvidence, { sources: [] });
      },
    ],
    [
      'complete with an extra source',
      (manifest) => {
        const evidence = manifest.retention.inputEvidence;
        Object.assign(evidence, {
          sources: [...evidence.sources, { ...evidence.sources[0]!, filePath: 'src/extra.ts' }],
        });
      },
    ],
    [
      'complete with an equal-size wrong source set',
      (manifest) => {
        const evidence = manifest.retention.inputEvidence;
        Object.assign(evidence, {
          sources: [{ ...evidence.sources[0]!, filePath: 'src/other.ts' }],
        });
      },
    ],
  ];
  it.each(inconsistentInputCompleteness)(
    'rejects inconsistent input completeness: %s',
    async (_name, mutate) => {
      const { directory, candidate, request } = await setup(captureCompleteInputs);
      await mutateManifest(candidate, mutate);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'inconsistent input evidence completeness',
      );
    },
  );

  it('verifies explicit completion for empty producers and one empty import snapshot', async () => {
    const { directory, request, manifest } = await setup((stage) => {
      stage.captureImportState(createResolutionContext());
      for (const family of Object.keys(stage.producerCompletion)) {
        stage.markProducerCompleted(family as keyof typeof stage.producerCompletion);
      }
    });
    const verified = await verifyScopeRetentionCandidate(directory, expected, request);
    expect(verified).toEqual(manifest);
    expect(Object.values(verified.retention.producerCompletion)).toEqual(Array(16).fill(true));
    expect(
      verified.families.filter((family) => family.recordCount > 0).map((family) => family.name),
    ).toEqual(['import-states']);
    expect(verified.seedReady).toBe(false);
  });

  it.each(['inventory', 'source evidence'] as const)(
    'rejects duplicate file paths in %s',
    async (kind) => {
      const { directory, candidate, request } = await setup((stage) => {
        stage.capture([parsedFile]);
        stage.captureParserInputs([{ path: parsedFile.filePath, content: 'export {};' }]);
      });
      await mutateManifest(candidate, (manifest) => {
        if (kind === 'inventory') {
          manifest.retention.inventory = [
            ...manifest.retention.inventory,
            manifest.retention.inventory[0]!,
          ];
        } else {
          const evidence = manifest.retention.inputEvidence;
          Object.assign(evidence, { sources: [...evidence.sources, evidence.sources[0]!] });
        }
      });
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
    },
  );

  it.each(['duplicate path', 'path outside inventory'] as const)(
    'rejects correctly hashed parsed files: %s',
    async (kind) => {
      const { directory, candidate, request } = await setup((stage) => stage.capture([parsedFile]));
      const record = JSON.parse(
        await fs.readFile(path.join(candidate, 'parsed-files.jsonl'), 'utf8'),
      );
      await replaceFamilyRecords(
        candidate,
        'parsed-files',
        kind === 'duplicate path'
          ? [record, record]
          : [
              {
                ...record,
                parsedFile: { ...record.parsedFile, filePath: 'src/other.ts' },
              },
            ],
      );
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
    },
  );

  it.each([
    'empty scopes',
    'missing root',
    'wrong module id',
    'module id names child',
    'non-module root',
    'duplicate scope id',
    'missing parent',
    'foreign root owner',
    'foreign child owner',
    'multiple roots',
    'overlapping siblings',
    'child outside parent',
  ] as const)('rejects correctly hashed scope tree: %s', async (kind) => {
    const { directory, candidate, request } = await setup((stage) => stage.capture([parsedFile]));
    const record = JSON.parse(
      await fs.readFile(path.join(candidate, 'parsed-files.jsonl'), 'utf8'),
    );
    const file = record.parsedFile;
    const root = file.scopes[0];
    root.range.endLine = 20;
    const child = {
      ...root,
      id: 'function:example',
      parent: root.id,
      kind: 'Function',
      range: { startLine: 2, startCol: 0, endLine: 8, endCol: 0 },
    };
    file.scopes.push(child);
    if (kind === 'empty scopes') file.scopes = [];
    else if (kind === 'missing root') file.scopes.shift();
    else if (kind === 'wrong module id') file.moduleScope = 'module:missing';
    else if (kind === 'module id names child') file.moduleScope = child.id;
    else if (kind === 'non-module root') root.kind = 'Function';
    else if (kind === 'duplicate scope id') file.scopes.push({ ...child });
    else if (kind === 'missing parent') child.parent = 'scope:missing';
    else if (kind === 'foreign root owner') {
      for (const scope of file.scopes) scope.filePath = 'src/foreign.ts';
    } else if (kind === 'foreign child owner') child.filePath = 'src/foreign.ts';
    else if (kind === 'multiple roots') file.scopes.push({ ...root, id: 'module:other' });
    else if (kind === 'overlapping siblings')
      file.scopes.push({
        ...child,
        id: 'function:other',
        range: { startLine: 7, startCol: 0, endLine: 10, endCol: 0 },
      });
    else child.range.endLine = 21;
    await replaceFamilyRecords(candidate, 'parsed-files', [record]);
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
  });

  it('verifies correctly hashed nested scope records', async () => {
    const { directory, candidate, request, manifest } = await setup((stage) =>
      stage.capture([parsedFile]),
    );
    const record = JSON.parse(
      await fs.readFile(path.join(candidate, 'parsed-files.jsonl'), 'utf8'),
    );
    const root = record.parsedFile.scopes[0];
    root.range.endLine = 20;
    record.parsedFile.scopes.push(
      {
        ...root,
        id: 'function:example',
        parent: root.id,
        kind: 'Function',
        range: { startLine: 2, startCol: 0, endLine: 8, endCol: 0 },
      },
      {
        ...root,
        id: 'block:example',
        parent: 'function:example',
        kind: 'Block',
        range: { startLine: 3, startCol: 0, endLine: 5, endCol: 0 },
      },
      {
        ...root,
        id: 'function:other',
        parent: root.id,
        kind: 'Function',
        range: { startLine: 10, startCol: 0, endLine: 15, endCol: 0 },
      },
    );
    await replaceFamilyRecords(candidate, 'parsed-files', [record]);
    const verified = await verifyScopeRetentionCandidate(directory, expected, request);
    expect(verified.retention).toEqual(manifest.retention);
    expect(verified.seedReady).toBe(false);
  });

  const crossFileScopeFiles = ['first', 'second'].map((name): ParsedFile => {
    const filePath = `src/${name}.ts`;
    const root = {
      ...parsedFile.scopes[0]!,
      id: `root:${name}`,
      filePath,
      range: { startLine: 1, startCol: 0, endLine: 20, endCol: 0 },
    };
    return {
      ...parsedFile,
      filePath,
      moduleScope: root.id,
      scopes: [
        root,
        {
          ...root,
          id: `child:${name}`,
          parent: root.id,
          kind: 'Function',
          range: { startLine: 2, startCol: 0, endLine: 8, endCol: 0 },
        },
      ],
    };
  });

  it('verifies distinct cross-file scope ids with equal ranges without claiming seed readiness', async () => {
    const { directory, request, manifest } = await setup((stage) =>
      stage.capture(crossFileScopeFiles),
    );
    expect(manifest.retention.inventory.map((entry) => entry.filePath)).toEqual(
      crossFileScopeFiles.map((file) => file.filePath),
    );
    expect(manifest.families.find((family) => family.name === 'parsed-files')?.recordCount).toBe(2);
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
    expect(manifest.seedReady).toBe(false);
  });

  it.each(['root/root', 'child/child', 'root/child'] as const)(
    'rejects correctly hashed cross-file scope id reuse: %s',
    async (collision) => {
      const { directory, candidate, request, manifest } = await setup((stage) =>
        stage.capture(crossFileScopeFiles),
      );
      expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
      const records = (await fs.readFile(path.join(candidate, 'parsed-files.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const first = records[0].parsedFile;
      const second = records[1].parsedFile;
      if (collision === 'root/root') {
        second.moduleScope = first.moduleScope;
        second.scopes[0].id = first.moduleScope;
        second.scopes[1].parent = first.moduleScope;
      } else {
        second.scopes[1].id = first.scopes[collision === 'child/child' ? 1 : 0].id;
      }
      await replaceFamilyRecords(candidate, 'parsed-files', records);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'duplicate parsed file scope id',
      );
    },
  );

  it.each(['graph-nodes', 'graph-relationships'] as const)(
    'rejects correctly hashed duplicate ids in %s',
    async (family) => {
      const { directory, candidate, request } = await setup((stage) => {
        expect(
          stage.captureGraphNode({
            id: 'file:example',
            label: 'File',
            properties: { name: 'example.ts', filePath: parsedFile.filePath },
          }),
        ).toBe(true);
        expect(
          stage.captureGraphRelationship({
            id: 'contains:example',
            sourceId: 'file:example',
            targetId: 'function:example',
            type: 'CONTAINS',
            confidence: 1,
            reason: 'fixture',
          }),
        ).toBe(true);
      });
      const record = JSON.parse(await fs.readFile(path.join(candidate, `${family}.jsonl`), 'utf8'));
      await replaceFamilyRecords(candidate, family, [record, record]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
    },
  );

  it.each([
    ['retained', true],
    ['retained', false],
    ['incomplete', true],
  ] as const)(
    'rejects missing parsed records with %s retention and producer completion %s',
    async (status, complete) => {
      const { directory, candidate, request, manifest } = await setup((stage) => {
        stage.capture([parsedFile]);
        stage.recordOutcomes([{ filePath: parsedFile.filePath, status: 'success' }]);
        if (status === 'retained') stage.reconcile([parsedFile.filePath]);
        if (complete) stage.markProducerCompleted('parsed-files');
      });
      expect(manifest.retention.status).toBe(status);
      expect(manifest.retention.producerCompletion['parsed-files']).toBe(complete);
      await replaceFamilyRecords(candidate, 'parsed-files', []);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
    },
  );

  it.each([
    ['completed B-only records', true, false],
    ['completed A+B records', true, true],
    ['partial B-only records', false, false],
  ] as const)(
    'checks retained parsed-file membership for %s',
    async (_name, complete, includeRetained) => {
      const otherFile: ParsedFile = {
        ...parsedFile,
        filePath: 'src/other.ts',
        moduleScope: 'module:other',
        scopes: parsedFile.scopes.map((scope) => ({
          ...scope,
          id: 'module:other',
          filePath: 'src/other.ts',
        })),
      };
      const { directory, candidate, request, manifest } = await setup((stage) => {
        stage.capture([parsedFile, otherFile]);
        stage.recordOutcomes([{ filePath: parsedFile.filePath, status: 'success' }]);
        if (complete) stage.markProducerCompleted('parsed-files');
      });
      expect(manifest.retention.status).toBe('incomplete');
      expect(manifest.retention.producerCompletion['parsed-files']).toBe(complete);
      expect(manifest.retention.inventory).toEqual([
        { filePath: parsedFile.filePath, status: 'retained' },
        { filePath: otherFile.filePath, status: 'missing-outcome' },
      ]);
      expect(manifest.seedReady).toBe(false);
      const records = (await fs.readFile(path.join(candidate, 'parsed-files.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const selected = includeRetained
        ? records
        : records.filter((record) => record.parsedFile.filePath === otherFile.filePath);
      expect(selected).toHaveLength(includeRetained ? 2 : 1);
      await replaceFamilyRecords(candidate, 'parsed-files', selected);
      if (complete && !includeRetained) {
        await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
          'completed parsed files inventory mismatch',
        );
      } else {
        const verified = await verifyScopeRetentionCandidate(directory, expected, request);
        expect(verified.retention.status).toBe('incomplete');
        expect(verified.retention.producerCompletion['parsed-files']).toBe(complete);
        expect(verified.seedReady).toBe(false);
      }
    },
  );

  it('rejects completed parsed records exceeding the inventory count', async () => {
    const { directory, candidate, request } = await setup((stage) => {
      stage.capture([parsedFile]);
      stage.markProducerCompleted('parsed-files');
    });
    await mutateManifest(candidate, (manifest) => {
      manifest.retention.inventory = [];
    });
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
  });

  it('rejects retained metadata with a non-retained inventory entry', async () => {
    const { directory, candidate, request } = await setup((stage) => {
      stage.capture([parsedFile]);
      stage.recordOutcomes([{ filePath: parsedFile.filePath, status: 'success' }]);
      stage.reconcile([parsedFile.filePath]);
    });
    await mutateManifest(candidate, (manifest) => {
      manifest.retention.inventory = [{ filePath: parsedFile.filePath, status: 'skipped' }];
    });
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
  });

  it('verifies graph relationships whose endpoints are absent from captured nodes', async () => {
    const { directory, request, manifest } = await setup((stage) => {
      expect(
        stage.captureGraphRelationship({
          id: 'contains:external',
          sourceId: 'folder:uncaptured',
          targetId: 'file:external',
          type: 'CONTAINS',
          confidence: 1,
          reason: 'fixture',
        }),
      ).toBe(true);
    });
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
  });

  it.each([
    ['incomplete', 'CALLS', 'fixture'],
    ['incomplete', 'ACCESSES', 'write'],
    ['retained', 'CALLS', 'fixture'],
    ['retained', 'ACCESSES', 'write'],
  ] as const)(
    'rejects correctly hashed resolver-owned %s %s relationships',
    async (status, type, reason) => {
      const { directory, candidate, request, manifest } = await setup((stage) => {
        expect(
          stage.captureGraphRelationship({
            id: 'edge:example',
            sourceId: 'function:example',
            targetId: 'function:target',
            type: 'CONTAINS',
            confidence: 1,
            reason: 'fixture',
          }),
        ).toBe(true);
        if (status === 'retained') captureCompleteInputs(stage);
      });
      expect(manifest.retention.status).toBe(status);
      const record = JSON.parse(
        await fs.readFile(path.join(candidate, 'graph-relationships.jsonl'), 'utf8'),
      );
      await replaceFamilyRecords(candidate, 'graph-relationships', [
        {
          ...record,
          graphRelationship: { ...record.graphRelationship, type, reason },
        },
      ]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'resolver-owned graph relationship',
      );
    },
  );

  it.each(['incomplete', 'retained'] as const)(
    'verifies %s read-access relationships',
    async (status) => {
      const { directory, request, manifest } = await setup((stage) => {
        expect(
          stage.captureGraphRelationship({
            id: 'accesses:read',
            sourceId: 'function:uncaptured',
            targetId: 'property:uncaptured',
            type: 'ACCESSES',
            confidence: 1,
            reason: 'read',
          }),
        ).toBe(true);
        if (status === 'retained') captureCompleteInputs(stage);
      });
      expect(manifest.retention.status).toBe(status);
      expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
    },
  );

  it('verifies auxiliary file paths outside the parsed-file inventory', async () => {
    const { directory, request, manifest } = await setup((stage) => {
      stage.capture([parsedFile]);
      stage.captureCalls([
        {
          ...auxiliaryCall,
          filePath: 'src/auxiliary-only.ts',
          sourceId: 'File:src/auxiliary-only.ts',
        },
      ]);
    });
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
  });

  const malformedCompletion: [string, (manifest: ScopeRetentionCandidateManifest) => void][] = [
    [
      'missing metadata',
      (manifest) => {
        Reflect.deleteProperty(manifest.retention, 'producerCompletion');
      },
    ],
    [
      'null metadata',
      (manifest) => {
        Object.assign(manifest.retention, { producerCompletion: null });
      },
    ],
    [
      'array metadata',
      (manifest) => {
        Object.assign(manifest.retention, { producerCompletion: [] });
      },
    ],
    [
      'missing family',
      (manifest) => {
        Reflect.deleteProperty(manifest.retention.producerCompletion, 'calls');
      },
    ],
    [
      'missing ORM family',
      (manifest) => {
        Reflect.deleteProperty(manifest.retention.producerCompletion, 'orm-queries');
      },
    ],
    [
      'extra family',
      (manifest) => {
        Object.assign(manifest.retention.producerCompletion, { extra: false });
      },
    ],
    [
      'replaced family',
      (manifest) => {
        Reflect.deleteProperty(manifest.retention.producerCompletion, 'calls');
        Object.assign(manifest.retention.producerCompletion, { extra: false });
      },
    ],
    [
      'non-boolean value',
      (manifest) => {
        Object.assign(manifest.retention.producerCompletion, { calls: 0 });
      },
    ],
    [
      'node marker disagreement',
      (manifest) => {
        manifest.retention.graphNodesCaptured = true;
      },
    ],
    [
      'relationship marker disagreement',
      (manifest) => {
        manifest.retention.graphRelationshipsCaptured = true;
      },
    ],
    [
      'node completion disagreement',
      (manifest) => {
        Object.assign(manifest.retention.producerCompletion, { 'graph-nodes': true });
      },
    ],
    [
      'relationship completion disagreement',
      (manifest) => {
        Object.assign(manifest.retention.producerCompletion, { 'graph-relationships': true });
      },
    ],
    [
      'completed import without snapshot',
      (manifest) => {
        Object.assign(manifest.retention.producerCompletion, { 'import-states': true });
      },
    ],
    [
      'completion with retention issues',
      (manifest) => {
        Object.assign(manifest.retention.producerCompletion, { calls: true });
        manifest.retention.reasons = ['call-invalid'];
      },
    ],
  ];
  it.each(malformedCompletion)(
    'rejects malformed producer completion: %s',
    async (_name, mutate) => {
      const { directory, candidate, request } = await setup();
      await mutateManifest(candidate, mutate);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
    },
  );

  it.each([1, 2, 3, 4])('rejects legacy version %s candidates explicitly', async (version) => {
    const { directory, candidate, request } = await setup();
    await mutateManifest(candidate, (manifest) => {
      Object.assign(manifest, { version });
      Reflect.deleteProperty(manifest.retention, 'producerCompletion');
    });
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
      'unsupported legacy manifest version',
    );
  });

  it.each([1, 2])('rejects an actual eleven-family legacy version %s layout', async (version) => {
    const { directory, candidate, request } = await setup();
    await fs.unlink(path.join(candidate, 'orm-queries.jsonl'));
    await mutateManifest(candidate, (manifest) => {
      Object.assign(manifest, { version });
      manifest.families = manifest.families.filter((family) => family.name !== 'orm-queries');
      Reflect.deleteProperty(manifest.retention.producerCompletion, 'orm-queries');
    });
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
      'missing directory entry',
    );
  });

  it('requires the ORM family even when it is empty', async () => {
    const { directory, candidate, request } = await setup();
    await fs.unlink(path.join(candidate, 'orm-queries.jsonl'));
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
      'missing directory entry',
    );
  });

  it('verifies retained Prisma and Supabase queries after reopening candidate files', async () => {
    const queries = [
      ormQuery,
      { ...ormQuery, orm: 'supabase' as const, model: 'posts', method: 'select', lineNumber: 12 },
    ];
    const { directory, candidate, request, manifest } = await setup((stage) => {
      stage.captureORMQueries(queries);
      captureCompleteInputs(stage);
    });
    expect(manifest.version).toBe(5);
    expect(manifest.retention.producerCompletion['orm-queries']).toBe(true);
    expect(manifest.families.find((family) => family.name === 'orm-queries')).toMatchObject({
      name: 'orm-queries',
      recordCount: queries.length,
    });
    expect(
      (await fs.readFile(path.join(candidate, 'orm-queries.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual(queries);
    const allowance = request.artifactAllowance.remainingBytes;
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    expect(manifest.seedReady).toBe(false);
  });

  it('rejects correctly hashed ORM queries outside the retained file set', async () => {
    const { directory, candidate, request } = await setup(captureCompleteInputs);
    await replaceFamilyRecords(candidate, 'orm-queries', [
      { ...ormQuery, filePath: 'src/outside.ts' },
    ]);
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
      'auxiliary record file not retained',
    );
  });

  const malformedORMQueries: [string, Record<string, unknown>][] = [
    ...['filePath', 'orm', 'model', 'method', 'lineNumber'].flatMap((field) => {
      const missing: Record<string, unknown> = { ...ormQuery };
      delete missing[field];
      return [
        [`missing ${field}`, missing],
        [`wrong ${field} type`, { ...ormQuery, [field]: field === 'lineNumber' ? '1' : 42 }],
      ] as [string, Record<string, unknown>][];
    }),
    ['extra field', { ...ormQuery, extra: true }],
    ['unknown ORM', { ...ormQuery, orm: 'unknown' }],
    ['negative line', { ...ormQuery, lineNumber: -1 }],
    ['fractional line', { ...ormQuery, lineNumber: 0.5 }],
    ['unsafe line', { ...ormQuery, lineNumber: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  it.each(malformedORMQueries)(
    'rejects correctly hashed ORM queries: %s',
    async (_name, record) => {
      const { directory, candidate, request } = await setup();
      await replaceFamilyRecords(candidate, 'orm-queries', [record]);
      const allowance = request.artifactAllowance.remainingBytes;
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'invalid orm-queries record',
      );
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    },
  );

  it('verifies ORM queries across scratch record limits', async () => {
    const { directory, candidate, request } = await setup();
    await replaceFamilyRecords(
      candidate,
      'orm-queries',
      Array.from({ length: 1100 }, (_, lineNumber) => ({
        ...ormQuery,
        lineNumber,
      })),
    );
    const verified = await verifyScopeRetentionCandidate(directory, expected, request);
    expect(verified.families.find((family) => family.name === 'orm-queries')).toMatchObject({
      name: 'orm-queries',
      recordCount: 1100,
    });
    expect(verified.seedReady).toBe(false);
  });

  it('verifies every registration kind and populated import state without promoting incomplete evidence', async () => {
    const def = { nodeId: 'class:Example', filePath: 'src/example.ts', type: 'Class' };
    const registrations = [
      {
        ...symbolRegistration,
        metadata: { parameterCount: 1, parameterTypes: ['string'], ownerId: 'class:Example' },
      },
      { kind: 'type.registerClass', name: 'Example', qualifiedName: 'example.Example', def },
      { kind: 'type.registerImpl', name: 'Example', def },
      { kind: 'method.register', ownerNodeId: 'class:Example', name: 'run', def },
      { kind: 'field.register', ownerNodeId: 'class:Example', name: 'value', def },
      ...['type.clear', 'method.clear', 'field.clear', 'model.clear'].map((kind) => ({ kind })),
    ];
    const { directory, request, manifest } = await setup((stage) => {
      for (const registration of registrations) {
        expect(stage.captureModelRegistration(JSON.stringify(registration))).toBe(true);
      }
      const ctx = createResolutionContext();
      ctx.importMap.set('src/example.ts', new Set(['src/dependency.ts']));
      ctx.packageMap.set('src/example.ts', new Set(['src/package.ts']));
      ctx.namedImportMap.set(
        'src/example.ts',
        new Map([['local', { sourcePath: 'src/dependency.ts', exportedName: 'original' }]]),
      );
      ctx.moduleAliasMap.set('src/example.ts', new Map([['dependency', 'src/dependency.ts']]));
      stage.captureImportState(ctx);
    });
    const allowance = request.artifactAllowance.remainingBytes;
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
    expect(
      manifest.families.find((family) => family.name === 'model-registrations')?.recordCount,
    ).toBe(9);
    expect(manifest.families.find((family) => family.name === 'import-states')?.recordCount).toBe(
      1,
    );
    expect(manifest.seedReady).toBe(false);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('verifies all six captured auxiliary families with optional fields and persisted undefined argument slots', async () => {
    const { directory, candidate, request, manifest } = await setup((stage) => {
      stage.captureCalls([auxiliaryCall]);
      stage.captureHeritage([auxiliaryHeritage]);
      stage.captureAssignments([auxiliaryAssignment]);
      stage.captureConstructorBindings([auxiliaryConstructor]);
      stage.captureExportedTypes([auxiliaryExport]);
      stage.captureFileBindings([auxiliaryFileBinding]);
    });
    const allowance = request.artifactAllowance.remainingBytes;
    const before = await fs.readFile(path.join(candidate, 'manifest.json'));
    expect(JSON.parse(await fs.readFile(path.join(candidate, 'calls.jsonl'), 'utf8'))).toEqual({
      ...auxiliaryCall,
      argTypes: [null, 'string', null],
    });
    expect(
      manifest.families
        .filter((family) => family.recordCount > 0)
        .map((family) => [family.name, family.recordCount]),
    ).toEqual([
      ['calls', 1],
      ['heritage', 1],
      ['assignments', 1],
      ['constructor-bindings', 1],
      ['exported-types', 1],
      ['file-bindings', 1],
    ]);
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
    expect(manifest.seedReady).toBe(false);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    expect(await fs.readFile(path.join(candidate, 'manifest.json'))).toEqual(before);
  });

  it('verifies persisted calls from before optional call ranges were retained', async () => {
    const { atRange: _range, ...legacyCall } = auxiliaryCall;
    legacyCall.receiverMixedChain = auxiliaryCall.receiverMixedChain!.map(({ kind, name }) => ({
      kind,
      name,
    }));
    const { directory, candidate, request, manifest } = await setup((stage) => {
      stage.captureCalls([legacyCall]);
    });
    expect(JSON.parse(await fs.readFile(path.join(candidate, 'calls.jsonl'), 'utf8'))).toEqual({
      ...legacyCall,
      argTypes: [null, 'string', null],
    });
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
  });

  const auxiliaryFamilies: [string, Record<string, unknown>, string][] = [
    ['calls', auxiliaryCall, 'calledName'],
    ['heritage', auxiliaryHeritage, 'parentName'],
    ['assignments', auxiliaryAssignment, 'propertyName'],
    ['constructor-bindings', auxiliaryConstructor, 'filePath'],
    ['exported-types', auxiliaryExport, 'exportName'],
    ['file-bindings', auxiliaryFileBinding, 'varName'],
  ];
  const malformedAuxiliary: [string, string, unknown][] = auxiliaryFamilies.flatMap(
    ([family, valid, required]) => {
      const missing = { ...valid };
      delete missing[required];
      return [
        [`${family} missing required field`, family, missing],
        [`${family} wrong required type`, family, { ...valid, [required]: 42 }],
        [`${family} extra field`, family, { ...valid, extra: 'unexpected' }],
      ];
    },
  );
  malformedAuxiliary.push(
    [
      'empty whole-call range',
      'calls',
      {
        ...auxiliaryCall,
        atRange: { startLine: 2, startCol: 1, endLine: 2, endCol: 1 },
      },
    ],
    [
      'extra whole-call coordinate',
      'calls',
      { ...auxiliaryCall, atRange: { ...auxiliaryCall.atRange, extra: true } },
    ],
    [
      'unsafe whole-call coordinate',
      'calls',
      {
        ...auxiliaryCall,
        atRange: { ...auxiliaryCall.atRange, endLine: Number.MAX_SAFE_INTEGER + 1 },
      },
    ],
    [
      'missing whole-call coordinate',
      'calls',
      {
        ...auxiliaryCall,
        atRange: { startLine: 2, startCol: 0, endLine: 4 },
      },
    ],
    [
      'invalid receiver-call range',
      'calls',
      {
        ...auxiliaryCall,
        receiverMixedChain: [
          {
            kind: 'call',
            name: 'getUser',
            atRange: { startLine: 3, startCol: 2, endLine: 2, endCol: 8 },
          },
        ],
      },
    ],
    [
      'field-step call range',
      'calls',
      {
        ...auxiliaryCall,
        receiverMixedChain: [{ kind: 'field', name: 'profile', atRange: auxiliaryCall.atRange }],
      },
    ],
    ['negative argument count', 'calls', { ...auxiliaryCall, argCount: -1 }],
    ['invalid call form', 'calls', { ...auxiliaryCall, callForm: 'unknown' }],
    [
      'receiver chain longer than three steps',
      'calls',
      {
        ...auxiliaryCall,
        receiverMixedChain: Array.from({ length: 4 }, () => ({ kind: 'field', name: 'value' })),
      },
    ],
    [
      'invalid receiver chain kind',
      'calls',
      { ...auxiliaryCall, receiverMixedChain: [{ kind: 'unknown', name: 'value' }] },
    ],
    ['non-string argument type', 'calls', { ...auxiliaryCall, argTypes: ['string', 42] }],
    [
      'invalid assignment receiver type',
      'assignments',
      { ...auxiliaryAssignment, receiverTypeName: 42 },
    ],
    [
      'empty persisted constructor bindings',
      'constructor-bindings',
      { ...auxiliaryConstructor, bindings: [] },
    ],
    [
      'multiple persisted constructor bindings',
      'constructor-bindings',
      {
        ...auxiliaryConstructor,
        bindings: [...auxiliaryConstructor.bindings, ...auxiliaryConstructor.bindings],
      },
    ],
    [
      'missing constructor scope',
      'constructor-bindings',
      {
        ...auxiliaryConstructor,
        bindings: [{ varName: 'user', calleeName: 'create' }],
      },
    ],
    [
      'invalid constructor receiver class',
      'constructor-bindings',
      {
        ...auxiliaryConstructor,
        bindings: [{ ...auxiliaryConstructor.bindings[0]!, receiverClassName: 42 }],
      },
    ],
    [
      'extra constructor binding field',
      'constructor-bindings',
      {
        ...auxiliaryConstructor,
        bindings: [{ ...auxiliaryConstructor.bindings[0]!, extra: true }],
      },
    ],
    ['invalid exported type', 'exported-types', { ...auxiliaryExport, typeName: 42 }],
    ['invalid file binding type', 'file-bindings', { ...auxiliaryFileBinding, typeName: 42 }],
  );
  it.each(malformedAuxiliary)(
    'rejects correctly hashed auxiliary records: %s',
    async (_name, family, record) => {
      const { directory, candidate, request } = await setup();
      await replaceFamilyRecords(candidate, family, [record]);
      const allowance = request.artifactAllowance.remainingBytes;
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
    },
  );

  it.each([
    ['record count', 1100, 'save'],
    ['encoded bytes', 20, 'x'.repeat(40 * 1024)],
  ] as const)(
    'verifies auxiliary records across scratch batch limits by %s',
    async (_name, count, calledName) => {
      const { directory, candidate, request } = await setup();
      await replaceFamilyRecords(
        candidate,
        'calls',
        Array.from({ length: count }, (_, index) => ({
          filePath: 'src/example.ts',
          sourceId: `Function:src/example.ts:${index}`,
          calledName,
        })),
      );
      const before = await fs.readFile(path.join(candidate, 'manifest.json'));
      const allowance = request.artifactAllowance.remainingBytes;
      const verified = await verifyScopeRetentionCandidate(directory, expected, request);
      expect(verified.families.find((family) => family.name === 'calls')?.recordCount).toBe(count);
      expect(verified.seedReady).toBe(false);
      expect(request.artifactAllowance.remainingBytes).toBe(allowance);
      expect(await fs.readFile(path.join(candidate, 'manifest.json'))).toEqual(before);
    },
  );

  it.each([
    ['unknown registration kind', 'model-registrations', { kind: 'symbol.unknown' }],
    ['invalid node label', 'model-registrations', { ...symbolRegistration, type: 'UnknownLabel' }],
    [
      'negative parameter count',
      'model-registrations',
      { ...symbolRegistration, metadata: { parameterCount: -1 } },
    ],
    [
      'fractional parameter count',
      'model-registrations',
      { ...symbolRegistration, metadata: { parameterCount: 0.5 } },
    ],
    [
      'invalid owner metadata',
      'model-registrations',
      { ...symbolRegistration, metadata: { ownerId: 42 } },
    ],
    [
      'unknown metadata field',
      'model-registrations',
      { ...symbolRegistration, metadata: { extra: 'value' } },
    ],
    [
      'invalid method owner',
      'model-registrations',
      {
        kind: 'method.register',
        ownerNodeId: 42,
        name: 'run',
        def: { nodeId: 'method:run', filePath: 'src/example.ts', type: 'Method' },
      },
    ],
    ['unsupported import version', 'import-states', { ...emptyImportState, version: 2 }],
    [
      'duplicate import files',
      'import-states',
      {
        ...emptyImportState,
        importMap: [
          ['file.ts', []],
          ['file.ts', []],
        ],
      },
    ],
    [
      'duplicate import paths',
      'import-states',
      { ...emptyImportState, importMap: [['file.ts', ['dep.ts', 'dep.ts']]] },
    ],
    [
      'malformed named binding',
      'import-states',
      {
        ...emptyImportState,
        namedImportMap: [['file.ts', [['local', { sourcePath: 'dep.ts', exportedName: 42 }]]]],
      },
    ],
    [
      'malformed module alias',
      'import-states',
      { ...emptyImportState, moduleAliasMap: [['file.ts', [['alias', 42]]]] },
    ],
  ])('rejects a correctly hashed semantic record: %s', async (_name, family, record) => {
    const { directory, candidate, request } = await setup();
    await replaceFamilyRecords(candidate, family as string, [record]);
    const allowance = request.artifactAllowance.remainingBytes;
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });

  it('rejects multiple correctly hashed import snapshots with matching record counts', async () => {
    const { directory, candidate, request } = await setup();
    await replaceFamilyRecords(candidate, 'import-states', [emptyImportState, emptyImportState]);
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
  });

  it.each([
    ['source digest', { ...identity, sourceManifestDigest: 'c'.repeat(64) }, parserCodeIdentity],
    ['target commit', { ...identity, targetCommit: 'other' }, parserCodeIdentity],
    ['base generation', { ...identity, baseGenerationId: 'base' }, parserCodeIdentity],
    ['parser code', identity, 'c'.repeat(64)],
    ['missing parser code', identity, null],
  ])('rejects a different expected %s', async (_name, otherIdentity, otherParserCodeIdentity) => {
    const { directory, request } = await setup();
    await expect(
      verifyScopeRetentionCandidate(
        directory,
        {
          identity: otherIdentity,
          parserCodeIdentity: otherParserCodeIdentity,
        },
        request,
      ),
    ).rejects.toThrow();
  });

  it.each([
    [
      'missing family',
      (m: ScopeRetentionCandidateManifest) => {
        m.families.pop();
      },
    ],
    [
      'duplicate family',
      (m: ScopeRetentionCandidateManifest) => {
        m.families[1] = { ...m.families[0]! };
      },
    ],
    [
      'traversal filename',
      (m: ScopeRetentionCandidateManifest) => {
        m.families[0]!.fileName = '../parsed-files.jsonl';
      },
    ],
    [
      'seed readiness',
      (m: ScopeRetentionCandidateManifest) => {
        Object.assign(m, { seedReady: true });
      },
    ],
    [
      'format version',
      (m: ScopeRetentionCandidateManifest) => {
        Object.assign(m, { version: 999 });
      },
    ],
    [
      'record count',
      (m: ScopeRetentionCandidateManifest) => {
        m.totalRecordCount = 1;
      },
    ],
    [
      'family hash',
      (m: ScopeRetentionCandidateManifest) => {
        m.families[0]!.sha256 = 'c'.repeat(64);
      },
    ],
  ])('rejects manifest tampering: %s', async (_name, mutate) => {
    const { directory, candidate, request } = await setup();
    await mutateManifest(candidate, mutate);
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
  });

  it.each(['missing file', 'changed bytes', 'malformed record'])(
    'rejects family tampering: %s',
    async (kind) => {
      const { directory, candidate, request } = await setup();
      const familyPath = path.join(candidate, 'calls.jsonl');
      if (kind === 'missing file') {
        await fs.unlink(familyPath);
      } else {
        const data = kind === 'malformed record' ? '{broken json\n' : '{}\n';
        await fs.writeFile(familyPath, data);
        if (kind === 'malformed record') {
          await mutateManifest(candidate, (manifest) => {
            const family = manifest.families.find((entry) => entry.name === 'calls')!;
            family.bytes = Buffer.byteLength(data);
            family.sha256 = createHash('sha256').update(data).digest('hex');
            family.recordCount = 1;
            manifest.totalRecordCount = 1;
          });
        }
      }
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
    },
  );

  it.each(['truncated', 'oversized', 'forged bytes'])(
    'rejects an invalid manifest: %s',
    async (kind) => {
      const { directory, candidate, request, manifest } = await setup();
      const file = path.join(candidate, 'manifest.json');
      const data =
        kind === 'truncated'
          ? '{'
          : kind === 'oversized'
            ? ' '.repeat(8 * 1024 * 1024 + 1)
            : JSON.stringify({
                ...manifest,
                totalBytes: manifest.totalBytes + 1,
                artifactBytes: manifest.artifactBytes + 1,
              });
      await fs.writeFile(file, data);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
    },
  );

  it.each(['family', 'manifest', 'directory'])('rejects a symlinked %s', async (kind) => {
    const { directory, candidate, request } = await setup();
    const source =
      kind === 'directory'
        ? candidate
        : path.join(candidate, kind === 'family' ? 'calls.jsonl' : 'manifest.json');
    const moved = path.join(directory, `original-${kind}`);
    await fs.rename(source, moved);
    await fs.symlink(moved, source, kind === 'directory' ? 'dir' : 'file');
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow();
  });

  it('rejects cancelled and expired requests', async () => {
    const { directory, request } = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      verifyScopeRetentionCandidate(directory, expected, { ...request, signal: controller.signal }),
    ).rejects.toThrow(/cancel|abort/i);
    await expect(
      verifyScopeRetentionCandidate(directory, expected, { deadline: 0 }),
    ).rejects.toThrow(/deadline/i);
  });

  it('removes output and refunds writer bytes when persisted verification fails', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'scope-candidate-writer-verification-test-'),
    );
    directories.push(directory);
    const request = {
      deadline: Date.now() + 60_000,
      artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
    };
    const stage = new ScopeRetentionStage(request);
    stages.push(stage);
    const allowance = request.artifactAllowance.remainingBytes;
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        await writeFile(...args);
        if (String(args[0]).endsWith('manifest.json')) {
          await fs.appendFile(
            path.join(directory, 'scope-retention-candidate', 'calls.jsonl'),
            '{}\n',
          );
        }
      },
    );
    await expect(
      persistScopeRetentionCandidate(stage, directory, identity, request),
    ).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
    expect(request.artifactAllowance.remainingBytes).toBe(allowance);
  });
});
