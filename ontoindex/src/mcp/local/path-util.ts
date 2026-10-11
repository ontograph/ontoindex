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
  let lexicalPath = path.resolve(realRepoPath, input);
  // Absolute paths spelled through a repo-root alias are rebased onto the real root.
  if (lexicalPath === absoluteRepoPath || lexicalPath.startsWith(absoluteRepoPath + path.sep)) {
    lexicalPath = path.join(realRepoPath, path.relative(absoluteRepoPath, lexicalPath));
  }
  // Check containment before touching the filesystem so an outside path is never probed.
  if (lexicalPath !== realRepoPath && !lexicalPath.startsWith(realRepoPath + path.sep)) {
    throw new Error('Path escapes repository: ' + input);
  }
  let cursor = lexicalPath;
  const missing: string[] = [];
  while (true) {
    // The walk never leaves the repository root, which always resolves.
    if (cursor !== realRepoPath && !cursor.startsWith(realRepoPath + path.sep)) {
      throw new Error('Path escapes repository: ' + input);
    }
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

/**
 * Resolve a metadata path while allowing aliases only above the trusted root.
 * Every existing component at or below the root is inspected with lstat, so a
 * symlink cannot redirect a metadata read, lock, recovery, or write operation.
 */
export async function resolveContainedMetadataPath(root: string, input: string): Promise<string> {
  if (typeof root !== 'string' || !root || root.includes('\0'))
    throw new Error('Metadata root cannot be empty or contain invalid characters');
  if (typeof input !== 'string' || !input || input.includes('\0'))
    throw new Error('Metadata path cannot be empty or contain invalid characters');

  const lexicalRoot = path.resolve(root);
  let canonicalRoot = lexicalRoot;
  const missingRootParts: string[] = [];
  while (true) {
    try {
      canonicalRoot = path.join(await fs.realpath(canonicalRoot), ...missingRootParts);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      try {
        await fs.lstat(canonicalRoot);
        throw new Error(`Unable to resolve metadata root: ${root}`);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException)?.code !== 'ENOENT') throw statError;
      }
      const parent = path.dirname(canonicalRoot);
      if (parent === canonicalRoot) throw error;
      missingRootParts.unshift(path.basename(canonicalRoot));
      canonicalRoot = parent;
    }
  }

  let lexicalTarget = path.resolve(lexicalRoot, input);
  if (lexicalTarget === lexicalRoot || lexicalTarget.startsWith(lexicalRoot + path.sep)) {
    lexicalTarget = path.join(canonicalRoot, path.relative(lexicalRoot, lexicalTarget));
  }
  if (lexicalTarget !== canonicalRoot && !lexicalTarget.startsWith(canonicalRoot + path.sep))
    throw new Error(`Metadata path escapes trusted root: ${input}`);

  const relative = path.relative(canonicalRoot, lexicalTarget);
  let cursor = canonicalRoot;
  const components = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    cursor = path.join(cursor, component);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink())
        throw new Error(`Metadata path contains a symbolic link: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      // Once a component is missing, its descendants cannot exist yet.
      return path.join(cursor, ...components.slice(index + 1));
    }
  }
  return cursor;
}
