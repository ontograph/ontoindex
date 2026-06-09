export const CURRENT_DELTA_METADATA_SCHEMA_VERSION = 1;

export type AnalysisPhase = 'scan' | 'structure' | 'parse' | 'cross-file' | 'persist' | 'finalize';

export type AnalysisMetadataStatus = 'pending' | 'success' | 'failed' | 'skipped';

export interface FileAnalysisMetadata {
  schemaVersion: number;
  repoId: string;
  repoRoot: string;
  filePath: string;
  fileHash: string;
  language: string;
  parserVersion: string;
  providerVersion: string;
  lastSuccessfulPhase: AnalysisPhase | null;
  status: AnalysisMetadataStatus;
  failureReason?: string;
  embeddingModel?: string;
  chunkStrategy?: string;
  analyzedAt: string;
}

export type FileAnalysisMetadataInput = Omit<
  FileAnalysisMetadata,
  'schemaVersion' | 'analyzedAt'
> & {
  analyzedAt?: string;
  schemaVersion?: number;
};

const requiredStringFields = [
  'repoId',
  'repoRoot',
  'filePath',
  'fileHash',
  'language',
  'parserVersion',
  'providerVersion',
] as const;

export function createFileAnalysisMetadata(input: FileAnalysisMetadataInput): FileAnalysisMetadata {
  for (const field of requiredStringFields) {
    if (input[field].trim().length === 0) {
      throw new Error(`File analysis metadata requires ${field}`);
    }
  }

  if (input.status === 'failed' && !input.failureReason?.trim()) {
    throw new Error('File analysis metadata requires failureReason when status is failed');
  }

  return {
    ...input,
    schemaVersion: input.schemaVersion ?? CURRENT_DELTA_METADATA_SCHEMA_VERSION,
    analyzedAt: input.analyzedAt ?? new Date().toISOString(),
  };
}
