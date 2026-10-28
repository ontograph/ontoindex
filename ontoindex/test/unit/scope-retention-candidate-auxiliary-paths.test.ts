import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedFile } from 'ontoindex-shared';
import { ScopeRetentionStage } from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import {
  persistScopeRetentionCandidate,
  type ScopeRetentionCandidateManifest,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { verifyScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
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

async function setup(capture: (stage: ScopeRetentionStage) => void) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'scope-candidate-auxiliary-paths-test-'),
  );
  directories.push(directory);
  const request = {
    deadline: Date.now() + 60_000,
    artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
  };
  const stage = new ScopeRetentionStage(request);
  stages.push(stage);
  stage.captureParserCodeIdentity(parserCodeIdentity);
  capture(stage);
  const manifest = await persistScopeRetentionCandidate(stage, directory, identity, request);
  return {
    directory,
    request,
    manifest,
    candidate: path.join(directory, 'scope-retention-candidate'),
  };
}

// Preserve byte accounting so rejection exercises semantics rather than stale totals.
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
const auxiliaryCall: Parameters<ScopeRetentionStage['captureCalls']>[0][number] = {
  filePath: 'src/example.ts',
  calledName: 'save',
  sourceId: 'Function:src/example.ts:example',
  argCount: 3,
  callForm: 'member',
  receiverName: 'service',
  receiverTypeName: 'Service',
  receiverMixedChain: [
    { kind: 'call', name: 'getUser' },
    { kind: 'field', name: 'address' },
    { kind: 'call', name: 'normalize' },
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
const auxiliaryFamilies: [string, Record<string, unknown>][] = [
  ['calls', auxiliaryCall],
  ['heritage', auxiliaryHeritage],
  ['assignments', auxiliaryAssignment],
  ['constructor-bindings', auxiliaryConstructor],
  ['exported-types', auxiliaryExport],
  ['file-bindings', auxiliaryFileBinding],
];

function captureRetained(stage: ScopeRetentionStage) {
  stage.capture([parsedFile]);
  stage.captureCalls([auxiliaryCall]);
  stage.captureHeritage([auxiliaryHeritage]);
  stage.captureAssignments([auxiliaryAssignment]);
  stage.captureConstructorBindings([auxiliaryConstructor]);
  stage.captureExportedTypes([auxiliaryExport]);
  stage.captureFileBindings([auxiliaryFileBinding]);
  stage.captureImportState(createResolutionContext());
  stage.recordOutcomes([{ filePath: parsedFile.filePath, status: 'success' }]);
  stage.reconcile([parsedFile.filePath]);
  for (const family of Object.keys(stage.producerCompletion)) {
    stage.markProducerCompleted(family as keyof typeof stage.producerCompletion);
  }
}

afterEach(async () => {
  for (const stage of stages.splice(0)) await stage.dispose();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

const onFile = (record: Record<string, unknown>, filePath: string): Record<string, unknown> =>
  'sourceId' in record
    ? { ...record, filePath, sourceId: `Function:${filePath}:example` }
    : { ...record, filePath };

describe('scope retention candidate auxiliary file paths', () => {
  it('verifies a retained candidate with all six auxiliary families on a retained parsed file', async () => {
    const { directory, request, manifest } = await setup(captureRetained);
    expect(manifest.retention.status).toBe('retained');
    expect(manifest.retention.inventory).toEqual([
      { filePath: parsedFile.filePath, status: 'retained' },
    ]);
    expect(Object.values(manifest.retention.producerCompletion)).toEqual(Array(16).fill(true));
    for (const [family] of auxiliaryFamilies) {
      expect(manifest.families.find((entry) => entry.name === family)?.recordCount).toBe(1);
    }
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(manifest);
  });

  it.each(auxiliaryFamilies)(
    'rejects retained %s records outside the inventory',
    async (family, record) => {
      const { directory, candidate, request, manifest } = await setup(captureRetained);
      expect(manifest.retention.status).toBe('retained');
      await replaceFamilyRecords(candidate, family, [onFile(record, 'src/outside.ts')]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary record file not retained',
      );
    },
  );

  it.each(auxiliaryFamilies)(
    'rejects retained %s records on a non-retained inventory entry',
    async (family, record) => {
      const { directory, candidate, request, manifest } = await setup(captureRetained);
      expect(manifest.retention.status).toBe('retained');
      await mutateManifest(candidate, (current) => {
        current.retention.inventory = [
          ...current.retention.inventory,
          { filePath: 'src/skipped.ts', status: 'skipped' },
        ];
        current.coverage = summarizeScopeRetentionCoverage(current.retention.inventory);
      });
      await replaceFamilyRecords(candidate, family, [onFile(record, 'src/skipped.ts')]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary record file not retained',
      );
    },
  );

  it.each(auxiliaryFamilies)(
    'still verifies incomplete %s records outside the inventory',
    async (family, record) => {
      const { directory, candidate, request, manifest } = await setup((stage) =>
        stage.capture([parsedFile]),
      );
      expect(manifest.retention.status).toBe('incomplete');
      await replaceFamilyRecords(candidate, family, [onFile(record, 'src/auxiliary-only.ts')]);
      const persisted = JSON.parse(
        await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'),
      );
      expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(persisted);
    },
  );
});

describe('scope retention candidate auxiliary source IDs', () => {
  const sourceFamilies = ['calls', 'assignments'] as const;
  const sourceRecords = { calls: auxiliaryCall, assignments: auxiliaryAssignment };

  async function setupRetainedWithSourceIds() {
    const result = await setup(captureRetained);
    for (const family of sourceFamilies) {
      await replaceFamilyRecords(result.candidate, family, [
        {
          ...sourceRecords[family],
          sourceId: `Function:${parsedFile.filePath}:example`,
        },
      ]);
    }
    return result;
  }

  it.each(sourceFamilies)(
    'rejects retained %s source IDs belonging to another file',
    async (family) => {
      const { directory, candidate, request, manifest } = await setupRetainedWithSourceIds();
      expect(manifest.retention.status).toBe('retained');
      await replaceFamilyRecords(candidate, family, [
        {
          ...sourceRecords[family],
          sourceId: 'Function:other/path.ts:f',
        },
      ]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary source id does not belong to its file',
      );
    },
  );

  it.each(sourceFamilies)(
    'rejects retained %s source IDs without a kind separator',
    async (family) => {
      const { directory, candidate, request } = await setupRetainedWithSourceIds();
      await replaceFamilyRecords(candidate, family, [
        { ...sourceRecords[family], sourceId: 'plain' },
      ]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary source id does not belong to its file',
      );
    },
  );

  it.each(sourceFamilies)(
    'rejects retained %s source IDs with only a file-path prefix match',
    async (family) => {
      const { directory, candidate, request } = await setupRetainedWithSourceIds();
      await replaceFamilyRecords(candidate, family, [
        {
          ...sourceRecords[family],
          sourceId: `Function:${parsedFile.filePath}x:f`,
        },
      ]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary source id does not belong to its file',
      );
    },
  );

  it.each(sourceFamilies)(
    'rejects retained %s File source IDs with a foreign suffix',
    async (family) => {
      const { directory, candidate, request } = await setupRetainedWithSourceIds();
      await replaceFamilyRecords(candidate, family, [
        {
          ...sourceRecords[family],
          sourceId: `File:${parsedFile.filePath}:foreign`,
        },
      ]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary source id does not belong to its file',
      );
    },
  );

  it.each(sourceFamilies)(
    'rejects incomplete %s File source IDs with a foreign suffix',
    async (family) => {
      const { directory, candidate, request, manifest } = await setup((stage) =>
        stage.capture([parsedFile]),
      );
      expect(manifest.retention.status).toBe('incomplete');
      await replaceFamilyRecords(candidate, family, [
        {
          ...sourceRecords[family],
          sourceId: `File:${parsedFile.filePath}:foreign`,
        },
      ]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary source id does not belong to its file',
      );
    },
  );

  it.each(sourceFamilies)(
    'verifies incomplete %s File source IDs with a colon in the file path',
    async (family) => {
      const { directory, candidate, request, manifest } = await setup((stage) =>
        stage.capture([parsedFile]),
      );
      expect(manifest.retention.status).toBe('incomplete');
      await replaceFamilyRecords(candidate, family, [
        {
          ...sourceRecords[family],
          filePath: 'src/a:b.ts',
          sourceId: 'File:src/a:b.ts',
        },
      ]);
      const persisted = JSON.parse(
        await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'),
      );
      expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(persisted);
    },
  );

  it.each(
    sourceFamilies.flatMap(
      (family) =>
        [
          [family, `File:${parsedFile.filePath}`],
          [family, `Function:${parsedFile.filePath}:example`],
          [family, `Method:${parsedFile.filePath}:Example.save#1`],
        ] as const,
    ),
  )('verifies retained %s source ID %s', async (family, sourceId) => {
    const { directory, candidate, request } = await setupRetainedWithSourceIds();
    await replaceFamilyRecords(candidate, family, [{ ...sourceRecords[family], sourceId }]);
    const persisted = JSON.parse(await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'));
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(persisted);
  });

  it('rejects incomplete calls source IDs belonging to another file', async () => {
    const { directory, candidate, request, manifest } = await setup((stage) =>
      stage.capture([parsedFile]),
    );
    expect(manifest.retention.status).toBe('incomplete');
    await replaceFamilyRecords(candidate, 'calls', [
      {
        ...auxiliaryCall,
        sourceId: 'Function:other/path.ts:f',
      },
    ]);
    await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
      'auxiliary source id does not belong to its file',
    );
  });
});

describe('scope retention candidate registration owners and import callers', () => {
  const registrationKinds = [
    'symbol.add',
    'type.registerClass',
    'type.registerImpl',
    'method.register',
    'field.register',
  ] as const;
  const importMaps = ['importMap', 'packageMap', 'namedImportMap', 'moduleAliasMap'] as const;
  const ownerCases: [string, string, (filePath: string) => Record<string, unknown>][] = [
    ...registrationKinds.map(
      (kind) =>
        [
          kind,
          'model-registrations',
          (filePath: string) => {
            const def = { nodeId: 'definition:example', filePath, type: 'Class' };
            switch (kind) {
              case 'symbol.add':
                return {
                  kind,
                  filePath,
                  name: 'example',
                  nodeId: 'definition:example',
                  type: 'Class',
                };
              case 'type.registerClass':
                return { kind, name: 'Example', qualifiedName: 'example.Example', def };
              case 'type.registerImpl':
                return { kind, name: 'Example', def };
              default:
                return { kind, ownerNodeId: 'owner:example', name: 'member', def };
            }
          },
        ] as [string, string, (filePath: string) => Record<string, unknown>],
    ),
    ...importMaps.flatMap((map) =>
      [false, true].map(
        (empty) =>
          [
            `${map} ${empty ? 'empty' : 'populated'}`,
            'import-states',
            (filePath: string) => {
              const members = empty
                ? []
                : map === 'namedImportMap'
                  ? [
                      [
                        'External',
                        { sourcePath: 'external/dependency.ts', exportedName: 'External' },
                      ],
                    ]
                  : map === 'moduleAliasMap'
                    ? [['external', 'external/dependency.ts']]
                    : [map === 'packageMap' ? '/external/package/' : 'external/dependency.ts'];
              return {
                version: 1,
                importMap: [],
                packageMap: [],
                namedImportMap: [],
                moduleAliasMap: [],
                [map]: [[filePath, members]],
              };
            },
          ] as [string, string, (filePath: string) => Record<string, unknown>],
      ),
    ),
  ];

  it.each(ownerCases)(
    'rejects retained %s owners outside the inventory',
    async (_label, family, record) => {
      const { directory, candidate, request, manifest } = await setup(captureRetained);
      expect(manifest.retention.status).toBe('retained');
      await replaceFamilyRecords(candidate, family, [record('src/outside.ts')]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary record file not retained',
      );
    },
  );

  it.each(ownerCases)(
    'rejects retained %s owners on a skipped inventory entry',
    async (_label, family, record) => {
      const { directory, candidate, request } = await setup(captureRetained);
      await mutateManifest(candidate, (current) => {
        current.retention.inventory = [
          ...current.retention.inventory,
          { filePath: 'src/skipped.ts', status: 'skipped' },
        ];
        current.coverage = summarizeScopeRetentionCoverage(current.retention.inventory);
      });
      await replaceFamilyRecords(candidate, family, [record('src/skipped.ts')]);
      await expect(verifyScopeRetentionCandidate(directory, expected, request)).rejects.toThrow(
        'auxiliary record file not retained',
      );
    },
  );

  it.each(ownerCases)(
    'verifies retained %s owners with external import targets and package suffixes',
    async (_label, family, record) => {
      const { directory, candidate, request } = await setup(captureRetained);
      await replaceFamilyRecords(candidate, family, [record(parsedFile.filePath)]);
      const persisted = JSON.parse(
        await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'),
      );
      expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(persisted);
    },
  );

  it.each(ownerCases)(
    'verifies incomplete %s owners outside the inventory',
    async (_label, family, record) => {
      const { directory, candidate, request, manifest } = await setup((stage) =>
        stage.capture([parsedFile]),
      );
      expect(manifest.retention.status).toBe('incomplete');
      await replaceFamilyRecords(candidate, family, [record('src/outside.ts')]);
      const persisted = JSON.parse(
        await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'),
      );
      expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(persisted);
    },
  );

  it('verifies retained registration clear events without requiring file owners', async () => {
    const { directory, candidate, request } = await setup(captureRetained);
    await replaceFamilyRecords(candidate, 'model-registrations', [
      { kind: 'type.clear' },
      { kind: 'method.clear' },
      { kind: 'field.clear' },
      { kind: 'model.clear' },
    ]);
    const persisted = JSON.parse(await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'));
    expect(await verifyScopeRetentionCandidate(directory, expected, request)).toEqual(persisted);
  });
});
