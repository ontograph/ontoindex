import type { ScopeRetentionCoverage } from './scope-retention-coverage.js';

export type ScopeRetentionReplayCoverage =
  | ScopeRetentionCoverage
  | {
      seedReady: boolean;
      status: string;
    };

export interface ScopeRetentionReplayInput {
  changedPaths: readonly string[];
  retainedFiles: readonly string[];
  coverage?: ScopeRetentionReplayCoverage;
  /**
   * Caller assertion that semantic replay safety has been established externally
   * for the selected generation and post-edit context. Neither `coverage.complete`
   * nor candidate integrity verification establishes this admission.
   */
  admission: 'proven' | 'unproven';
  limits?: { maxReplayFiles?: number };
}

export type ScopeRetentionReplayPlan =
  | { kind: 'replay'; files: string[] }
  | {
      kind: 'full-analysis-required';
      reason: 'admission-unproven' | 'coverage-incomplete' | 'replay-too-large';
    }
  | { kind: 'refused'; reason: 'invalid-input' };

/**
 * Plan whole-file replay using externally established admission and descriptive
 * coverage. This planner neither verifies nor grants semantic replay admission.
 */
export function planScopeRetentionReplay(
  input: ScopeRetentionReplayInput,
): ScopeRetentionReplayPlan {
  const invalid: ScopeRetentionReplayPlan = { kind: 'refused', reason: 'invalid-input' };
  if (
    !input ||
    !Array.isArray(input.changedPaths) ||
    !Array.isArray(input.retainedFiles) ||
    !['proven', 'unproven'].includes(input.admission) ||
    (input.limits !== undefined && (!input.limits || typeof input.limits !== 'object'))
  ) {
    return invalid;
  }
  const maxReplayFiles = input.limits?.maxReplayFiles ?? 100_000;
  if (!Number.isSafeInteger(maxReplayFiles) || maxReplayFiles < 0) return invalid;

  const files = new Set<string>();
  for (const paths of [input.retainedFiles, input.changedPaths]) {
    for (const filePath of paths) {
      if (
        typeof filePath !== 'string' ||
        filePath.trim().length === 0 ||
        filePath.startsWith('/') ||
        /[\u0000\\]/.test(filePath) ||
        filePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
      )
        return invalid;
      files.add(filePath);
    }
  }
  if (input.admission !== 'proven') {
    return { kind: 'full-analysis-required', reason: 'admission-unproven' };
  }
  const coverage = input.coverage;
  const complete =
    coverage &&
    typeof coverage === 'object' &&
    ('complete' in coverage
      ? coverage.complete === true
      : coverage.seedReady === true && coverage.status === 'complete');
  if (!complete) return { kind: 'full-analysis-required', reason: 'coverage-incomplete' };
  if (files.size > maxReplayFiles) {
    return { kind: 'full-analysis-required', reason: 'replay-too-large' };
  }
  // Selective narrowing is a later optimisation: retained records cannot yet prove completeness.
  return { kind: 'replay', files: [...files].sort() };
}
