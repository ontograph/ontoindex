import { loadScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';

/** Test-only materialization of tiny verified fixtures; this is not a runtime admission API. */
export async function loadPersistedReplayFamilies(
  generationPath: string,
  expected: Parameters<typeof loadScopeRetentionCandidate>[1],
) {
  const { families } = await loadScopeRetentionCandidate(generationPath, expected, {
    deadline: Date.now() + 60_000,
  });
  return families;
}

export type ReplayFamilies = Awaited<ReturnType<typeof loadPersistedReplayFamilies>>;
