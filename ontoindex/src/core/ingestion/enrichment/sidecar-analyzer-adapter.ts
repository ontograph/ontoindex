import {
  createEnrichmentRecord,
  type EnrichmentFact,
  type EnrichmentRecordInput,
} from './enrichment-record.js';
import type { SidecarRunnerExecutionResult, SidecarRunnerCallbacks } from './sidecar-runner.js';
import type { SidecarEnrichmentRequest } from './sidecar-request-pool.js';

export interface SidecarAnalyzerMetadata {
  analyzerId: string;
  analyzerVersion: string;
}

export interface SidecarAnalyzerSnapshot {
  sourceIndexId: string;
  sourceCommitHash: string;
  schemaVersion: number;
}

export interface SidecarAnalyzerFileScope {
  filePath: string;
  fileHash: string;
  facts?: readonly EnrichmentFact[];
}

export interface LocalSidecarAnalyzeInput {
  request: SidecarEnrichmentRequest;
  analyzer: SidecarAnalyzerMetadata;
  snapshot: SidecarAnalyzerSnapshot;
  file: SidecarAnalyzerFileScope;
}

export interface LocalSidecarAnalyzeResult {
  status?: 'complete' | 'partial' | 'failed';
  records?: readonly EnrichmentFact[];
  confidence?: number;
  failureReason?: string;
}

export type LocalSidecarAnalyzeCallback = (
  input: LocalSidecarAnalyzeInput,
) =>
  | LocalSidecarAnalyzeResult
  | readonly EnrichmentFact[]
  | Promise<LocalSidecarAnalyzeResult | readonly EnrichmentFact[]>;

export interface SidecarAnalyzerAdapterOptions {
  analyzer: SidecarAnalyzerMetadata;
  snapshot: SidecarAnalyzerSnapshot;
  files: readonly SidecarAnalyzerFileScope[];
  analyze: LocalSidecarAnalyzeCallback;
}

export interface SidecarAnalyzerExecutorOptions extends SidecarAnalyzerAdapterOptions {
  upsertEnrichment: (record: EnrichmentRecordInput) => Promise<unknown> | unknown;
}

export interface SidecarAnalyzerAdapter {
  analyze(request: SidecarEnrichmentRequest): Promise<EnrichmentRecordInput[]>;
  createExecutor(
    upsertEnrichment: SidecarAnalyzerExecutorOptions['upsertEnrichment'],
  ): SidecarRunnerCallbacks['executeRequest'];
}

export class LocalSidecarAnalyzerAdapter implements SidecarAnalyzerAdapter {
  constructor(private readonly options: SidecarAnalyzerAdapterOptions) {}

  analyze(request: SidecarEnrichmentRequest): Promise<EnrichmentRecordInput[]> {
    return analyzeSidecarRequestToEnrichmentRecords(request, this.options);
  }

  createExecutor(
    upsertEnrichment: SidecarAnalyzerExecutorOptions['upsertEnrichment'],
  ): SidecarRunnerCallbacks['executeRequest'] {
    return createSidecarAnalyzerExecutor({
      ...this.options,
      upsertEnrichment,
    });
  }
}

export async function analyzeSidecarRequestToEnrichmentRecords(
  request: SidecarEnrichmentRequest,
  options: SidecarAnalyzerAdapterOptions,
): Promise<EnrichmentRecordInput[]> {
  assertRequestMatchesAdapter(request, options);
  if (options.files.length === 0) return [];

  const records: EnrichmentRecordInput[] = [];
  for (const file of sortFileScope(options.files)) {
    records.push(await analyzeFile(request, options, file));
  }
  return records;
}

export function createSidecarAnalyzerExecutor(
  options: SidecarAnalyzerExecutorOptions,
): SidecarRunnerCallbacks['executeRequest'] {
  return async (request) => {
    const records = await analyzeSidecarRequestToEnrichmentRecords(request, options);
    for (const record of records) {
      await options.upsertEnrichment(record);
    }
    return summarizeExecution(records);
  };
}

async function analyzeFile(
  request: SidecarEnrichmentRequest,
  options: SidecarAnalyzerAdapterOptions,
  file: SidecarAnalyzerFileScope,
): Promise<EnrichmentRecordInput> {
  try {
    const result = normalizeAnalyzeResult(
      await options.analyze({
        request,
        analyzer: options.analyzer,
        snapshot: options.snapshot,
        file,
      }),
      file,
    );
    return createBoundRecord(request, options, file, result);
  } catch (error) {
    return createBoundRecord(request, options, file, {
      status: 'failed',
      records: [],
      failureReason: errorToMessage(error),
    });
  }
}

