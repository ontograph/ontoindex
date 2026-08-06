import path from 'node:path';

export function allowGlobalNameOnlyCalls(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.ONTOINDEX_ALLOW_GLOBAL_NAME_CALLS === '1';
}

export function canPublishCallEdge(
  callForm: string | undefined,
  resolutionReason: string,
  hasReceiver = false,
  sourceFilePathOrEnv?: string | Record<string, string | undefined>,
  targetFilePath?: string,
  env: Record<string, string | undefined> = process.env,
  importedFiles?: ReadonlySet<string>,
): boolean {
  const effectiveEnv = typeof sourceFilePathOrEnv === 'object' ? sourceFilePathOrEnv : env;
  const effectiveForm = callForm ?? (hasReceiver ? 'member' : 'free');
  if (
    resolutionReason !== 'global' ||
    effectiveForm !== 'free' ||
    allowGlobalNameOnlyCalls(effectiveEnv)
  ) {
    return true;
  }
  if (typeof sourceFilePathOrEnv !== 'string' || !targetFilePath) return false;
  if (sourceFilePathOrEnv === targetFilePath) return true;
  if (
    sourceFilePathOrEnv.endsWith('.go') &&
    targetFilePath.endsWith('.go') &&
    path.posix.dirname(sourceFilePathOrEnv) === path.posix.dirname(targetFilePath)
  )
    return true;
  return importedFiles?.has(targetFilePath) ?? false;
}
