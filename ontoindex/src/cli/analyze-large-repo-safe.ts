export const LARGE_REPO_SAFE_ENV_DEFAULTS = {
  ONTOINDEX_MAX_WORKERS: '1',
  ONTOINDEX_WORKER_SUB_BATCH_SIZE: '8',
  ONTOINDEX_WORKER_SUB_BATCH_TIMEOUT_MS: '30000',
  ONTOINDEX_WORKER_SUB_BATCH_MAX_BYTES: String(1024 * 1024),
} as const;

export type LargeRepoSafeEnvName = keyof typeof LARGE_REPO_SAFE_ENV_DEFAULTS;

export interface LargeRepoSafeOptions {
  largeRepoSafe?: boolean;
  hugeRepo?: boolean;
}

export function applyLargeRepoSafeAnalyzePreset(
  options: LargeRepoSafeOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LargeRepoSafeEnvName[] {
  if (!options?.largeRepoSafe && !options?.hugeRepo) return [];

  const applied: LargeRepoSafeEnvName[] = [];
  for (const [name, value] of Object.entries(LARGE_REPO_SAFE_ENV_DEFAULTS) as [
    LargeRepoSafeEnvName,
    string,
  ][]) {
    if (env[name] === undefined || env[name] === '') {
      env[name] = value;
      applied.push(name);
    }
  }
  return applied;
}

export function formatLargeRepoSafeNote(
  applied: readonly LargeRepoSafeEnvName[],
  options: { embeddings?: boolean } | undefined,
): string {
  const appliedText =
    applied.length > 0
      ? `set ${applied.join(', ')}; existing env overrides respected`
      : 'using existing ONTOINDEX_* environment overrides';
  const embeddingText = options?.embeddings
    ? '--embeddings was requested, so embedding generation remains enabled'
    : 'embeddings remain disabled unless --embeddings is set';
  return `Large repo safe preset active: ${appliedText}; ${embeddingText}.`;
}

export function formatHugeRepoNote(): string {
  return (
    'Huge repo preset active: symbols-only index, large-repo-safe worker defaults, ' +
    'and explicit degraded capability metadata.'
  );
}

export function parseLargeRepoSafeAppliedList(value: string | undefined): LargeRepoSafeEnvName[] {
  if (value === undefined) return [];
  const knownNames = new Set(Object.keys(LARGE_REPO_SAFE_ENV_DEFAULTS));
  return value.split(',').filter((name): name is LargeRepoSafeEnvName => knownNames.has(name));
}
