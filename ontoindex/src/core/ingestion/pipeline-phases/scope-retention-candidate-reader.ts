import fs, { type FileHandle } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { buildScopeTree, getLanguageFromFilename, type GraphRelationship } from 'ontoindex-shared';
import type {
  ScopeRetentionCandidateIdentity,
  ScopeRetentionCandidateManifest,
} from './scope-retention-candidate.js';
import {
  ScopeRetentionStage,
  snapshotScopeRetentionDiscovery,
  type ScopeRetentionHandle,
  type ScopeRetentionRequest,
} from './scope-retention-stage.js';
import { summarizeScopeRetentionCoverage } from './scope-retention-coverage.js';
import { cloneRegistrationEvent } from '../model/semantic-model.js';
import { restoreImportResolutionState } from '../model/resolution-context.js';
import {
  decodeParsedFileRecord,
  MAX_PARSED_FILE_RECORD_BYTES,
  MAX_GRAPH_RECORD_BYTES,
  encodeGraphNodeRecord,
  encodeGraphRelationshipRecord,
} from './parse-scope-codec.js';

const MAX_BYTES = 64 * 1024 * 1024;
/**
 * Shared by the writer and this reader. The manifest carries one inventory and one input-evidence
 * entry per file (about 200 bytes each), so 1 MiB refused a real 7033-file workspace (1.44 MB).
 */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = MAX_GRAPH_RECORD_BYTES;
const MAX_RECORDS = 100_000;
const FAMILY_NAMES = [
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
] as const;
const FAMILY_KEYS = {
  'parsed-files': 'parsedFiles',
  calls: 'calls',
  heritage: 'heritage',
  assignments: 'assignments',
  'constructor-bindings': 'constructors',
  'exported-types': 'exportedTypes',
  'file-bindings': 'fileBindings',
  'model-registrations': 'events',
  'import-states': 'importStates',
  'graph-nodes': 'declarationNodes',
  'graph-relationships': 'structuralRelationships',
  'orm-queries': 'ormQueries',
  'fetch-calls': 'fetchCalls',
  routes: 'routes',
  'decorator-routes': 'decoratorRoutes',
  'tool-definitions': 'toolDefinitions',
} as const;
type RecordsOf<K extends keyof ScopeRetentionHandle> =
  ScopeRetentionHandle[K] extends () => AsyncIterable<readonly (infer T)[]> ? T[] : never;
