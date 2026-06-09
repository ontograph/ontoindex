import path from 'path';

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

export function resolveContainedRepoPath(repoPath: string, rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoPath, rawPath);
  const normalizedRepo = path.resolve(repoPath);
  const normalizedAbsolute = path.resolve(absolutePath);
  if (
    normalizedAbsolute !== normalizedRepo &&
    !normalizedAbsolute.startsWith(normalizedRepo + path.sep)
  ) {
    return null;
  }
  return normalizedAbsolute;
}
