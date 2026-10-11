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
  if (typeof input !== 'string' || !input || input.includes('\0'))
    throw new Error('Path cannot be empty or contain invalid characters');
  const absoluteRepoPath = path.resolve(repoPath);
  const realRepoPath = await fs.realpath(absoluteRepoPath);
  const lexicalPath = path.resolve(absoluteRepoPath, input);
  // Check lexical containment before touching the filesystem so an outside
  // path is never probed. The real root covers absolute paths spelled through it.
  const within = (root: string) => lexicalPath === root || lexicalPath.startsWith(root + path.sep);
  if (!within(absoluteRepoPath) && !within(realRepoPath)) {
    throw new Error('Path escapes repository: ' + input);
  }
  let cursor = lexicalPath;
  const missing: string[] = [];
  while (true) {
    try {
      cursor = await fs.realpath(cursor);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      try {
        await fs.lstat(cursor);
        // An existing but unresolvable symlink is dangling; never treat it as
        // a missing path and let a later write follow it.
        throw new Error('Unable to resolve path: ' + input);
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException)?.code !== 'ENOENT') throw statErr;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw err;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  const realPath = path.join(cursor, ...missing);
  if (realPath !== realRepoPath && !realPath.startsWith(realRepoPath + path.sep)) {
    throw new Error('Path escapes repository: ' + input);
  }
  return realPath;
}