export interface ScopeRetentionCandidateFamilies {
  parsedFiles: RecordsOf<'iterate'>;
  calls: RecordsOf<'iterateCalls'>;
  heritage: RecordsOf<'iterateHeritage'>;
  assignments: RecordsOf<'iterateAssignments'>;
  constructors: RecordsOf<'iterateConstructorBindings'>;
  exportedTypes: RecordsOf<'iterateExportedTypes'>;
  fileBindings: RecordsOf<'iterateFileBindings'>;
  events: RecordsOf<'iterateModelRegistrations'>;
  importStates: RecordsOf<'iterateImportStates'>;
  declarationNodes: RecordsOf<'iterateGraphNodes'>;
  structuralRelationships: RecordsOf<'iterateGraphRelationships'>;
  ormQueries: RecordsOf<'iterateORMQueries'>;
  fetchCalls: RecordsOf<'iterateFetchCalls'>;
  routes: RecordsOf<'iterateRoutes'>;
  decoratorRoutes: RecordsOf<'iterateDecoratorRoutes'>;
  toolDefinitions: RecordsOf<'iterateToolDefinitions'>;
}
function fail(reason: string): never {
  throw new Error(`scope-retention-candidate: ${reason}`);
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const identityPart = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const sameStat = (before: Stats, after: Stats): boolean =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs;
function sourceIdOwnsFile(sourceId: unknown, filePath: unknown): boolean {
  if (typeof sourceId !== 'string' || typeof filePath !== 'string') return false;
  if (sourceId.startsWith('File:')) return sourceId === `File:${filePath}`;
  const i = sourceId.indexOf(':');
  if (i <= 0) return false;
  const rest = sourceId.slice(i + 1);
  return rest === filePath || rest.startsWith(filePath + ':');
}

/** Integrity of observed candidate bytes; the caller owns and pins the generation throughout.
 * This does not establish semantic seed completeness or an atomic adversarial snapshot.
 */
export async function verifyScopeRetentionCandidate(
  generationPath: string,
  expected: { identity: ScopeRetentionCandidateIdentity; parserCodeIdentity: string | null },
  request: Pick<ScopeRetentionRequest, 'deadline' | 'signal'>,
): Promise<ScopeRetentionCandidateManifest> {
  return (await readScopeRetentionCandidate(generationPath, expected, request, false)).manifest;
}

/** Materialize owned records only after the same bounded integrity checks as verification. */
export async function loadScopeRetentionCandidate(
  generationPath: string,
  expected: Parameters<typeof verifyScopeRetentionCandidate>[1],
  request: Pick<ScopeRetentionRequest, 'deadline' | 'signal'>,
): Promise<{
  manifest: ScopeRetentionCandidateManifest;
  families: ScopeRetentionCandidateFamilies;
}> {
  const result = await readScopeRetentionCandidate(generationPath, expected, request, true);
  return { manifest: result.manifest, families: result.families! };
}

async function readScopeRetentionCandidate(
  generationPath: string,
  expected: Parameters<typeof verifyScopeRetentionCandidate>[1],
  request: Pick<ScopeRetentionRequest, 'deadline' | 'signal'>,
  hydrate: boolean,
): Promise<{
  manifest: ScopeRetentionCandidateManifest;
  families?: ScopeRetentionCandidateFamilies;
}> {
  // Provisional state remains private until every final integrity check succeeds.
  const families: ScopeRetentionCandidateFamilies | undefined = hydrate
    ? {
        parsedFiles: [],
        calls: [],
        heritage: [],
        assignments: [],
        constructors: [],
        exportedTypes: [],
        fileBindings: [],
        events: [],
        importStates: [],
        declarationNodes: [],
        structuralRelationships: [],
        ormQueries: [],
        fetchCalls: [],
        routes: [],
        decoratorRoutes: [],
        toolDefinitions: [],
      }
    : undefined;
  if (!Number.isFinite(request.deadline)) fail('invalid request');
  const check = () => {
    if (request.signal?.aborted) fail('cancelled');
    if (Date.now() >= request.deadline) fail('deadline');
  };
  check();
  const expectedIdentity = expected.identity;
  if (
    !object(expectedIdentity) ||
    !digest(expectedIdentity.sourceManifestDigest) ||
    (expectedIdentity.targetCommit !== '' && !identityPart(expectedIdentity.targetCommit)) ||
    (expectedIdentity.baseGenerationId !== null &&
      !identityPart(expectedIdentity.baseGenerationId)) ||
    (expected.parserCodeIdentity !== null && !digest(expected.parserCodeIdentity))
  ) {
    fail('invalid expected identity');
  }
  const directory = path.join(generationPath, 'scope-retention-candidate');
  const directoryStat = await fs.lstat(directory);
  check();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('invalid directory');
  const expectedNames = new Set(['manifest.json', ...FAMILY_NAMES.map((name) => `${name}.jsonl`)]);
  // Iteration also bounds admission when an unexpected directory has many entries.
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    check();
    if (!expectedNames.delete(entry.name) || !entry.isFile()) fail('unexpected directory entry');
  }
  if (expectedNames.size) fail('missing directory entry');

  const open = async (
    filePath: string,
    limit: number,
  ): Promise<{ file: FileHandle; stat: Stats }> => {
    check();
    const file = await fs.open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      check();
      const stat = await file.stat();
      check();
      if (!stat.isFile() || !count(stat.size, limit)) fail('invalid file or byte limit');
      return { file, stat };
    } catch (error) {
      await file.close();
      throw error;
    }
  };
  const readManifest = async (): Promise<Buffer> => {
    const { file, stat } = await open(path.join(directory, 'manifest.json'), MAX_MANIFEST_BYTES);
    try {
      const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        check();
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        check();
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_MANIFEST_BYTES || size !== stat.size || !sameStat(stat, await file.stat())) {
        fail('manifest changed or byte limit');
      }
      check();
      return buffer.subarray(0, size);
    } finally {
      await file.close();
    }
  };
  const manifestBytes = await readManifest();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const value: unknown = JSON.parse(decoder.decode(manifestBytes));
  if (object(value) && [1, 2, 3, 4].includes(value.version as number))
    fail('unsupported legacy manifest version');
  if (
    !object(value) ||
    value.version !== 5 ||
    value.status !== 'candidate' ||
    value.seedReady !== false ||
    value.evidenceScope !== 'observed-parser-inputs' ||
    !count(value.totalRecordCount, MAX_RECORDS) ||
    !count(value.totalBytes, MAX_BYTES) ||
    value.artifactBytes !== value.totalBytes
  )
    fail('invalid manifest');
  const manifestIdentity = value.identity;
  if (
    !object(manifestIdentity) ||
    Object.keys(manifestIdentity).length !== 3 ||
    manifestIdentity.sourceManifestDigest !== expectedIdentity.sourceManifestDigest ||
    manifestIdentity.targetCommit !== expectedIdentity.targetCommit ||
    manifestIdentity.baseGenerationId !== expectedIdentity.baseGenerationId
  )
    fail('identity mismatch');
  const retention = value.retention;
  if (
    !object(retention) ||
    !['retained', 'incomplete'].includes(retention.status as string) ||
    !strings(retention.reasons) ||
    !Array.isArray(retention.inventory) ||
    !retention.inventory.every(
      (item) =>
        object(item) &&
        typeof item.filePath === 'string' &&
        typeof item.status === 'string' &&
        (!Object.hasOwn(item, 'reason') || item.reason === 'unsupported-syntax'),
    ) ||
    typeof retention.graphNodesCaptured !== 'boolean' ||
    typeof retention.graphRelationshipsCaptured !== 'boolean'
  )
    fail('invalid retention metadata');
  if (
    !object(value.coverage) ||
    !isDeepStrictEqual(value.coverage, summarizeScopeRetentionCoverage(retention.inventory))
  ) {
    fail('coverage mismatch');
  }
  if (retention.discovery !== null) {
    const discovery = retention.discovery;
    if (
      !object(discovery) ||
      !strings(discovery.allPaths) ||
      !Array.isArray(discovery.scanned) ||
      !Array.isArray(discovery.skipped) ||
      !discovery.scanned.every(
        (item) =>
          object(item) &&
          typeof item.path === 'string' &&
          (item.language === null || typeof item.language === 'string'),
      ) ||
      !discovery.skipped.every(
        (item) =>
          object(item) &&
          typeof item.path === 'string' &&
          count(item.size, Number.MAX_SAFE_INTEGER),
      )
    ) {
      fail('invalid discovery evidence');
    }
    try {
      const canonical = snapshotScopeRetentionDiscovery(
        discovery.allPaths,
        discovery.scanned.map((item) => ({
          path: item.path,
          size: 0,
          shebangLanguage: item.language,
        })) as Parameters<typeof snapshotScopeRetentionDiscovery>[1],
        discovery.skipped as Parameters<typeof snapshotScopeRetentionDiscovery>[2],
        check,
      );
      if (!isDeepStrictEqual(canonical, discovery)) fail('noncanonical discovery evidence');
    } catch {
      check();
      fail('invalid discovery evidence');
    }
  }
  const completion = retention.producerCompletion;
  if (
    !object(completion) ||
    Object.keys(completion).length !== FAMILY_NAMES.length ||
    !FAMILY_NAMES.every(
      (name) => Object.hasOwn(completion, name) && typeof completion[name] === 'boolean',
    )
  ) {
    fail('invalid producer completion');
  }
  if (
    completion['graph-nodes'] !== retention.graphNodesCaptured ||
    completion['graph-relationships'] !== retention.graphRelationshipsCaptured
  ) {
    fail('inconsistent graph producer completion');
  }
  const evidence = retention.inputEvidence;
  if (
    !object(evidence) ||
    evidence.domain !== 'parser-text-utf8' ||
    typeof evidence.complete !== 'boolean' ||
    (evidence.configuration !== null && !object(evidence.configuration)) ||
    (evidence.parserCodeIdentity !== null && !digest(evidence.parserCodeIdentity)) ||
    evidence.parserCodeIdentity !== expected.parserCodeIdentity ||
    !strings(evidence.reasons) ||
    !Array.isArray(evidence.sources) ||
    !evidence.sources.every(
      (source) =>
        object(source) &&
        typeof source.filePath === 'string' &&
        digest(source.sha256) &&
        count(source.byteLength, Number.MAX_SAFE_INTEGER),
    )
  )
    fail('invalid input evidence or identity');
  if (evidence.configuration !== null) {
    const configurationValidator = new ScopeRetentionStage(
      {
        ...request,
        artifactAllowance: { remainingBytes: 1024 * 1024 },
      },
      { maxBytes: 1024 * 1024 },
    );
    try {
      check();
      configurationValidator.captureConfigObservations(
        evidence.configuration as unknown as Parameters<
          ScopeRetentionStage['captureConfigObservations']
        >[0],
      );
      check();
      if (configurationValidator.inputEvidence.configuration === null)
        fail('invalid configuration evidence');
    } finally {
      await configurationValidator.dispose();
    }
    check();
  }
  const inventoryPaths = new Set<string>();
  const retainedInventoryPaths = new Set<string>();
  let retainedInventoryCount = 0;
  for (const item of retention.inventory) {
    if (inventoryPaths.has(item.filePath)) fail('duplicate inventory file path');
    inventoryPaths.add(item.filePath);
    if (item.status === 'retained') {
      retainedInventoryCount++;
      retainedInventoryPaths.add(item.filePath);
    }
  }
  const sourcePaths = new Set<string>();
  for (const source of evidence.sources) {
    if (sourcePaths.has(source.filePath)) fail('duplicate input evidence file path');
    sourcePaths.add(source.filePath);
  }
  if (retention.status === 'retained' && retention.discovery !== null) {
    const discovery = retention.discovery as unknown as NonNullable<
      ScopeRetentionHandle['discovery']
    >;
    const languages = new Map(discovery.scanned.map((item) => [item.path, item.language]));
    const expectedPaths = discovery.allPaths.filter(
      (file) => (getLanguageFromFilename(file) ?? languages.get(file)) != null,
    );
    if (
      discovery.skipped.length ||
      expectedPaths.length !== inventoryPaths.size ||
      expectedPaths.some((file) => !inventoryPaths.has(file))
    )
      fail('discovery parser inventory mismatch');
  }
  if (
    evidence.complete !== (evidence.reasons.length === 0) ||
    (evidence.complete &&
      (retention.status !== 'retained' ||
        retention.reasons.length > 0 ||
        !object(evidence.configuration) ||
        evidence.configuration.complete !== true ||
        retention.discovery === null ||
        sourcePaths.size !== inventoryPaths.size))
  ) {
    fail('inconsistent input evidence completeness');
  }
  if (evidence.complete) {
    for (const filePath of inventoryPaths) {
      if (!sourcePaths.has(filePath)) fail('inconsistent input evidence completeness');
    }
  }
  if (FAMILY_NAMES.some((name) => completion[name]) && retention.reasons.length > 0) {
    fail('producer completion with retention issues');
  }
  if (!Array.isArray(value.families) || value.families.length !== FAMILY_NAMES.length) {
    fail('invalid families');
  }
  let descriptorBytes = manifestBytes.length;
  let descriptorRecords = 0;
  for (const [index, family] of value.families.entries()) {
    const name = FAMILY_NAMES[index]!;
    if (
      !object(family) ||
      family.name !== name ||
      family.fileName !== `${name}.jsonl` ||
      !count(family.bytes, MAX_BYTES) ||
      !count(family.recordCount, MAX_RECORDS) ||
      !digest(family.sha256)
    )
      fail('invalid family descriptor');
    if (name === 'import-states' && family.recordCount > 1) fail('multiple import state snapshots');
    if (name === 'import-states' && completion[name] && family.recordCount !== 1) {
      fail('completed import producer requires one snapshot');
    }
    descriptorBytes += family.bytes;
    descriptorRecords += family.recordCount;
  }
  if (descriptorBytes !== value.totalBytes || descriptorRecords !== value.totalRecordCount) {
    fail('manifest totals mismatch');
  }
  const manifest = value as unknown as ScopeRetentionCandidateManifest;
  const observed: { filePath: string; stat: Stats }[] = [];
  let totalRecords = 0;
  let totalBytes = manifestBytes.length;
  const parsedFilePaths = new Set<string>();
  const scopeIds = new Set<string>();
  const auxiliaryPaths = new Set<string>();
  const graphNodeIds = new Set<string>();
  const graphRelationshipIds = new Set<string>();
  let scratch: ScopeRetentionStage | undefined;
  let scratchBytes = 0;
  let scratchRecords = 0;
  const validateAuxiliary = async (
    family: string,
    record: Record<string, unknown>,
    lineBytes: number,
  ): Promise<void> => {
    if (scratch && (scratchBytes + lineBytes > 512 * 1024 || scratchRecords >= 1000)) {
      await scratch.dispose();
      scratch = undefined;
    }
    if (!scratch) {
      scratch = new ScopeRetentionStage(
        {
          ...request,
          artifactAllowance: { remainingBytes: 1024 * 1024 },
        },
        { maxBytes: 1024 * 1024, maxRecords: 1000 },
      );
      scratchBytes = 0;
      scratchRecords = 0;
    }
    let before: number;
    let after: number;
    switch (family) {
      case 'calls': {
        const call = Array.isArray(record.argTypes)
          ? {
              ...record,
              argTypes: record.argTypes.map((value) => (value === null ? undefined : value)),
            }
          : record;
        before = scratch.callRecordCount;
        scratch.captureCalls([
          call as unknown as Parameters<ScopeRetentionStage['captureCalls']>[0][number],
        ]);
        after = scratch.callRecordCount;
        break;
      }
      case 'heritage':
        before = scratch.heritageRecordCount;
        scratch.captureHeritage([
          record as unknown as Parameters<ScopeRetentionStage['captureHeritage']>[0][number],
        ]);
        after = scratch.heritageRecordCount;
        break;
      case 'assignments':
        before = scratch.assignmentRecordCount;
        scratch.captureAssignments([
          record as unknown as Parameters<ScopeRetentionStage['captureAssignments']>[0][number],
        ]);
        after = scratch.assignmentRecordCount;
        break;
      case 'constructor-bindings':
        if (!Array.isArray(record.bindings) || record.bindings.length !== 1) {
          fail('invalid constructor binding record');
        }
        before = scratch.constructorBindingRecordCount;
        scratch.captureConstructorBindings([
          record as unknown as Parameters<
            ScopeRetentionStage['captureConstructorBindings']
          >[0][number],
        ]);
        after = scratch.constructorBindingRecordCount;
        break;
      case 'exported-types':
        before = scratch.exportedTypeRecordCount;
        scratch.captureExportedTypes([
          record as unknown as Parameters<ScopeRetentionStage['captureExportedTypes']>[0][number],
        ]);
        after = scratch.exportedTypeRecordCount;
        break;
      case 'file-bindings':
        before = scratch.fileBindingRecordCount;
        scratch.captureFileBindings([
          record as unknown as Parameters<ScopeRetentionStage['captureFileBindings']>[0][number],
        ]);
        after = scratch.fileBindingRecordCount;
        break;
      case 'orm-queries':
        before = scratch.ormQueryRecordCount;
        scratch.captureORMQueries([
          record as unknown as Parameters<ScopeRetentionStage['captureORMQueries']>[0][number],
        ]);
        after = scratch.ormQueryRecordCount;
        break;
      case 'fetch-calls':
        before = scratch.fetchCallRecordCount;
        scratch.captureFetchCalls([
          record as unknown as Parameters<ScopeRetentionStage['captureFetchCalls']>[0][number],
        ]);
        after = scratch.fetchCallRecordCount;
        break;
      case 'routes':
        before = scratch.routeRecordCount;
        scratch.captureRoutes([
          record as unknown as Parameters<ScopeRetentionStage['captureRoutes']>[0][number],
        ]);
        after = scratch.routeRecordCount;
        break;
      case 'decorator-routes':
        before = scratch.decoratorRouteRecordCount;
        scratch.captureDecoratorRoutes([
          record as unknown as Parameters<ScopeRetentionStage['captureDecoratorRoutes']>[0][number],
        ]);
        after = scratch.decoratorRouteRecordCount;
        break;
      case 'tool-definitions':
        before = scratch.toolDefinitionRecordCount;
        scratch.captureToolDefinitions([
          record as unknown as Parameters<ScopeRetentionStage['captureToolDefinitions']>[0][number],
        ]);
        after = scratch.toolDefinitionRecordCount;
        break;
      default:
        return;
    }
    if (scratch.reasons.length || after !== before + 1) fail(`invalid ${family} record`);
    scratchBytes += lineBytes;
    scratchRecords++;
  };
  try {
    for (const family of manifest.families) {
      check();
      const filePath = path.join(directory, family.fileName);
      const { file, stat } = await open(filePath, family.bytes);
      try {
        if (stat.size !== family.bytes) fail('family byte mismatch');
        const hash = createHash('sha256');
        const chunk = Buffer.alloc(64 * 1024);
        const maxLineBytes =
          family.name === 'parsed-files' ? MAX_PARSED_FILE_RECORD_BYTES : MAX_LINE_BYTES;
        const pending = Buffer.alloc(maxLineBytes);
        let pendingBytes = 0;
        let bytes = 0;
        let records = 0;
        for (;;) {
          check();
          const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
          check();
          if (!bytesRead) break;
          bytes += bytesRead;
          totalBytes += bytesRead;
          if (bytes > family.bytes || totalBytes > MAX_BYTES) fail('family byte limit');
          hash.update(chunk.subarray(0, bytesRead));
          let start = 0;
          while (start < bytesRead) {
            check();
            const newline = chunk.indexOf(10, start);
            const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
            const length = end - start;
            if (pendingBytes + length >= maxLineBytes) fail('record byte limit');
            chunk.copy(pending, pendingBytes, start, end);
            pendingBytes += length;
            if (end === bytesRead) break;
            if (
              pendingBytes === 0 ||
              ++records > family.recordCount ||
              ++totalRecords > MAX_RECORDS
            ) {
              fail('empty record or record count limit');
            }
            const line = decoder.decode(pending.subarray(0, pendingBytes));
            const record: unknown = JSON.parse(line);
            if (!object(record)) fail('invalid record');
            let decoded: unknown = record;
            if (
              [
                'calls',
                'heritage',
                'assignments',
                'constructor-bindings',
                'exported-types',
                'file-bindings',
                'orm-queries',
                'fetch-calls',
                'routes',
                'decorator-routes',
                'tool-definitions',
              ].includes(family.name)
            ) {
              await validateAuxiliary(family.name, record, pendingBytes + 1);
              if (
                (family.name === 'calls' || family.name === 'assignments') &&
                !sourceIdOwnsFile(record.sourceId, record.filePath)
              ) {
                fail('auxiliary source id does not belong to its file');
              }
              if (typeof record.filePath === 'string') auxiliaryPaths.add(record.filePath);
            }
            if (family.name === 'parsed-files') {
              const parsedFile = decodeParsedFileRecord(line);
              if (parsedFilePaths.has(parsedFile.filePath)) fail('duplicate parsed file path');
              if (!inventoryPaths.has(parsedFile.filePath))
                fail('parsed file missing from inventory');
              try {
                const tree = buildScopeTree(parsedFile.scopes);
                const moduleScope = tree.getScope(parsedFile.moduleScope);
                if (
                  moduleScope?.kind !== 'Module' ||
                  moduleScope.parent !== null ||
                  parsedFile.scopes.some((scope) => scope.filePath !== parsedFile.filePath) ||
                  parsedFile.scopes.filter((scope) => scope.parent === null).length !== 1
                ) {
                  fail('invalid parsed file scope tree');
                }
              } catch {
                // Shared invariant errors contain persisted identifiers; keep the boundary bounded.
                fail('invalid parsed file scope tree');
              }
              for (const scope of parsedFile.scopes) {
                if (scopeIds.has(scope.id)) fail('duplicate parsed file scope id');
                scopeIds.add(scope.id);
              }
              parsedFilePaths.add(parsedFile.filePath);
              decoded = parsedFile;
            }
            if (family.name === 'model-registrations') {
              const { event } = cloneRegistrationEvent(record);
              if (event.kind === 'symbol.add') auxiliaryPaths.add(event.filePath);
              else if ('def' in event) auxiliaryPaths.add(event.def.filePath);
            }
            if (family.name === 'import-states') {
              const state = restoreImportResolutionState(record);
              for (const map of [
                state.importMap,
                state.packageMap,
                state.namedImportMap,
                state.moduleAliasMap,
              ]) {
                for (const filePath of map.keys()) auxiliaryPaths.add(filePath);
              }
            }
            if (family.name === 'graph-nodes' || family.name === 'graph-relationships') {
              const key = family.name === 'graph-nodes' ? 'graphNode' : 'graphRelationship';
              if (
                record.version !== 1 ||
                Object.keys(record).length !== 2 ||
                !Object.hasOwn(record, key)
              ) {
                fail('invalid graph envelope');
              }
              if (family.name === 'graph-nodes')
                encodeGraphNodeRecord(record[key], MAX_LINE_BYTES - 1);
              else {
                encodeGraphRelationshipRecord(record[key], MAX_LINE_BYTES - 1);
                const relationship = record[key] as GraphRelationship;
                if (
                  relationship.type === 'CALLS' ||
                  (relationship.type === 'ACCESSES' && relationship.reason === 'write')
                ) {
                  fail('resolver-owned graph relationship');
                }
              }
              const id = (record[key] as { id: string }).id;
              const ids = family.name === 'graph-nodes' ? graphNodeIds : graphRelationshipIds;
              if (ids.has(id)) fail(`duplicate ${family.name} id`);
              ids.add(id);
              decoded = record[key];
            }
            if (families) {
              if (family.name === 'calls' && Array.isArray(record.argTypes)) {
                record.argTypes = record.argTypes.map((value) =>
                  value === null ? undefined : value,
                );
              }
              // Each family has passed its strict codec/shape validation above.
              (families[FAMILY_KEYS[family.name as keyof typeof FAMILY_KEYS]] as unknown[]).push(
                decoded,
              );
            }
            pendingBytes = 0;
            start = end + 1;
          }
        }
        if (
          pendingBytes ||
          bytes !== family.bytes ||
          records !== family.recordCount ||
          hash.digest('hex') !== family.sha256
        )
          fail('family integrity mismatch');
        if (!sameStat(stat, await file.stat())) fail('family changed');
        check();
        observed.push({ filePath, stat });
      } finally {
        await file.close();
      }
    }
    if (retention.status === 'retained') {
      for (const filePath of auxiliaryPaths) {
        if (!retainedInventoryPaths.has(filePath)) fail('auxiliary record file not retained');
      }
      if (
        parsedFilePaths.size !== retention.inventory.length ||
        retainedInventoryCount !== retention.inventory.length
      ) {
        fail('retained inventory mismatch');
      }
    } else if (completion['parsed-files']) {
      if (
        parsedFilePaths.size < retainedInventoryCount ||
        parsedFilePaths.size > retention.inventory.length
      ) {
        fail('completed parsed files inventory mismatch');
      }
      for (const filePath of retainedInventoryPaths) {
        if (!parsedFilePaths.has(filePath)) fail('completed parsed files inventory mismatch');
      }
    }
    if (totalBytes !== manifest.totalBytes || totalRecords !== manifest.totalRecordCount) {
      fail('observed totals mismatch');
    }
    for (const { filePath, stat } of observed) {
      check();
      const current = await fs.lstat(filePath);
      check();
      if (!current.isFile() || current.isSymbolicLink() || !sameStat(stat, current))
        fail('family changed');
    }
    if (!manifestBytes.equals(await readManifest())) fail('manifest changed');
    const finalDirectoryStat = await fs.lstat(directory);
    check();
    if (
      !finalDirectoryStat.isDirectory() ||
      finalDirectoryStat.isSymbolicLink() ||
      !sameStat(directoryStat, finalDirectoryStat)
    )
      fail('directory changed');
    return { manifest, families };
  } finally {
    await scratch?.dispose();
  }
}
