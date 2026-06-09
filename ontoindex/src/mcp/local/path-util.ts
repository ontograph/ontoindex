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
