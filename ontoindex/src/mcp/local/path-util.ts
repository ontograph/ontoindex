import fs from 'fs/promises';
import path from 'path';

/**
 * Security utility to ensure a user-provided file path stays within the repository.
 *
 * @param repoPath Absolute path to the repository root.
 * @param input Relative or absolute path provided by the user.
 * @returns Absolute path to the file if safe.
 * @throws Error if the path escapes the repository or contains invalid characters.
 */
export function canonicalize(repoPath: string, input: string): string {
  if (!input) {
    throw new Error('Path cannot be empty');
  }

  if (input.includes('\0')) {
    throw new Error('Path contains invalid characters');
  }

  // Ensure repoPath is absolute and normalized
  const absoluteRepoPath = path.resolve(repoPath);

  // Resolve input against repo root
  const absoluteInputPath = path.resolve(absoluteRepoPath, input);

  // Check for escape: absoluteInputPath MUST start with absoluteRepoPath + separator
  // Special case: if absoluteInputPath === absoluteRepoPath, it's also safe (repo root)
  const normalizedRepo = absoluteRepoPath.endsWith(path.sep)
    ? absoluteRepoPath
    : absoluteRepoPath + path.sep;

  if (absoluteInputPath !== absoluteRepoPath && !absoluteInputPath.startsWith(normalizedRepo)) {
    throw new Error('Path escapes repository: ' + input);
  }

  return absoluteInputPath;
}

/**
 * Resolve a repository path through the filesystem and require the real target
 * to stay inside the real repository root. A lexical check alone lets a symlink
 * inside the repository point at a file outside it.
 *
 * Callers must operate on the returned path, not the original input.
 */
export async function resolveContainedRealPath(repoPath: string, input: string): Promise<string> {
  const lexicalPath = canonicalize(repoPath, input);
  const realRepoPath = await fs.realpath(path.resolve(repoPath));
  let realPath: string;
  try {
    realPath = await fs.realpath(lexicalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    realPath = path.join(await fs.realpath(path.dirname(lexicalPath)), path.basename(lexicalPath));
  }
  if (realPath !== realRepoPath && !realPath.startsWith(realRepoPath + path.sep)) {
    throw new Error('Path escapes repository: ' + input);
  }
  return realPath;
}
