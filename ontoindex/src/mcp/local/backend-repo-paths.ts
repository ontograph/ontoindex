import path from 'path';
import { resolveContainedRealPath } from './path-util.js';

export function normalizeRepoRelativePath(repoPath: string, filePath: string): string {
  const repoRoot = path.resolve(repoPath);
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot, filePath);
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

export function resolveRepoFilePath(repoPath: string, filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.join(repoPath, filePath);
}

export async function resolveContainedRepoPath(
  repoPath: string,
  rawPath: string,
): Promise<string | null> {
  if (!rawPath || typeof rawPath !== 'string') return null;
  try {
    return await resolveContainedRealPath(repoPath, rawPath);
  } catch {
    return null;
  }
}
