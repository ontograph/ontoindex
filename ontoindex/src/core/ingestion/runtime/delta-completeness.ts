import type { AnalysisMetadataStatus } from './delta-metadata.js';
import type { DeltaMetadataStore } from './delta-metadata-store.js';

export interface DeltaCompletenessSummary {
  complete: boolean;
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  pendingFiles: number;
  skippedFiles: number;
  missingFiles: number;
  incompleteFiles: number;
  failedFilePaths: readonly string[];
  missingFilePaths: readonly string[];
  lastAnalyzedAt: string | null;
}

export function summarizeDeltaCompleteness(
  store: DeltaMetadataStore | null,
  expectedFilePaths: readonly string[] = [],
): DeltaCompletenessSummary {
  const expected = new Set(expectedFilePaths);
  const files = store?.files ?? {};
  const knownFilePaths = Object.keys(files);
  const totalFilePaths = new Set([...expected, ...knownFilePaths]);

  const statusCounts: Record<AnalysisMetadataStatus, number> = {
    pending: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  };
  const failedFilePaths: string[] = [];
  const analyzedAtValues: string[] = [];

  for (const filePath of knownFilePaths) {
    const metadata = files[filePath];
    statusCounts[metadata.status] += 1;
    if (metadata.status === 'failed') {
      failedFilePaths.push(filePath);
    }
    if (metadata.analyzedAt.trim().length > 0) {
      analyzedAtValues.push(metadata.analyzedAt);
    }
  }

  const missingFilePaths = [...expected].filter((filePath) => files[filePath] === undefined).sort();
  const incompleteFiles = statusCounts.pending + statusCounts.failed + missingFilePaths.length;

  return {
    complete: totalFilePaths.size > 0 && incompleteFiles === 0,
    totalFiles: totalFilePaths.size,
    successfulFiles: statusCounts.success,
    failedFiles: statusCounts.failed,
    pendingFiles: statusCounts.pending,
    skippedFiles: statusCounts.skipped,
    missingFiles: missingFilePaths.length,
    incompleteFiles,
    failedFilePaths: failedFilePaths.sort(),
    missingFilePaths,
    lastAnalyzedAt: analyzedAtValues.sort().at(-1) ?? null,
  };
}