function createBoundRecord(
  request: SidecarEnrichmentRequest,
  options: SidecarAnalyzerAdapterOptions,
  file: SidecarAnalyzerFileScope,
  result: Required<Pick<LocalSidecarAnalyzeResult, 'status' | 'records'>> &
    Pick<LocalSidecarAnalyzeResult, 'confidence' | 'failureReason'>,
): EnrichmentRecordInput {
  const input: EnrichmentRecordInput = {
    sourceIndexId: options.snapshot.sourceIndexId,
    sourceCommitHash: options.snapshot.sourceCommitHash,
    schemaVersion: options.snapshot.schemaVersion,
    analyzerId: request.analyzerId,
    analyzerVersion: request.analyzerVersion,
    filePath: file.filePath,
    fileHash: file.fileHash,
    status: result.status,
    records: result.records,
  };

  if (result.confidence !== undefined) input.confidence = result.confidence;
  if (result.failureReason !== undefined) input.failureReason = result.failureReason;
  return createEnrichmentRecord(input);
}

function normalizeAnalyzeResult(
  result: LocalSidecarAnalyzeResult | readonly EnrichmentFact[],
  file: SidecarAnalyzerFileScope,
): Required<Pick<LocalSidecarAnalyzeResult, 'status' | 'records'>> &
  Pick<LocalSidecarAnalyzeResult, 'confidence' | 'failureReason'> {
  if (isEnrichmentFactArray(result)) {
    return { status: 'complete', records: result };
  }
  return {
    status: result.status ?? 'complete',
    records: result.records ?? file.facts ?? [],
    confidence: result.confidence,
    failureReason:
      result.status === 'failed' && result.failureReason === undefined
        ? 'sidecar analyzer reported file failure'
        : result.failureReason,
  };
}

function sortFileScope(files: readonly SidecarAnalyzerFileScope[]): SidecarAnalyzerFileScope[] {
  return [...files].sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) || left.fileHash.localeCompare(right.fileHash),
  );
}

function isEnrichmentFactArray(
  result: LocalSidecarAnalyzeResult | readonly EnrichmentFact[],
): result is readonly EnrichmentFact[] {
  return Array.isArray(result);
}

function assertRequestMatchesAdapter(
  request: SidecarEnrichmentRequest,
  options: SidecarAnalyzerAdapterOptions,
): void {
  if (request.analyzerId !== options.analyzer.analyzerId) {
    throw new Error(
      `sidecar analyzer id mismatch: request=${request.analyzerId} adapter=${options.analyzer.analyzerId}`,
    );
  }
  if (request.analyzerVersion !== options.analyzer.analyzerVersion) {
    throw new Error(
      `sidecar analyzer version mismatch: request=${request.analyzerVersion} adapter=${options.analyzer.analyzerVersion}`,
    );
  }
  if (request.sourceIndexId !== options.snapshot.sourceIndexId) {
    throw new Error(
      `sidecar source index mismatch: request=${request.sourceIndexId} snapshot=${options.snapshot.sourceIndexId}`,
    );
  }
  createEnrichmentRecord({
    sourceIndexId: options.snapshot.sourceIndexId,
    sourceCommitHash: options.snapshot.sourceCommitHash,
    schemaVersion: options.snapshot.schemaVersion,
    analyzerId: options.analyzer.analyzerId,
    analyzerVersion: options.analyzer.analyzerVersion,
    filePath: '__adapter_contract_probe__',
    fileHash: '__adapter_contract_probe__',
    status: 'complete',
    records: [],
  });
}

function summarizeExecution(
  records: readonly EnrichmentRecordInput[],
): SidecarRunnerExecutionResult {
  if (records.length === 0) return { status: 'complete' };
  const failedCount = records.filter((record) => record.status === 'failed').length;
  const partialCount = records.filter((record) => record.status === 'partial').length;
  if (failedCount > 0 || partialCount > 0) {
    return {
      status: 'partial',
      failureReason:
        failedCount > 0 ? `${failedCount} file(s) failed during sidecar analysis` : undefined,
    };
  }
  return { status: 'complete' };
}

function errorToMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'sidecar analyzer failed';
}
