import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { GraphNode, GraphRelationship, ParsedFile, Range } from 'ontoindex-shared';
import type {
  ExtractedAssignment,
  ExtractedCall,
  ExtractedORMQuery,
  ExtractedFetchCall,
  ExtractedRoute,
  ExtractedDecoratorRoute,
  ExtractedToolDef,
  FileConstructorBindings,
} from '../workers/parse-types.js';
import type { ExtractedHeritage } from '../model/heritage-map.js';
import type { SemanticModelRegistrationEvent } from '../model/semantic-model.js';
import {
  snapshotImportResolutionState,
  type ImportResolutionStateSnapshotV1,
} from '../model/resolution-context.js';
import type { ImportConfigObservations } from '../language-config.js';
import {
  isUnconsumedRustScopeFailure,
  type ScopeExtractionRecord,
} from '../scope-extractor-bridge.js';
import { getLanguageFromFilename, SupportedLanguages } from 'ontoindex-shared';
import type { ScannedFile } from '../filesystem-walker.js';
import { ANALYSIS_PACKS_ROOT } from '../../../analysis-packs/catalog.js';
import {
  decodeParsedFileRecord,
  MAX_PARSED_FILE_RECORD_BYTES,
  MAX_GRAPH_RECORD_BYTES,
  encodeParsedFileRecord,
  encodeGraphNodeRecord,
  encodeGraphRelationshipRecord,
  ParsedFileRecordError,
} from './parse-scope-codec.js';

export interface ScopeRetentionRequest {
  deadline: number;
  signal?: AbortSignal;
  artifactAllowance: { remainingBytes: number };
}
export interface RetainedExportedType {
  filePath: string;
  exportName: string;
  typeName: string;
}
export interface RetainedFileBinding {
  filePath: string;
  varName: string;
  typeName: string;
}
export interface ScopeRetentionDiscovery {
  allPaths: readonly string[];
  scanned: readonly Readonly<{ path: string; language: SupportedLanguages | null }>[];
  skipped: readonly Readonly<{ path: string; size: number }>[];
}

/** Pack contents affect parser producers but are outside retained input evidence. */
export async function scopeRetentionAnalysisPacksAbsent(
  repoPath: string,
  check: () => void,
): Promise<boolean> {
  check();
  try {
    await fs.lstat(path.join(repoPath, ANALYSIS_PACKS_ROOT));
    check();
    return false;
  } catch (error) {
    check();
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Canonical discovery identity, independently bounded from parser artifacts. */
export function snapshotScopeRetentionDiscovery(
  allPaths: readonly string[],
  scannedFiles: readonly ScannedFile[],
  skippedFiles: readonly { path: string; size: number }[],
  check: () => void,
  maxRecords = 100_000,
  maxBytes = 8 * 1024 * 1024,
): ScopeRetentionDiscovery {
  check();
  if (allPaths.length + scannedFiles.length + skippedFiles.length > maxRecords) {
    throw new Error('discovery count limit');
  }
  let bytes = 0;
  let records = 0;
  const paths = new Set<string>();
  const validate = (value: string, seen: Set<string>) => {
    check();
    if (
      ++records > maxRecords ||
      typeof value !== 'string' ||
      !value ||
      value.length > maxBytes ||
      path.isAbsolute(value) ||
      path.win32.isAbsolute(value) ||
      /[\\\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(
        value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''),
      ) ||
      value.split('/').some((part) => !part || part === '.' || part === '..') ||
      seen.has(value)
    ) {
      throw new Error('invalid discovery path or count');
    }
    bytes += Buffer.byteLength(value) + 96;
    if (bytes > maxBytes) throw new Error('discovery byte limit');
    seen.add(value);
  };
  for (const value of allPaths) validate(value, paths);
  const scannedPaths = new Set<string>();
  const languages = new Set(Object.values(SupportedLanguages));
  const scanned = scannedFiles.map((file) => {
    validate(file.path, scannedPaths);
    const language = getLanguageFromFilename(file.path) ?? file.shebangLanguage ?? null;
    if (!paths.has(file.path) || (language !== null && !languages.has(language))) {
      throw new Error('invalid discovery scanned domain');
    }
    return Object.freeze({ path: file.path, language });
  });
  if (scannedPaths.size !== paths.size) throw new Error('incomplete discovery scanned domain');
  const skippedPaths = new Set<string>();
  const skipped = skippedFiles.map((file) => {
    validate(file.path, skippedPaths);
    if (scannedPaths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0)
      throw new Error('invalid discovery skipped domain');
    return Object.freeze({ path: file.path, size: file.size });
  });
  const compare = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  check();
  return Object.freeze({
    allPaths: Object.freeze([...paths].sort()),
    scanned: Object.freeze(scanned.sort(compare)),
    skipped: Object.freeze(skipped.sort(compare)),
  });
}
const retentionFamilies = [
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
export type ScopeRetentionFamily = (typeof retentionFamilies)[number];
export interface ScopeRetentionHandle {
  readonly status: 'retained' | 'incomplete';
  readonly seedReady: false;
  /** Successful observed producers, including empty output; never full language coverage. */
  readonly producerCompletion: Readonly<Record<ScopeRetentionFamily, boolean>>;
  readonly evidenceScope: 'observed-inventory';
  readonly reasons: readonly string[];
  readonly inventory: readonly { filePath: string; status: string; reason?: string }[];
  readonly discovery: ScopeRetentionDiscovery | null;
  readonly bytes: number;
  readonly recordCount: number;
  /** Worker inputs and provider-extracted sequential calls; legacy fallbacks are not complete. */
  readonly callEvidenceScope: 'observed-parser-inputs';
  readonly callRecordCount: number;
  readonly heritageEvidenceScope: 'observed-parser-inputs';
  readonly heritageRecordCount: number;
  readonly assignmentEvidenceScope: 'observed-parser-inputs';
  readonly assignmentRecordCount: number;
  readonly ormQueryEvidenceScope: 'observed-parser-inputs';
  readonly ormQueryRecordCount: number;
  readonly fetchCallRecordCount: number;
  readonly routeRecordCount: number;
  readonly decoratorRouteRecordCount: number;
  readonly toolDefinitionRecordCount: number;
  readonly constructorBindingEvidenceScope: 'observed-parser-inputs';
  readonly constructorBindingRecordCount: number;
  readonly exportedTypeEvidenceScope: 'observed-resolution-inputs';
  readonly exportedTypeRecordCount: number;
  readonly fileBindingEvidenceScope: 'observed-resolution-inputs';
  readonly fileBindingRecordCount: number;
  readonly modelRegistrationEvidenceScope: 'observed-registration-inputs';
  readonly modelRegistrationRecordCount: number;
  readonly importStateEvidenceScope: 'observed-resolution-inputs';
  readonly importStateRecordCount: number;
  readonly graphNodeEvidenceScope: 'observed-parse-graph';
  readonly graphNodeRecordCount: number;
  readonly graphNodesCaptured: boolean;
  readonly graphRelationshipEvidenceScope: 'observed-parse-structural-graph';
  readonly graphRelationshipRecordCount: number;
  readonly graphRelationshipsCaptured: boolean;
  readonly inputEvidence: Readonly<{
    domain: 'parser-text-utf8';
    complete: boolean;
    configuration: ImportConfigObservations | null;
    /** Bounded code evidence; source/configuration completeness does not establish a seed. */
    parserCodeIdentity: string | null;
    sources: readonly Readonly<{ filePath: string; sha256: string; byteLength: number }>[];
    reasons: readonly string[];
  }>;
  iterate(): AsyncIterable<readonly ParsedFile[]>;
  iterateCalls(): AsyncIterable<readonly ExtractedCall[]>;
  iterateHeritage(): AsyncIterable<readonly ExtractedHeritage[]>;
  iterateAssignments(): AsyncIterable<readonly ExtractedAssignment[]>;
  iterateORMQueries(): AsyncIterable<readonly ExtractedORMQuery[]>;
  iterateFetchCalls(): AsyncIterable<readonly ExtractedFetchCall[]>;
  iterateRoutes(): AsyncIterable<readonly ExtractedRoute[]>;
  iterateDecoratorRoutes(): AsyncIterable<readonly ExtractedDecoratorRoute[]>;
  iterateToolDefinitions(): AsyncIterable<readonly ExtractedToolDef[]>;
  iterateConstructorBindings(): AsyncIterable<readonly FileConstructorBindings[]>;
  iterateExportedTypes(): AsyncIterable<readonly RetainedExportedType[]>;
  iterateFileBindings(): AsyncIterable<readonly RetainedFileBinding[]>;
  iterateModelRegistrations(): AsyncIterable<readonly SemanticModelRegistrationEvent[]>;
  iterateImportStates(): AsyncIterable<readonly ImportResolutionStateSnapshotV1[]>;
  iterateGraphNodes(): AsyncIterable<readonly GraphNode[]>;
  iterateGraphRelationships(): AsyncIterable<readonly GraphRelationship[]>;
  dispose(): Promise<void>;
}
const ceilings = {
  maxBytes: 64 * 1024 * 1024,
  maxRecords: 100_000,
  maxRecordBytes: MAX_PARSED_FILE_RECORD_BYTES,
  readChunkBytes: 1024 * 1024,
  batchBytes: 1024 * 1024,
  batchRecords: 1000,
};

/** Parse-owned, opt-in transient store. Retained observed inputs are never a complete seed. */
export class ScopeRetentionStage implements ScopeRetentionHandle {
  readonly seedReady = false;
  readonly evidenceScope = 'observed-inventory';
  readonly callEvidenceScope = 'observed-parser-inputs';
  readonly heritageEvidenceScope = 'observed-parser-inputs';
  readonly assignmentEvidenceScope = 'observed-parser-inputs';
  readonly ormQueryEvidenceScope = 'observed-parser-inputs';
  readonly constructorBindingEvidenceScope = 'observed-parser-inputs';
  readonly exportedTypeEvidenceScope = 'observed-resolution-inputs';
  readonly fileBindingEvidenceScope = 'observed-resolution-inputs';
  readonly modelRegistrationEvidenceScope = 'observed-registration-inputs';
  readonly importStateEvidenceScope = 'observed-resolution-inputs';
  readonly graphNodeEvidenceScope = 'observed-parse-graph';
  readonly graphRelationshipEvidenceScope = 'observed-parse-structural-graph';
  private readonly limits: typeof ceilings;
  private readonly issues = new Set<string>();
  private readonly completedProducers = new Set<ScopeRetentionFamily>();
  private readonly entries = new Map<
    string,
    { artifact: boolean; outcome?: string; skipped?: boolean; expected?: boolean; reason?: string }
  >();
  private inventoryBytes = 0;
  private discoverySnapshot: ScopeRetentionDiscovery | null = null;
  private inputBytes = 0;
  private configuration: ImportConfigObservations | null = null;
  private parserCodeIdentity: string | null = null;
  private readonly sources = new Map<
    string,
    Readonly<{ filePath: string; sha256: string; byteLength: number }>
  >();
  private readonly inputIssues = new Set<string>();
  private queued: string[] = [];
  private directory?: string;
  private filePath?: string;
  private pending: Promise<void> = Promise.resolve();
  private disposing?: Promise<void>;
  private disposed = false;
  private retainedBytes = 0;
  private retainedRecords = 0;
  private reservedParsedFiles = 0;
  // Bounded in-memory observed inputs until a streaming seed owner exists.
  private callRecords: string[] = [];
  private callBytes = 0;
  private callCaptureAttempts = 0;
  private heritageRecords: string[] = [];
  private heritageBytes = 0;
  private heritageCaptureAttempts = 0;
  private assignmentRecords: string[] = [];
  private assignmentBytes = 0;
  private assignmentCaptureAttempts = 0;
  private ormQueryRecords: string[] = [];
  private ormQueryBytes = 0;
  private ormQueryCaptureAttempts = 0;
  private readonly extractionRecords = {
    'fetch-calls': [] as string[],
    routes: [] as string[],
    'decorator-routes': [] as string[],
    'tool-definitions': [] as string[],
  };
  private readonly extractionAttempts = {
    'fetch-calls': 0,
    routes: 0,
    'decorator-routes': 0,
    'tool-definitions': 0,
  };
  private extractionBytes = 0;
  private constructorBindingRecords: string[] = [];
  private constructorBindingBytes = 0;
  private constructorBindingCaptureAttempts = 0;
  private constructorBindingWrapperAttempts = 0;
  private exportedTypeRecords: string[] = [];
  private exportedTypeBytes = 0;
  private exportedTypeCaptureAttempts = 0;
  private fileBindingRecords: string[] = [];
  private fileBindingBytes = 0;
  private fileBindingCaptureAttempts = 0;
  private modelRegistrationRecords: string[] = [];
  private modelRegistrationBytes = 0;
  private modelRegistrationCaptureAttempts = 0;
  private importStateRecord?: string;
  private importStateBytes = 0;
  private importStateCaptureAttempted = false;
  private graphNodeRecords: string[] = [];
  private graphNodeBytes = 0;
  private graphNodeCaptureAttempts = 0;
  private graphRelationshipRecords: string[] = [];
  private graphRelationshipBytes = 0;
  private graphRelationshipCaptureAttempts = 0;
  private captureAttempts = 0;
  private reconciled = false;
  private replayActive = false;
  private pendingReader?: Promise<FileHandle | undefined>;
  private readers = new Set<FileHandle>();
  private closingReaders = new Map<FileHandle, Promise<void>>();

  constructor(
    private readonly request: ScopeRetentionRequest,
    limits: Partial<typeof ceilings> = {},
  ) {
    this.limits = { ...ceilings };
    for (const key of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
      const value = limits[key] ?? ceilings[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key])
        throw new Error('Invalid scope retention limit');
      this.limits[key] = value;
    }
    if (
      !Number.isFinite(request.deadline) ||
      !Number.isSafeInteger(request.artifactAllowance.remainingBytes) ||
      request.artifactAllowance.remainingBytes < 0
    )
      throw new Error('Invalid scope retention request');
  }
  reserveParsedFileRecords(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid parsed-file record reservation');
    this.reservedParsedFiles = Math.min(count, this.limits.maxRecords);
  }
  private get totalRetainedRecords(): number {
    return (
      this.retainedRecords +
      this.callRecords.length +
      this.heritageRecords.length +
      this.assignmentRecords.length +
      this.ormQueryRecords.length +
      this.constructorBindingRecords.length +
      this.exportedTypeRecords.length +
      this.fileBindingRecords.length +
      this.modelRegistrationRecords.length +
      this.importStateRecordCount +
      this.graphNodeRecords.length +
      this.graphRelationshipRecords.length +
      this.fetchCallRecordCount +
      this.routeRecordCount +
      this.decoratorRouteRecordCount +
      this.toolDefinitionRecordCount
    );
  }
  private recordCeilingReached(forParsedFiles: boolean): boolean {
    const ceiling = forParsedFiles
      ? this.limits.maxRecords
      : this.limits.maxRecords - Math.max(0, this.reservedParsedFiles - this.retainedRecords);
    return this.totalRetainedRecords >= ceiling;
  }
  get bytes(): number {
    return this.retainedBytes;
  }
  get recordCount(): number {
    return this.retainedRecords;
  }
  get callRecordCount(): number {
    return this.callRecords.length;
  }
  get heritageRecordCount(): number {
    return this.heritageRecords.length;
  }
  get assignmentRecordCount(): number {
    return this.assignmentRecords.length;
  }
  get ormQueryRecordCount(): number {
    return this.ormQueryRecords.length;
  }
  get fetchCallRecordCount(): number {
    return this.extractionRecords['fetch-calls'].length;
  }
  get routeRecordCount(): number {
    return this.extractionRecords.routes.length;
  }
  get decoratorRouteRecordCount(): number {
    return this.extractionRecords['decorator-routes'].length;
  }
  get toolDefinitionRecordCount(): number {
    return this.extractionRecords['tool-definitions'].length;
  }
  get constructorBindingRecordCount(): number {
    return this.constructorBindingRecords.length;
  }
  get exportedTypeRecordCount(): number {
    return this.exportedTypeRecords.length;
  }
  get fileBindingRecordCount(): number {
    return this.fileBindingRecords.length;
  }
  get modelRegistrationRecordCount(): number {
    return this.modelRegistrationRecords.length;
  }
  get importStateRecordCount(): number {
    return this.importStateRecord === undefined ? 0 : 1;
  }
  get graphNodeRecordCount(): number {
    return this.graphNodeRecords.length;
  }
  get graphNodesCaptured(): boolean {
    return this.producerCompletion['graph-nodes'];
  }
  get graphRelationshipRecordCount(): number {
    return this.graphRelationshipRecords.length;
  }
  get graphRelationshipsCaptured(): boolean {
    return this.producerCompletion['graph-relationships'];
  }
  get producerCompletion(): Readonly<Record<ScopeRetentionFamily, boolean>> {
    const clean = this.check() && this.issues.size === 0 && this.inputIssues.size === 0;
    return Object.freeze(
      Object.fromEntries(
        retentionFamilies.map((family) => [family, clean && this.completedProducers.has(family)]),
      ) as Record<ScopeRetentionFamily, boolean>,
    );
  }
  markProducerCompleted(family: ScopeRetentionFamily): void {
    if (this.check() && this.issues.size === 0 && this.inputIssues.size === 0)
      this.completedProducers.add(family);
  }
  markProducerIncomplete(family: ScopeRetentionFamily): void {
    this.completedProducers.delete(family);
    this.issue(`${family}-producer-incomplete`);
  }
  get inputEvidence(): ScopeRetentionHandle['inputEvidence'] {
    const reasons = new Set(this.inputIssues);
    if (this.status !== 'retained') reasons.add('artifact-incomplete');
    if (!this.configuration?.complete) reasons.add('configuration-incomplete');
    if (!this.discoverySnapshot) reasons.add('discovery-incomplete');
    for (const [filePath, entry] of this.entries) {
      if (entry.expected && !this.sources.has(filePath)) reasons.add('missing-source');
    }
    if (this.reconciled)
      for (const filePath of this.sources.keys()) {
        if (!this.entries.get(filePath)?.expected) reasons.add('unexpected-source');
      }
    return Object.freeze({
      domain: 'parser-text-utf8',
      complete: reasons.size === 0,
      configuration: this.configuration,
      parserCodeIdentity: this.parserCodeIdentity,
      sources: Object.freeze([...this.sources.values()]),
      reasons: Object.freeze([...reasons]),
    });
  }
  get discovery(): ScopeRetentionDiscovery | null {
    return this.discoverySnapshot;
  }
  async captureAnalysisPacksAbsence(repoPath: string): Promise<void> {
    if (!this.check()) return;
    const absent = await scopeRetentionAnalysisPacksAbsent(repoPath, () => {
      if (!this.check()) throw new Error('scope-retention: unavailable');
    }).catch(() => false);
    if (!this.check()) return;
    if (!absent) this.inputIssue('unsupported-analysis-packs');
  }
  captureDiscovery(
    allPaths: readonly string[],
    scanned: readonly ScannedFile[],
    skipped: readonly { path: string; size: number }[],
  ): void {
    if (!this.check()) return;
    try {
      const snapshot = snapshotScopeRetentionDiscovery(
        allPaths,
        scanned,
        skipped,
        () => {
          if (!this.check()) throw new Error('discovery unavailable');
        },
        this.limits.maxRecords,
        Math.min(this.limits.maxBytes, 8 * 1024 * 1024),
      );
      if (this.discoverySnapshot) {
        if (JSON.stringify(snapshot) !== JSON.stringify(this.discoverySnapshot))
          this.inputIssue('discovery-conflict');
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      if (!this.inputRoom(bytes)) {
        this.inputIssue('input-byte-limit');
        return;
      }
      this.discoverySnapshot = snapshot;
      this.inputBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    } catch {
      this.inputIssue('discovery-invalid');
    }
  }
  private inputIssue(reason: string): void {
    if (this.inputIssues.size < 100) this.inputIssues.add(reason);
  }
  private inputRoom(bytes: number): boolean {
    return (
      bytes <= this.request.artifactAllowance.remainingBytes &&
      this.retainedBytes + this.inputBytes + bytes <= this.limits.maxBytes
    );
  }
  captureParserCodeIdentity(value: unknown): void {
    if (!this.check()) return;
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
      this.inputIssue('parser-code-identity-invalid');
      return;
    }
    if (this.parserCodeIdentity !== null) {
      if (this.parserCodeIdentity !== value) this.inputIssue('parser-code-identity-conflict');
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify({ parserCodeIdentity: value }), 'utf8');
    if (!this.inputRoom(bytes)) {
      this.inputIssue('input-byte-limit');
      return;
    }
    this.parserCodeIdentity = value;
    this.inputBytes += bytes;
    this.request.artifactAllowance.remainingBytes -= bytes;
  }
  markParserCodeIdentityUnavailable(): void {
    if (!this.check()) return;
    this.inputIssue('parser-code-identity-unavailable');
  }
  captureParserInputs(files: readonly { path: string; content: string }[]): void {
    let count = 0;
    for (const file of files) {
      if (!this.check()) return;
      if (
        ++count > this.limits.maxRecords ||
        typeof file.path !== 'string' ||
        typeof file.content !== 'string' ||
        Buffer.byteLength(file.path) > this.limits.maxRecordBytes
      ) {
        this.inputIssue('source-limit');
        return;
      }
      // UTF-8 replaces unpaired surrogates, so they cannot identify exact parser text.
      const unpairedSurrogate =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      if (unpairedSurrogate.test(file.content) || unpairedSurrogate.test(file.path)) {
        this.inputIssue('source-invalid-utf8');
        continue;
      }
      const sha256 = createHash('sha256').update(file.content, 'utf8').digest('hex');
      const byteLength = Buffer.byteLength(file.content, 'utf8');
      const previous = this.sources.get(file.path);
      if (previous) {
        if (previous.sha256 !== sha256 || previous.byteLength !== byteLength)
          this.inputIssue('source-conflict');
        continue;
      }
      if (this.sources.size >= this.limits.maxRecords) {
        this.inputIssue('source-limit');
        return;
      }
      const source = { filePath: file.path, sha256, byteLength };
      const bytes = Buffer.byteLength(JSON.stringify(source), 'utf8');
      if (!this.inputRoom(bytes)) {
        this.inputIssue('input-byte-limit');
        return;
      }
      this.sources.set(file.path, Object.freeze(source));
      this.inputBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    }
  }
  captureConfigObservations(observations: ImportConfigObservations | undefined): void {
    if (!this.check()) return;
    if (!observations) {
      this.inputIssue('configuration-missing');
      return;
    }
    const budget = Math.min(
      1024 * 1024,
      this.request.artifactAllowance.remainingBytes,
      this.limits.maxBytes - this.retainedBytes - this.inputBytes,
    );
    // Bound the metadata tree before constructing its detached copy or serialized digest input.
    let bytes = 0;
    let nodes = 0;
    const measure = (value: unknown, depth: number): boolean => {
      if (++nodes > 100_000 || depth > 6 || bytes > budget) return false;
      if (typeof value === 'string') {
        if (Buffer.byteLength(value, 'utf8') > budget) return false;
        bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      } else if (
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isSafeInteger(value))
      ) {
        bytes += String(value).length;
      } else if (Array.isArray(value)) {
        if (value.length > 10_000) return false;
        bytes += 2 + Math.max(0, value.length - 1);
        for (const child of value) if (!measure(child, depth + 1)) return false;
      } else if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length > 12) return false;
        bytes += 2 + Math.max(0, keys.length - 1);
        for (const key of keys) {
          if (!measure(key, depth + 1)) return false;
          bytes++;
          if (!measure((value as Record<string, unknown>)[key], depth + 1)) return false;
        }
      } else return false;
      return bytes <= budget;
    };
    if (!measure(observations, 0)) {
      this.inputIssue('configuration-limit');
      return;
    }
    const digest = /^[a-f0-9]{64}$/;
    const keysAllowed = (value: object, keys: readonly string[]): boolean =>
      Object.keys(value).every((key) => keys.includes(key));
    if (
      !keysAllowed(observations, ['version', 'complete', 'digest', 'records', 'issues']) ||
      observations.version !== 1 ||
      typeof observations.complete !== 'boolean' ||
      !Array.isArray(observations.records) ||
      observations.records.length > 4096 ||
      !Array.isArray(observations.issues) ||
      !observations.issues.every((issue) => typeof issue === 'string') ||
      (observations.digest !== null &&
        (typeof observations.digest !== 'string' || !digest.test(observations.digest)))
    ) {
      this.inputIssue('configuration-invalid');
      return;
    }
    let directoryEntries = 0;
    for (const record of observations.records) {
      if (!record || typeof record.path !== 'string') {
        this.inputIssue('configuration-invalid');
        return;
      }
      const allowed =
        record.kind === 'file'
          ? ['kind', 'path', 'status', 'sha256', 'byteLength', 'errorCode']
          : record.kind === 'directory'
            ? ['kind', 'path', 'status', 'entries', 'errorCode']
            : record.kind === 'traversal'
              ? [
                  'kind',
                  'path',
                  'maxDepth',
                  'maxDirs',
                  'dirsScanned',
                  'depthLimited',
                  'directoryLimited',
                ]
              : ['kind', 'path'];
      if (!keysAllowed(record, allowed)) {
        this.inputIssue('configuration-invalid');
        return;
      }
      if (record.kind === 'file' || record.kind === 'directory') {
        if (
          !['present', 'absent', 'failed'].includes(record.status) ||
          (record.errorCode !== undefined &&
            (typeof record.errorCode !== 'string' ||
              !/^[A-Z][A-Z0-9_]{0,31}$/.test(record.errorCode)))
        ) {
          this.inputIssue('configuration-invalid');
          return;
        }
        if (
          record.kind === 'file' &&
          record.status === 'present' &&
          (typeof record.sha256 !== 'string' ||
            !digest.test(record.sha256) ||
            !Number.isSafeInteger(record.byteLength) ||
            record.byteLength! < 0)
        ) {
          this.inputIssue('configuration-invalid');
          return;
        }
        if (record.kind === 'directory' && record.status === 'present') {
          if (
            !Array.isArray(record.entries) ||
            (directoryEntries += record.entries.length) > 10_000 ||
            !record.entries.every(
              (entry) =>
                entry &&
                keysAllowed(entry, ['name', 'kind']) &&
                typeof entry.name === 'string' &&
                ['file', 'directory', 'symlink', 'other'].includes(entry.kind),
            )
          ) {
            this.inputIssue('configuration-invalid');
            return;
          }
        }
      } else if (record.kind === 'traversal') {
        if (
          record.path !== '.' ||
          record.maxDepth !== 5 ||
          record.maxDirs !== 100 ||
          !Number.isSafeInteger(record.dirsScanned) ||
          record.dirsScanned < 0 ||
          record.dirsScanned > 100 ||
          typeof record.depthLimited !== 'boolean' ||
          typeof record.directoryLimited !== 'boolean'
        ) {
          this.inputIssue('configuration-invalid');
          return;
        }
      } else if (record.kind !== 'parse-error') {
        this.inputIssue('configuration-invalid');
        return;
      }
      if (
        observations.complete &&
        (record.kind === 'parse-error' ||
          ('status' in record && record.status === 'failed') ||
          (record.kind === 'traversal' && (record.depthLimited || record.directoryLimited)))
      ) {
        this.inputIssue('configuration-invalid');
        return;
      }
    }
    if (
      observations.complete &&
      (observations.issues.length !== 0 ||
        observations.digest !==
          createHash('sha256')
            .update(JSON.stringify({ version: 1, records: observations.records }))
            .digest('hex'))
    ) {
      this.inputIssue('configuration-invalid');
      return;
    }
    const encoded = JSON.stringify(observations);
    if (this.configuration) {
      if (JSON.stringify(this.configuration) !== encoded) this.inputIssue('configuration-conflict');
      return;
    }
    if (!this.inputRoom(bytes)) {
      this.inputIssue('input-byte-limit');
      return;
    }
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    const configuration: ImportConfigObservations = JSON.parse(encoded);
    freeze(configuration);
    this.configuration = configuration;
    this.inputBytes += bytes;
    this.request.artifactAllowance.remainingBytes -= bytes;
  }
  get reasons(): readonly string[] {
    return [...this.issues];
  }
  get inventory(): readonly { filePath: string; status: string; reason?: string }[] {
    return Array.from(this.entries, ([filePath, entry]) => ({
      filePath,
      status: this.entryStatus(entry, filePath),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    }));
  }
  get status(): 'retained' | 'incomplete' {
    if (!this.check() || !this.reconciled || !this.entries.size || this.issues.size)
      return 'incomplete';
    for (const [filePath, entry] of this.entries) {
      const status = this.entryStatus(entry, filePath);
      if (status !== 'retained' && status !== 'not-required') return 'incomplete';
    }
    return 'retained';
  }
  private entryStatus(
    entry: { artifact: boolean; outcome?: string; skipped?: boolean; reason?: string },
    filePath: string,
  ): string {
    if (
      !entry.skipped &&
      !entry.artifact &&
      isUnconsumedRustScopeFailure({ filePath, status: entry.outcome, reason: entry.reason })
    )
      return 'not-required';
    return entry.skipped
      ? 'skipped'
      : entry.outcome === undefined
        ? 'missing-outcome'
        : entry.outcome !== 'success'
          ? entry.outcome
          : !entry.artifact
            ? 'missing-artifact'
            : 'retained';
  }
  private issue(reason: string): void {
    if (this.issues.size < 100) this.issues.add(reason);
  }
  private check(): boolean {
    if (this.disposed) {
      this.issue('disposed');
      return false;
    }
    if (this.request.signal?.aborted) {
      this.issue('cancelled');
      return false;
    }
    if (Date.now() >= this.request.deadline) {
      this.issue('deadline');
      return false;
    }
    return true;
  }
  private entry(filePath: unknown) {
    if (typeof filePath !== 'string' || filePath.length > this.limits.maxRecordBytes) {
      this.issue('inventory-limit');
      return;
    }
    const found = this.entries.get(filePath);
    if (found) return found;
    const size = Buffer.byteLength(filePath, 'utf8') + 64;
    if (
      this.entries.size >= this.limits.maxRecords ||
      this.inventoryBytes + size > this.limits.maxBytes
    ) {
      this.issue('inventory-limit');
      return;
    }
    this.inventoryBytes += size;
    const entry: {
      artifact: boolean;
      outcome?: string;
      skipped?: boolean;
      expected?: boolean;
      reason?: string;
    } = {
      artifact: false,
    };
    this.entries.set(filePath, entry);
    return entry;
  }
  capture(files: readonly ParsedFile[]): void {
    this.completedProducers.delete('parsed-files');
    this.reconciled = false;
    for (const file of files) {
      if (!this.check()) return;
      if (++this.captureAttempts > this.limits.maxRecords) {
        this.issue('record-count-limit');
        return;
      }
      if (this.recordCeilingReached(true)) {
        this.issue('record-count-limit');
        return;
      }
      let encoded: string;
      try {
        const available = Math.min(
          this.limits.maxRecordBytes,
          this.limits.batchBytes,
          this.limits.maxBytes - this.retainedBytes - this.inputBytes,
          this.request.artifactAllowance.remainingBytes,
        );
        if (available < 1) {
          this.issue('artifact-byte-limit');
          return;
        }
        encoded = encodeParsedFileRecord(file, available);
      } catch (error) {
        if (!(error instanceof ParsedFileRecordError)) throw error;
        this.issue(error.reason);
        continue;
      }
      const entry = this.entry(file.filePath);
      if (!entry) continue;
      if (entry.artifact) this.issue('duplicate-artifact');
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (!this.inputRoom(bytes)) {
        this.issue('artifact-byte-limit');
        return;
      }
      this.request.artifactAllowance.remainingBytes -= bytes;
      this.retainedBytes += bytes;
      this.retainedRecords++;
      entry.artifact = true;
      this.queued.push(encoded);
    }
  }
  captureCalls(calls: readonly ExtractedCall[]): void {
    this.completedProducers.delete('calls');
    const fields = [
      'filePath',
      'calledName',
      'sourceId',
      'argCount',
      'callForm',
      'receiverName',
      'receiverTypeName',
      'receiverMixedChain',
      'argTypes',
      'atRange',
    ];
    const own = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> => {
      if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value))
        return false;
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        return false;
      const keys = Reflect.ownKeys(value);
      return (
        keys.length <= allowed.length &&
        allowed.every((key) => !(key in value) || Object.hasOwn(value, key)) &&
        keys.every(
          (key) =>
            typeof key === 'string' &&
            allowed.includes(key) &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'),
        )
      );
    };
    const rangeFields = ['startLine', 'startCol', 'endLine', 'endCol'];
    const range = (value: unknown): value is Range => {
      if (
        !own(value, rangeFields) ||
        !rangeFields.every(
          (key) =>
            Object.hasOwn(value, key) &&
            Number.isSafeInteger(value[key]) &&
            !Object.is(value[key], -0),
        )
      )
        return false;
      const { startLine, startCol, endLine, endCol } = value as unknown as Range;
      return (
        startLine >= 1 &&
        endLine >= 1 &&
        startCol >= 0 &&
        endCol >= 0 &&
        (endLine > startLine || (endLine === startLine && endCol > startCol))
      );
    };
    const copyRange = ({ startLine, startCol, endLine, endCol }: Range): Range => ({
      startLine,
      startCol,
      endLine,
      endCol,
    });
    for (const call of calls) {
      if (!this.check()) return;
      if (++this.callCaptureAttempts > this.limits.maxRecords || this.recordCeilingReached(false)) {
        this.issue('call-count-limit');
        return;
      }
      const available = Math.min(
        MAX_GRAPH_RECORD_BYTES,
        this.limits.maxRecordBytes,
        this.limits.batchBytes,
        this.limits.maxBytes - this.retainedBytes - this.inputBytes,
        this.request.artifactAllowance.remainingBytes,
      );
      let stringBytes = 0;
      let byteLimited = false;
      const string = (value: unknown): value is string => {
        if (typeof value !== 'string') return false;
        if (
          value.length > available ||
          (stringBytes += Buffer.byteLength(value, 'utf8')) > available
        ) {
          byteLimited = true;
          return false;
        }
        return true;
      };
      // Arrays must contain only ordinary indexed data, with no accessors or extras.
      const array = (value: unknown, max: number): value is unknown[] => {
        if (
          !Array.isArray(value) ||
          types.isProxy(value) ||
          value.length > max ||
          Object.getPrototypeOf(value) !== Array.prototype
        )
          return false;
        const keys = Reflect.ownKeys(value);
        return (
          keys.length === value.length + 1 &&
          keys.every(
            (key) =>
              key === 'length' ||
              (typeof key === 'string' &&
                /^(0|[1-9]\d*)$/.test(key) &&
                Number(key) < value.length &&
                Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')),
          )
        );
      };
      if (
        !own(call, fields) ||
        !['filePath', 'calledName', 'sourceId'].every(
          (key) => Object.hasOwn(call, key) && string(call[key]),
        ) ||
        !['receiverName', 'receiverTypeName'].every(
          (key) => call[key] === undefined || string(call[key]),
        ) ||
        (call.argCount !== undefined &&
          (!Number.isSafeInteger(call.argCount) || (call.argCount as number) < 0)) ||
        (call.callForm !== undefined &&
          !['free', 'member', 'constructor'].includes(call.callForm as string)) ||
        (call.atRange !== undefined && !range(call.atRange)) ||
        (call.receiverMixedChain !== undefined &&
          (!array(call.receiverMixedChain, 3) ||
            !call.receiverMixedChain.every(
              (step) =>
                own(step, ['kind', 'name', 'atRange']) &&
                Object.hasOwn(step, 'kind') &&
                Object.hasOwn(step, 'name') &&
                (step.kind === 'field'
                  ? !Object.hasOwn(step, 'atRange')
                  : step.kind === 'call' && (step.atRange === undefined || range(step.atRange))) &&
                string(step.name),
            ))) ||
        (call.argTypes !== undefined &&
          (!array(call.argTypes, 1000) ||
            !call.argTypes.every((value) => value === undefined || string(value))))
      ) {
        this.issue(byteLimited ? 'call-byte-limit' : 'call-invalid');
        continue;
      }
      // Copy only validated own data; null is reserved for undefined argTypes slots.
      const detached: Record<string, unknown> = Object.create(null);
      for (const key of fields) if (call[key] !== undefined) detached[key] = call[key];
      if (call.atRange !== undefined) detached.atRange = copyRange(call.atRange as Range);
      if (call.argTypes !== undefined)
        detached.argTypes = (call.argTypes as unknown[]).map((value) => value ?? null);
      if (call.receiverMixedChain !== undefined)
        detached.receiverMixedChain = (
          call.receiverMixedChain as { kind: string; name: string; atRange?: Range }[]
        ).map(({ kind, name, atRange }) =>
          atRange === undefined ? { kind, name } : { kind, name, atRange: copyRange(atRange) },
        );
      const encoded = JSON.stringify(detached);
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > available) {
        this.issue('call-byte-limit');
        continue;
      }
      this.callRecords.push(encoded);
      this.callBytes += bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    }
  }
  captureHeritage(records: readonly ExtractedHeritage[]): void {
    this.completedProducers.delete('heritage');
    const fields = ['filePath', 'className', 'parentName', 'kind'] as const;
    for (const record of records) {
      if (!this.check()) return;
      if (
        ++this.heritageCaptureAttempts > this.limits.maxRecords ||
        this.recordCeilingReached(false)
      ) {
        this.issue('heritage-count-limit');
        return;
      }
      // Reject proxies and accessors before inspecting any values.
      if (
        !record ||
        typeof record !== 'object' ||
        types.isProxy(record) ||
        (Object.getPrototypeOf(record) !== Object.prototype &&
          Object.getPrototypeOf(record) !== null)
      ) {
        this.issue('heritage-invalid');
        continue;
      }
      const keys = Reflect.ownKeys(record);
      if (
        keys.length !== fields.length ||
        !keys.every(
          (key) =>
            typeof key === 'string' &&
            fields.includes(key as (typeof fields)[number]) &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, 'value'),
        )
      ) {
        this.issue('heritage-invalid');
        continue;
      }
      const available = Math.min(
        MAX_GRAPH_RECORD_BYTES,
        this.limits.maxRecordBytes,
        this.limits.batchBytes,
        this.limits.maxBytes - this.retainedBytes - this.inputBytes,
        this.request.artifactAllowance.remainingBytes,
      );
      let stringBytes = 0;
      let byteLimited = false;
      if (
        !fields.every((field) => {
          const value = record[field];
          if (typeof value !== 'string') return false;
          if (
            value.length > available ||
            (stringBytes += Buffer.byteLength(value, 'utf8')) > available
          ) {
            byteLimited = true;
            return false;
          }
          return true;
        })
      ) {
        this.issue(byteLimited ? 'heritage-byte-limit' : 'heritage-invalid');
        continue;
      }
      // Serialize only the bounded own strings, preserving provider-defined kinds.
      const encoded = JSON.stringify({
        filePath: record.filePath,
        className: record.className,
        parentName: record.parentName,
        kind: record.kind,
      });
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > available) {
        this.issue('heritage-byte-limit');
        continue;
      }
      this.heritageRecords.push(encoded);
      this.heritageBytes += bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    }
  }
  captureAssignments(records: readonly ExtractedAssignment[]): void {
    this.completedProducers.delete('assignments');
    const required = ['filePath', 'sourceId', 'receiverText', 'propertyName'] as const;
    const fields = [...required, 'receiverTypeName'];
    for (const record of records) {
      if (!this.check()) return;
      if (
        ++this.assignmentCaptureAttempts > this.limits.maxRecords ||
        this.recordCeilingReached(false)
      ) {
        this.issue('assignment-count-limit');
        return;
      }
      // Inspect descriptors before reading values so hostile records cannot execute code.
      if (
        !record ||
        typeof record !== 'object' ||
        types.isProxy(record) ||
        (Object.getPrototypeOf(record) !== Object.prototype &&
          Object.getPrototypeOf(record) !== null)
      ) {
        this.issue('assignment-invalid');
        continue;
      }
      const keys = Reflect.ownKeys(record);
      if (
        keys.length > fields.length ||
        !required.every((key) => Object.hasOwn(record, key)) ||
        ('receiverTypeName' in record && !Object.hasOwn(record, 'receiverTypeName')) ||
        !keys.every(
          (key) =>
            typeof key === 'string' &&
            fields.includes(key) &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, 'value'),
        )
      ) {
        this.issue('assignment-invalid');
        continue;
      }
      const available = Math.min(
        MAX_GRAPH_RECORD_BYTES,
        this.limits.maxRecordBytes,
        this.limits.batchBytes,
        this.limits.maxBytes - this.retainedBytes - this.inputBytes,
        this.request.artifactAllowance.remainingBytes,
      );
      let stringBytes = 0;
      let byteLimited = false;
      const receiverTypeName = Object.getOwnPropertyDescriptor(record, 'receiverTypeName')?.value;
      const string = (value: unknown): boolean => {
        if (typeof value !== 'string') return false;
        if (
          value.length > available ||
          (stringBytes += Buffer.byteLength(value, 'utf8')) > available
        ) {
          byteLimited = true;
          return false;
        }
        return true;
      };
      if (
        !required.every((key) => string(record[key])) ||
        (receiverTypeName !== undefined && !string(receiverTypeName))
      ) {
        this.issue(byteLimited ? 'assignment-byte-limit' : 'assignment-invalid');
        continue;
      }
      const detached: ExtractedAssignment = {
        filePath: record.filePath,
        sourceId: record.sourceId,
        receiverText: record.receiverText,
        propertyName: record.propertyName,
      };
      if (receiverTypeName !== undefined) detached.receiverTypeName = receiverTypeName;
      const encoded = JSON.stringify(detached);
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > available) {
        this.issue('assignment-byte-limit');
        continue;
      }
      this.assignmentRecords.push(encoded);
      this.assignmentBytes += bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    }
  }
  captureFetchCalls(records: readonly ExtractedFetchCall[]): void {
    this.captureExtractions('fetch-calls', records, ['fetchURL']);
  }
  captureRoutes(records: readonly ExtractedRoute[]): void {
    this.captureExtractions(
      'routes',
      records,
      ['httpMethod'],
      ['routePath', 'controllerName', 'methodName', 'prefix'],
      true,
    );
  }
  captureDecoratorRoutes(records: readonly ExtractedDecoratorRoute[]): void {
    this.captureExtractions(
      'decorator-routes',
      records,
      ['httpMethod', 'decoratorName'],
      ['routePath'],
    );
  }
  captureToolDefinitions(records: readonly ExtractedToolDef[]): void {
    this.captureExtractions('tool-definitions', records, ['toolName', 'description']);
  }
  private captureExtractions(
    family: keyof ScopeRetentionStage['extractionRecords'],
    records: readonly (
      | ExtractedFetchCall
      | ExtractedRoute
      | ExtractedDecoratorRoute
      | ExtractedToolDef
    )[],
    strings: readonly string[],
    nullable: readonly string[] = [],
    middleware = false,
  ): void {
    this.completedProducers.delete(family);
    const fields = [
      'filePath',
      'lineNumber',
      ...strings,
      ...nullable,
      ...(middleware ? ['middleware'] : []),
    ];
    const optionalArrays =
      family === 'routes' || family === 'decorator-routes' ? ['responseKeys', 'errorKeys'] : [];
    for (const record of records) {
      if (!this.check()) return;
      if (
        ++this.extractionAttempts[family] > this.limits.maxRecords ||
        this.recordCeilingReached(false)
      ) {
        this.issue(`${family}-count-limit`);
        return;
      }
      if (
        !record ||
        typeof record !== 'object' ||
        types.isProxy(record) ||
        (Object.getPrototypeOf(record) !== Object.prototype &&
          Object.getPrototypeOf(record) !== null)
      ) {
        this.issue(`${family}-invalid`);
        continue;
      }
      const keys = Reflect.ownKeys(record);
      if (
        !fields.every((field) => keys.includes(field)) ||
        !keys.every(
          (key) =>
            typeof key === 'string' &&
            (fields.includes(key) || optionalArrays.includes(key)) &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, 'value'),
        )
      ) {
        this.issue(`${family}-invalid`);
        continue;
      }
      const value = record as unknown as Record<string, unknown>;
      const available = Math.min(
        MAX_GRAPH_RECORD_BYTES,
        this.limits.maxRecordBytes,
        this.limits.batchBytes,
        this.limits.maxBytes - this.retainedBytes - this.inputBytes,
        this.request.artifactAllowance.remainingBytes,
      );
      let stringBytes = 0;
      let byteLimited = false;
      const validString = (text: unknown): boolean => {
        if (typeof text !== 'string') return false;
        if (
          text.length > available ||
          (stringBytes += Buffer.byteLength(text, 'utf8')) > available
        ) {
          byteLimited = true;
          return false;
        }
        return true;
      };
      let validArrays = true;
      const copiedArrays = new Map<string, string[]>();
      for (const field of [...(middleware ? ['middleware'] : []), ...optionalArrays]) {
        if (!Object.hasOwn(value, field)) continue;
        const items = value[field];
        let validArray =
          Array.isArray(items) &&
          !types.isProxy(items) &&
          Object.getPrototypeOf(items) === Array.prototype;
        const copy: string[] = [];
        if (validArray) {
          const array = items as unknown[];
          const length = Object.getOwnPropertyDescriptor(array, 'length')?.value;
          validArray =
            Number.isSafeInteger(length) &&
            length <= available &&
            Reflect.ownKeys(array).length === length + 1;
          for (let i = 0; validArray && i < length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(array, String(i));
            validArray =
              !!descriptor && Object.hasOwn(descriptor, 'value') && validString(descriptor.value);
            if (validArray) copy.push(descriptor!.value as string);
          }
        }
        validArrays &&= validArray;
        copiedArrays.set(field, copy);
      }
      if (
        !['filePath', ...strings].every((field) => validString(value[field])) ||
        !nullable.every((field) => value[field] === null || validString(value[field])) ||
        !Number.isSafeInteger(record.lineNumber) ||
        record.lineNumber < 0 ||
        !validArrays
      ) {
        this.issue(`${family}-${byteLimited ? 'byte-limit' : 'invalid'}`);
        continue;
      }
      const copy = Object.fromEntries(
        [...fields, ...optionalArrays.filter((field) => Object.hasOwn(value, field))].map(
          (field) => [field, copiedArrays.get(field) ?? value[field]],
        ),
      );
      const encoded = JSON.stringify(copy);
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > available) {
        this.issue(`${family}-byte-limit`);
        continue;
      }
      this.extractionRecords[family].push(encoded);
      this.extractionBytes += bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    }
  }
  iterateFetchCalls(): AsyncIterable<readonly ExtractedFetchCall[]> {
    return this.iterateExtractions<ExtractedFetchCall>('fetch-calls');
  }
  iterateRoutes(): AsyncIterable<readonly ExtractedRoute[]> {
    return this.iterateExtractions<ExtractedRoute>('routes');
  }
  iterateDecoratorRoutes(): AsyncIterable<readonly ExtractedDecoratorRoute[]> {
    return this.iterateExtractions<ExtractedDecoratorRoute>('decorator-routes');
  }
  iterateToolDefinitions(): AsyncIterable<readonly ExtractedToolDef[]> {
    return this.iterateExtractions<ExtractedToolDef>('tool-definitions');
  }
  private async *iterateExtractions<T>(
    family: keyof ScopeRetentionStage['extractionRecords'],
  ): AsyncIterable<readonly T[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: T[] = [];
      let bytes = 0;
      for (const encoded of this.extractionRecords[family]) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded) as T);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  captureORMQueries(records: readonly ExtractedORMQuery[]): void {
    this.completedProducers.delete('orm-queries');
    const strings = ['filePath', 'orm', 'model', 'method'] as const;
    const fields = [...strings, 'lineNumber'];
    for (const record of records) {
      if (!this.check()) return;
      if (
        ++this.ormQueryCaptureAttempts > this.limits.maxRecords ||
        this.recordCeilingReached(false)
      ) {
        this.issue('orm-query-count-limit');
        return;
      }
      // Reject proxies and accessor descriptors before reading any record values.
      if (
        !record ||
        typeof record !== 'object' ||
        types.isProxy(record) ||
        (Object.getPrototypeOf(record) !== Object.prototype &&
          Object.getPrototypeOf(record) !== null)
      ) {
        this.issue('orm-query-invalid');
        continue;
      }
      const keys = Reflect.ownKeys(record);
      if (
        keys.length !== fields.length ||
        !keys.every(
          (key) =>
            typeof key === 'string' &&
            fields.includes(key) &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, 'value'),
        )
      ) {
        this.issue('orm-query-invalid');
        continue;
      }
      const available = Math.min(
        MAX_GRAPH_RECORD_BYTES,
        this.limits.maxRecordBytes,
        this.limits.batchBytes,
        this.limits.maxBytes - this.retainedBytes - this.inputBytes,
        this.request.artifactAllowance.remainingBytes,
      );
      let stringBytes = 0;
      let byteLimited = false;
      if (
        !strings.every((field) => {
          const value = record[field];
          if (typeof value !== 'string') return false;
          if (
            value.length > available ||
            (stringBytes += Buffer.byteLength(value, 'utf8')) > available
          ) {
            byteLimited = true;
            return false;
          }
          return true;
        }) ||
        (record.orm !== 'prisma' && record.orm !== 'supabase') ||
        !Number.isSafeInteger(record.lineNumber) ||
        record.lineNumber < 0
      ) {
        this.issue(byteLimited ? 'orm-query-byte-limit' : 'orm-query-invalid');
        continue;
      }
      const encoded = JSON.stringify({
        filePath: record.filePath,
        orm: record.orm,
        model: record.model,
        method: record.method,
        lineNumber: record.lineNumber,
      });
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > available) {
        this.issue('orm-query-byte-limit');
        continue;
      }
      this.ormQueryRecords.push(encoded);
      this.ormQueryBytes += bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    }
  }
  captureConstructorBindings(records: readonly FileConstructorBindings[]): void {
    this.completedProducers.delete('constructor-bindings');
    const own = (
      value: unknown,
      fields: readonly string[],
      required: readonly string[],
    ): value is Record<string, unknown> => {
      if (
        !value ||
        typeof value !== 'object' ||
        types.isProxy(value) ||
        Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      )
        return false;
      const keys = Reflect.ownKeys(value);
      return (
        keys.length <= fields.length &&
        required.every((key) => Object.hasOwn(value, key)) &&
        fields.every((key) => !(key in value) || Object.hasOwn(value, key)) &&
        keys.every(
          (key) =>
            typeof key === 'string' &&
            fields.includes(key) &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'),
        )
      );
    };
    const array = (value: unknown): value is unknown[] => {
      if (
        types.isProxy(value) ||
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > this.limits.maxRecords
      )
        return false;
      const keys = Reflect.ownKeys(value);
      return (
        keys.length === value.length + 1 &&
        keys.every(
          (key) =>
            key === 'length' ||
            (typeof key === 'string' &&
              /^(0|[1-9]\d*)$/.test(key) &&
              Number(key) < value.length &&
              Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')),
        )
      );
    };
    if (!this.check()) return;
    if (
      this.constructorBindingWrapperAttempts >= this.limits.maxRecords ||
      this.constructorBindingCaptureAttempts >= this.limits.maxRecords
    ) {
      this.issue('constructor-binding-count-limit');
      return;
    }
    // Validate arrays before iteration to avoid invoking custom iterators or indexed accessors.
    if (!array(records)) {
      if (++this.constructorBindingWrapperAttempts > this.limits.maxRecords)
        this.issue('constructor-binding-count-limit');
      else this.issue('constructor-binding-invalid');
      return;
    }
    for (let index = 0; index < records.length; index++) {
      if (!this.check()) return;
      if (++this.constructorBindingWrapperAttempts > this.limits.maxRecords) {
        this.issue('constructor-binding-count-limit');
        return;
      }
      const record: unknown = records[index];
      if (
        !own(record, ['filePath', 'bindings'], ['filePath', 'bindings']) ||
        typeof record.filePath !== 'string' ||
        !array(record.bindings)
      ) {
        this.issue('constructor-binding-invalid');
        continue;
      }
      for (let bindingIndex = 0; bindingIndex < record.bindings.length; bindingIndex++) {
        if (!this.check()) return;
        if (
          ++this.constructorBindingCaptureAttempts > this.limits.maxRecords ||
          this.recordCeilingReached(false)
        ) {
          this.issue('constructor-binding-count-limit');
          return;
        }
        const binding: unknown = record.bindings[bindingIndex];
        const required = ['scope', 'varName', 'calleeName'] as const;
        if (!own(binding, [...required, 'receiverClassName'], required)) {
          this.issue('constructor-binding-invalid');
          continue;
        }
        const available = Math.min(
          MAX_GRAPH_RECORD_BYTES,
          this.limits.maxRecordBytes,
          this.limits.batchBytes,
          this.limits.maxBytes - this.retainedBytes - this.inputBytes,
          this.request.artifactAllowance.remainingBytes,
        );
        let stringBytes = 0;
        let byteLimited = false;
        const string = (value: unknown): value is string => {
          if (typeof value !== 'string') return false;
          if (
            value.length > available ||
            (stringBytes += Buffer.byteLength(value, 'utf8')) > available
          ) {
            byteLimited = true;
            return false;
          }
          return true;
        };
        if (
          !string(record.filePath) ||
          !required.every((key) => string(binding[key])) ||
          (binding.receiverClassName !== undefined && !string(binding.receiverClassName))
        ) {
          this.issue(
            byteLimited ? 'constructor-binding-byte-limit' : 'constructor-binding-invalid',
          );
          continue;
        }
        const detached: Record<string, unknown> = Object.create(null);
        for (const key of required) detached[key] = binding[key];
        if (binding.receiverClassName !== undefined)
          detached.receiverClassName = binding.receiverClassName;
        const encoded = JSON.stringify({ filePath: record.filePath, bindings: [detached] });
        const bytes = Buffer.byteLength(encoded, 'utf8');
        if (bytes > available) {
          this.issue('constructor-binding-byte-limit');
          continue;
        }
        this.constructorBindingRecords.push(encoded);
        this.constructorBindingBytes += bytes;
        this.retainedBytes += bytes;
        this.request.artifactAllowance.remainingBytes -= bytes;
      }
    }
  }
  captureExportedTypes(records: readonly RetainedExportedType[]): void {
    this.completedProducers.delete('exported-types');
    if (!this.check()) return;
    if (this.exportedTypeCaptureAttempts >= this.limits.maxRecords) {
      this.issue('exported-type-count-limit');
      return;
    }
    // Inspect array shape before reading entries; never call a supplied iterator.
    if (
      types.isProxy(records) ||
      !Array.isArray(records) ||
      Object.getPrototypeOf(records) !== Array.prototype
    ) {
      this.exportedTypeCaptureAttempts++;
      this.issue('exported-type-invalid');
      return;
    }
    if (records.length > this.limits.maxRecords) {
      this.exportedTypeCaptureAttempts = this.limits.maxRecords;
      this.issue('exported-type-count-limit');
      return;
    }
    const keys = Reflect.ownKeys(records);
    if (
      keys.length !== records.length + 1 ||
      !keys.every(
        (key) =>
          key === 'length' ||
          (typeof key === 'string' &&
            /^(0|[1-9]\d*)$/.test(key) &&
            Number(key) < records.length &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(records, key)!, 'value')),
      )
    ) {
      this.exportedTypeCaptureAttempts++;
      this.issue('exported-type-invalid');
      return;
    }
    const fields = ['filePath', 'exportName', 'typeName'] as const;
    for (let index = 0; index < records.length; index++) {
      if (!this.check()) return;
      if (
        ++this.exportedTypeCaptureAttempts > this.limits.maxRecords ||
        this.recordCeilingReached(false)
      ) {
        this.issue('exported-type-count-limit');
        return;
      }
      const record: unknown = records[index];
      if (
        !record ||
        typeof record !== 'object' ||
        types.isProxy(record) ||
        (Object.getPrototypeOf(record) !== Object.prototype &&
          Object.getPrototypeOf(record) !== null)
      ) {
        this.issue('exported-type-invalid');
        continue;
      }
      const recordKeys = Reflect.ownKeys(record);
      if (
        recordKeys.length !== fields.length ||
        !fields.every((key) => Object.hasOwn(record, key)) ||
        !recordKeys.every(
          (key) =>
            typeof key === 'string' &&
            fields.includes(key as (typeof fields)[number]) &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, 'value'),
        )
      ) {
        this.issue('exported-type-invalid');
        continue;
      }
      const values = record as Record<(typeof fields)[number], unknown>;
      const available = Math.min(
        MAX_GRAPH_RECORD_BYTES,
        this.limits.maxRecordBytes,
        this.limits.batchBytes,
        this.limits.maxBytes - this.retainedBytes - this.inputBytes,
        this.request.artifactAllowance.remainingBytes,
      );
      let stringBytes = 0;
      let byteLimited = false;
      if (
        !fields.every((key) => {
          const value = values[key];
          if (typeof value !== 'string') return false;
          if (
            value.length > available ||
            (stringBytes += Buffer.byteLength(value, 'utf8')) > available
          ) {
            byteLimited = true;
            return false;
          }
          return true;
        })
      ) {
        this.issue(byteLimited ? 'exported-type-byte-limit' : 'exported-type-invalid');
        continue;
      }
      const detached: Record<string, unknown> = Object.create(null);
      for (const key of fields) detached[key] = values[key];
      const encoded = JSON.stringify(detached);
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > available) {
        this.issue('exported-type-byte-limit');
        continue;
      }
      this.exportedTypeRecords.push(encoded);
      this.exportedTypeBytes += bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    }
  }
  async *iterateExportedTypes(): AsyncIterable<readonly RetainedExportedType[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: RetainedExportedType[] = [];
      let bytes = 0;
      for (const encoded of this.exportedTypeRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded) as RetainedExportedType);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  captureFileBindings(records: readonly RetainedFileBinding[]): void {
    this.completedProducers.delete('file-bindings');
    if (!this.check()) return;
    if (this.fileBindingCaptureAttempts >= this.limits.maxRecords) {
      this.issue('file-binding-count-limit');
      return;
    }
    // Inspect array shape before reading entries; never call a supplied iterator.
    if (
      types.isProxy(records) ||
      !Array.isArray(records) ||
      Object.getPrototypeOf(records) !== Array.prototype
    ) {
      this.fileBindingCaptureAttempts++;
      this.issue('file-binding-invalid');
      return;
    }
    if (records.length > this.limits.maxRecords) {
      this.fileBindingCaptureAttempts = this.limits.maxRecords;
      this.issue('file-binding-count-limit');
      return;
    }
    const keys = Reflect.ownKeys(records);
    if (
      keys.length !== records.length + 1 ||
      !keys.every(
        (key) =>
          key === 'length' ||
          (typeof key === 'string' &&
            /^(0|[1-9]\d*)$/.test(key) &&
            Number(key) < records.length &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(records, key)!, 'value')),
      )
    ) {
      this.fileBindingCaptureAttempts++;
      this.issue('file-binding-invalid');
      return;
    }
    const fields = ['filePath', 'varName', 'typeName'] as const;
    for (let index = 0; index < records.length; index++) {
      if (!this.check()) return;
      if (
        ++this.fileBindingCaptureAttempts > this.limits.maxRecords ||
        this.recordCeilingReached(false)
      ) {
        this.issue('file-binding-count-limit');
        return;
      }
      const record: unknown = records[index];
      if (
        !record ||
        typeof record !== 'object' ||
        types.isProxy(record) ||
        (Object.getPrototypeOf(record) !== Object.prototype &&
          Object.getPrototypeOf(record) !== null)
      ) {
        this.issue('file-binding-invalid');
        continue;
      }
      const recordKeys = Reflect.ownKeys(record);
      if (
        recordKeys.length !== fields.length ||
        !fields.every((key) => Object.hasOwn(record, key)) ||
        !recordKeys.every(
          (key) =>
            typeof key === 'string' &&
            fields.includes(key as (typeof fields)[number]) &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, 'value'),
        )
      ) {
        this.issue('file-binding-invalid');
        continue;
      }
      const values = record as Record<(typeof fields)[number], unknown>;
      const available = Math.min(
        MAX_GRAPH_RECORD_BYTES,
        this.limits.maxRecordBytes,
        this.limits.batchBytes,
        this.limits.maxBytes - this.retainedBytes - this.inputBytes,
        this.request.artifactAllowance.remainingBytes,
      );
      let stringBytes = 0;
      let byteLimited = false;
      if (
        !fields.every((key) => {
          const value = values[key];
          if (typeof value !== 'string') return false;
          if (
            value.length > available ||
            (stringBytes += Buffer.byteLength(value, 'utf8')) > available
          ) {
            byteLimited = true;
            return false;
          }
          return true;
        })
      ) {
        this.issue(byteLimited ? 'file-binding-byte-limit' : 'file-binding-invalid');
        continue;
      }
      const detached: Record<string, unknown> = Object.create(null);
      for (const key of fields) detached[key] = values[key];
      const encoded = JSON.stringify(detached);
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > available) {
        this.issue('file-binding-byte-limit');
        continue;
      }
      this.fileBindingRecords.push(encoded);
      this.fileBindingBytes += bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    }
  }
  async *iterateFileBindings(): AsyncIterable<readonly RetainedFileBinding[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: RetainedFileBinding[] = [];
      let bytes = 0;
      for (const encoded of this.fileBindingRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded) as RetainedFileBinding);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  markGraphNodesCaptured(): void {
    this.markProducerCompleted('graph-nodes');
  }
  markGraphRelationshipsCaptured(): void {
    this.markProducerCompleted('graph-relationships');
  }
  /** Structural parse edges only; call and write resolvers must regenerate their outputs. */
  captureGraphRelationship(edge: unknown): boolean {
    this.completedProducers.delete('graph-relationships');
    if (!this.check()) return false;
    if (
      ++this.graphRelationshipCaptureAttempts > this.limits.maxRecords ||
      this.recordCeilingReached(false)
    ) {
      this.issue('graph-relationship-count-limit');
      return false;
    }
    const available = Math.min(
      MAX_GRAPH_RECORD_BYTES,
      this.limits.maxRecordBytes,
      this.limits.batchBytes,
      this.limits.maxBytes - this.retainedBytes - this.inputBytes,
      this.request.artifactAllowance.remainingBytes,
    );
    try {
      if (available < 1) {
        this.issue('graph-relationship-byte-limit');
        return false;
      }
      const encoded = encodeGraphRelationshipRecord(edge, available);
      const detached = JSON.parse(encoded).graphRelationship as GraphRelationship;
      if (
        detached.type === 'CALLS' ||
        (detached.type === 'ACCESSES' && detached.reason === 'write')
      ) {
        this.issue('graph-relationship-resolver-output');
        return false;
      }
      const bytes = Buffer.byteLength(encoded, 'utf8');
      this.graphRelationshipRecords.push(encoded);
      this.graphRelationshipBytes += bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
      return true;
    } catch (error) {
      if (!(error instanceof ParsedFileRecordError)) throw error;
      this.issue(`graph-relationship-${error.reason}`);
      return false;
    }
  }
  async *iterateGraphRelationships(): AsyncIterable<readonly GraphRelationship[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: GraphRelationship[] = [];
      let bytes = 0;
      for (const encoded of this.graphRelationshipRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded).graphRelationship as GraphRelationship);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  /** JSON-compatible nodes observed at the parse handoff, without a whole-graph copy. */
  captureGraphNode(node: unknown): boolean {
    this.completedProducers.delete('graph-nodes');
    if (!this.check()) return false;
    if (
      ++this.graphNodeCaptureAttempts > this.limits.maxRecords ||
      this.recordCeilingReached(false)
    ) {
      this.issue('graph-node-count-limit');
      return false;
    }
    const available = Math.min(
      MAX_GRAPH_RECORD_BYTES,
      this.limits.maxRecordBytes,
      this.limits.batchBytes,
      this.limits.maxBytes - this.retainedBytes - this.inputBytes,
      this.request.artifactAllowance.remainingBytes,
    );
    try {
      if (available < 1) {
        this.issue('graph-node-byte-limit');
        return false;
      }
      const encoded = encodeGraphNodeRecord(node, available);
      const bytes = Buffer.byteLength(encoded, 'utf8');
      this.graphNodeRecords.push(encoded);
      this.graphNodeBytes += bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
      return true;
    } catch (error) {
      if (!(error instanceof ParsedFileRecordError)) throw error;
      this.issue(`graph-node-${error.reason}`);
      return false;
    }
  }
  async *iterateGraphNodes(): AsyncIterable<readonly GraphNode[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: GraphNode[] = [];
      let bytes = 0;
      for (const encoded of this.graphNodeRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded).graphNode as GraphNode);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  /** One final parse-state snapshot; bounded by the existing snapshot owner before copying. */
  captureImportState(ctx: Parameters<typeof snapshotImportResolutionState>[0]): void {
    this.completedProducers.delete('import-states');
    if (!this.check()) return;
    if (this.importStateCaptureAttempted) {
      this.issue('import-state-duplicate');
      return;
    }
    this.importStateCaptureAttempted = true;
    if (this.recordCeilingReached(false)) {
      this.issue('import-state-count-limit');
      return;
    }
    const available = Math.min(
      MAX_GRAPH_RECORD_BYTES,
      this.limits.maxRecordBytes,
      this.limits.batchBytes,
      this.limits.maxBytes - this.retainedBytes - this.inputBytes,
      this.request.artifactAllowance.remainingBytes,
    );
    try {
      const snapshot = snapshotImportResolutionState(ctx, {
        maxBytes: available,
        maxEntries: this.limits.maxRecords,
      });
      const encoded = JSON.stringify(snapshot);
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > available) {
        this.issue('import-state-byte-limit');
        return;
      }
      if (!this.check()) return;
      this.importStateRecord = encoded;
      this.importStateBytes = bytes;
      this.retainedBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    } catch {
      // Retention failure must preserve the live import maps and normal parsing.
      this.issue('import-state-incomplete');
    }
  }
  async *iterateImportStates(): AsyncIterable<readonly ImportResolutionStateSnapshotV1[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      if (!this.check() || this.importStateRecord === undefined) return;
      const snapshot = JSON.parse(this.importStateRecord) as ImportResolutionStateSnapshotV1;
      await Promise.resolve();
      if (this.check()) yield [snapshot];
    } finally {
      this.replayActive = false;
    }
  }
  markModelRegistrationsIncomplete(): void {
    this.issue('model-registration-incomplete');
  }
  /** Internal observer input: the semantic-model owner validates and bounds the encoded event. */
  captureModelRegistration(encoded: string): boolean {
    this.completedProducers.delete('model-registrations');
    if (!this.check()) return false;
    if (this.modelRegistrationCaptureAttempts >= this.limits.maxRecords) {
      this.issue('model-registration-count-limit');
      return false;
    }
    this.modelRegistrationCaptureAttempts++;
    if (this.recordCeilingReached(false)) {
      this.issue('model-registration-count-limit');
      return false;
    }
    if (typeof encoded !== 'string') {
      this.issue('model-registration-invalid');
      return false;
    }
    const available = Math.min(
      MAX_GRAPH_RECORD_BYTES,
      this.limits.maxRecordBytes,
      this.limits.batchBytes,
      this.limits.maxBytes - this.retainedBytes - this.inputBytes,
      this.request.artifactAllowance.remainingBytes,
    );
    if (encoded.length > available) {
      this.issue('model-registration-byte-limit');
      return false;
    }
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > available) {
      this.issue('model-registration-byte-limit');
      return false;
    }
    this.modelRegistrationRecords.push(encoded);
    this.modelRegistrationBytes += bytes;
    this.retainedBytes += bytes;
    this.request.artifactAllowance.remainingBytes -= bytes;
    return true;
  }
  async *iterateModelRegistrations(): AsyncIterable<readonly SemanticModelRegistrationEvent[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: SemanticModelRegistrationEvent[] = [];
      let bytes = 0;
      for (const encoded of this.modelRegistrationRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded) as SemanticModelRegistrationEvent);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  async *iterateConstructorBindings(): AsyncIterable<readonly FileConstructorBindings[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: FileConstructorBindings[] = [];
      let bytes = 0;
      for (const encoded of this.constructorBindingRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded) as FileConstructorBindings);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  async *iterateORMQueries(): AsyncIterable<readonly ExtractedORMQuery[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: ExtractedORMQuery[] = [];
      let bytes = 0;
      for (const encoded of this.ormQueryRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded) as ExtractedORMQuery);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  async *iterateAssignments(): AsyncIterable<readonly ExtractedAssignment[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: ExtractedAssignment[] = [];
      let bytes = 0;
      for (const encoded of this.assignmentRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded) as ExtractedAssignment);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  async *iterateHeritage(): AsyncIterable<readonly ExtractedHeritage[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: ExtractedHeritage[] = [];
      let bytes = 0;
      for (const encoded of this.heritageRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        batch.push(JSON.parse(encoded) as ExtractedHeritage);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  async *iterateCalls(): AsyncIterable<readonly ExtractedCall[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      let batch: ExtractedCall[] = [];
      let bytes = 0;
      for (const encoded of this.callRecords) {
        if (!this.check()) return;
        const size = Buffer.byteLength(encoded, 'utf8');
        if (
          batch.length &&
          (batch.length >= this.limits.batchRecords || bytes + size > this.limits.batchBytes)
        ) {
          await Promise.resolve();
          if (!this.check()) return;
          yield batch;
          if (!this.check()) return;
          batch = [];
          bytes = 0;
        }
        const call = JSON.parse(encoded) as ExtractedCall;
        if (call.argTypes)
          call.argTypes = call.argTypes.map((value) => (value === null ? undefined : value));
        batch.push(call);
        bytes += size;
      }
      await Promise.resolve();
      if (this.check() && batch.length) yield batch;
    } finally {
      this.replayActive = false;
    }
  }
  recordOutcomes(outcomes: readonly ScopeExtractionRecord[]): void {
    this.completedProducers.delete('parsed-files');
    this.reconciled = false;
    let count = 0;
    for (const outcome of outcomes) {
      if (!this.check()) return;
      if (++count > this.limits.maxRecords) {
        this.issue('inventory-limit');
        return;
      }
      const entry = this.entry(outcome.filePath);
      if (!entry) continue;
      if (entry.outcome !== undefined) this.issue('duplicate-outcome');
      entry.outcome = ['success', 'failed', 'unsupported'].includes(outcome.status)
        ? outcome.status
        : 'invalid-outcome';
      const unconsumed = isUnconsumedRustScopeFailure(outcome);
      if (entry.outcome !== 'success' && !unconsumed) this.issue(entry.outcome);
      if (outcome.status === 'failed' && outcome.reason === 'unsupported-syntax') {
        entry.reason = 'unsupported-syntax';
        if (!unconsumed) this.issue('unsupported-syntax');
      } else {
        delete entry.reason;
      }
    }
  }
  reconcile(expectedPaths: Iterable<string>, skippedPaths: Iterable<string> = []): void {
    this.completedProducers.delete('parsed-files');
    this.reconciled = false;
    for (const entry of this.entries.values()) {
      entry.expected = false;
      entry.skipped = false;
    }
    let count = 0;
    for (const filePath of expectedPaths) {
      if (!this.check()) return;
      if (++count > this.limits.maxRecords) {
        this.issue('inventory-limit');
        return;
      }
      const entry = this.entry(filePath);
      if (entry) {
        if (entry.expected) this.issue('duplicate-expected-path');
        entry.expected = true;
      }
    }
    count = 0;
    for (const filePath of skippedPaths) {
      if (!this.check()) return;
      if (++count > this.limits.maxRecords) {
        this.issue('inventory-limit');
        return;
      }
      const entry = this.entry(filePath);
      if (entry) entry.skipped = true;
    }
    for (const [filePath, entry] of this.entries) {
      const status = this.entryStatus(entry, filePath);
      if (status !== 'retained' && status !== 'not-required') this.issue(status);
      if (!entry.expected) this.issue('unexpected-artifact-or-outcome');
    }
    if (!this.entries.size) this.issue('empty-observed-inventory');
    this.reconciled = true;
  }
  flush(): Promise<void> {
    this.pending = this.pending
      .then(async () => {
        if (!this.check()) return;
        if (!this.queued.length) return;
        if (!this.directory) {
          this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-parse-scopes-'));
          this.filePath = path.join(this.directory, 'stage.jsonl');
        }
        // One bounded record per write; never construct a whole-chunk encoded copy.
        let written = 0;
        while (written < this.queued.length && this.check()) {
          const record = this.queued[written];
          await fs.appendFile(this.filePath!, record, { encoding: 'utf8', mode: 0o600 });
          written++;
        }
        this.queued.splice(0, written);
      })
      .catch((error) => {
        this.issue('write-failed');
        throw error;
      });
    return this.pending;
  }
  async *iterate(): AsyncIterable<readonly ParsedFile[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      await this.flush();
      if (!this.check() || !this.filePath) return;
      this.pendingReader = fs.open(this.filePath, 'r').then(async (reader) => {
        this.readers.add(reader);
        if (!this.check()) {
          await this.closeReader(reader);
          return;
        }
        return reader;
      });
      const reader = await this.pendingReader;
      if (!reader) return;
      const buffer = Buffer.alloc(this.limits.readChunkBytes);
      let pieces: Buffer[] = [];
      let lineBytes = 0;
      let batch: ParsedFile[] = [];
      let batchBytes = 0;
      let count = 0;
      let bytes = 0;
      try {
        while (this.check()) {
          const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
          if (!this.check()) return;
          if (!bytesRead) break;
          let start = 0;
          for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] !== 10) continue;
            const part = buffer.subarray(start, i + 1);
            lineBytes += part.length;
            if (lineBytes > this.limits.maxRecordBytes || lineBytes > this.limits.batchBytes)
              throw new ParsedFileRecordError('record-byte-limit');
            pieces.push(part);
            const line = Buffer.concat(pieces, lineBytes).toString('utf8');
            bytes += lineBytes;
            count++;
            if (
              bytes >
                this.retainedBytes -
                  this.callBytes -
                  this.heritageBytes -
                  this.assignmentBytes -
                  this.ormQueryBytes -
                  this.extractionBytes -
                  this.constructorBindingBytes -
                  this.exportedTypeBytes -
                  this.fileBindingBytes -
                  this.modelRegistrationBytes -
                  this.importStateBytes -
                  this.graphNodeBytes -
                  this.graphRelationshipBytes ||
              count > this.retainedRecords
            )
              throw new ParsedFileRecordError('stage-size-mismatch');
            if (
              batch.length &&
              (batch.length >= this.limits.batchRecords ||
                batchBytes + lineBytes > this.limits.batchBytes)
            ) {
              yield batch;
              batch = [];
              batchBytes = 0;
              if (!this.check()) return;
            }
            batch.push(decodeParsedFileRecord(line));
            batchBytes += lineBytes;
            pieces = [];
            lineBytes = 0;
            start = i + 1;
          }
          if (start < bytesRead) {
            lineBytes += bytesRead - start;
            if (lineBytes > this.limits.maxRecordBytes)
              throw new ParsedFileRecordError('record-byte-limit');
            pieces.push(Buffer.from(buffer.subarray(start, bytesRead)));
          }
        }
        if (!this.check()) return;
        if (
          lineBytes ||
          count !== this.retainedRecords ||
          bytes !==
            this.retainedBytes -
              this.callBytes -
              this.heritageBytes -
              this.assignmentBytes -
              this.ormQueryBytes -
              this.extractionBytes -
              this.constructorBindingBytes -
              this.exportedTypeBytes -
              this.fileBindingBytes -
              this.modelRegistrationBytes -
              this.importStateBytes -
              this.graphNodeBytes -
              this.graphRelationshipBytes
        )
          throw new ParsedFileRecordError('stage-size-mismatch');
        if (batch.length) yield batch;
      } catch (error) {
        this.issue('replay-failed');
        throw error;
      } finally {
        await this.closeReader(reader);
      }
    } finally {
      this.pendingReader = undefined;
      this.replayActive = false;
    }
  }
  private closeReader(reader: FileHandle): Promise<void> {
    const closing = this.closingReaders.get(reader);
    if (closing) return closing;
    if (!this.readers.has(reader)) return Promise.resolve();
    const pending = reader.close().finally(() => {
      this.readers.delete(reader);
      this.closingReaders.delete(reader);
    });
    this.closingReaders.set(reader, pending);
    return pending;
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.entries.clear();
    this.inventoryBytes = 0;
    this.configuration = null;
    this.discoverySnapshot = null;
    this.parserCodeIdentity = null;
    this.sources.clear();
    this.callRecords = [];
    this.heritageRecords = [];
    this.assignmentRecords = [];
    this.ormQueryRecords = [];
    for (const records of Object.values(this.extractionRecords)) records.length = 0;
    this.constructorBindingRecords = [];
    this.exportedTypeRecords = [];
    this.fileBindingRecords = [];
    this.modelRegistrationRecords = [];
    this.importStateRecord = undefined;
    this.graphNodeRecords = [];
    this.completedProducers.clear();
    this.graphRelationshipRecords = [];
    this.disposing = (async () => {
      await this.pending.catch(() => undefined);
      await this.pendingReader?.catch(() => undefined);
      // Await active I/O before deleting its storage; close is idempotent on FileHandle.
      const closed = await Promise.allSettled(
        [...this.readers].map((reader) => this.closeReader(reader)),
      );
      this.readers.clear();
      if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
      this.directory = undefined;
      this.filePath = undefined;
      this.queued = [];
      this.request.artifactAllowance.remainingBytes += this.retainedBytes + this.inputBytes;
      this.inputBytes = 0;
      const failed = closed.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return this.disposing;
  }
}
