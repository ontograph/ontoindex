import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { constants, type BigIntStats } from 'node:fs';

const require = createRequire(import.meta.url);

type ArtifactEntry = { filename: string; label: string; stat: BigIntStats };

// Nanosecond stats: millisecond floats can hide a same-size rewrite on filesystems with finer ticks.
const BIGINT = { bigint: true } as const;

function sameArtifact(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Internal artifact inventory; exported only to exercise bounded reads with isolated fixtures. */
export async function runtimeArtifactIdentity(
  roots: ReadonlyArray<readonly [string, string]>,
  packagePath: string,
): Promise<string> {
  const maxEntries = 10_000;
  const maxFileBytes = 32 * 1024 * 1024;
  const maxTotalBytes = 128 * 1024 * 1024;
  async function inventory(): Promise<ArtifactEntry[]> {
    const entries: ArtifactEntry[] = [];
    let totalBytes = 0;
    async function visit(filename: string, label: string, depth: number): Promise<void> {
      if (depth > 32 || entries.length >= maxEntries)
        throw new Error('Parser artifact inventory limit exceeded');
      const stat = await fs.lstat(filename, BIGINT);
      if ((!stat.isFile() && !stat.isDirectory()) || !(Number(stat.mode) & 0o444))
        throw new Error(`Parser artifact is not a readable regular file or directory: ${label}`);
      if (stat.isDirectory() && !(Number(stat.mode) & 0o111))
        throw new Error(`Parser artifact directory is not searchable: ${label}`);
      entries.push({ filename, label, stat });
      if (stat.isFile()) {
        totalBytes += Number(stat.size);
        if (Number(stat.size) > maxFileBytes || totalBytes > maxTotalBytes)
          throw new Error(`Parser artifact byte limit exceeded: ${label}`);
      } else {
        const directory = await fs.opendir(filename);
        for await (const entry of directory) {
          await visit(path.join(filename, entry.name), `${label}/${entry.name}`, depth + 1);
        }
        if (!sameArtifact(stat, await fs.lstat(filename, BIGINT)))
          throw new Error(`Parser artifact changed during inventory: ${label}`);
      }
    }
    for (const [label, root] of roots) {
      if (!(await fs.lstat(root, BIGINT)).isDirectory())
        throw new Error(`Parser artifact root is not a directory: ${label}`);
      await visit(root, label, 0);
    }
    await visit(packagePath, 'package.json', 0);
    if (!entries[entries.length - 1]!.stat.isFile())
      throw new Error('Parser package.json is not a regular file');
    return entries.sort((left, right) =>
      left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
    );
  }
  const entries = await inventory();
  const hash = createHash('sha256').update('ontoindex-parser-artifacts-v4\0');
  const buffer = Buffer.alloc(64 * 1024);
  for (const entry of entries) {
    if (entry.stat.isDirectory()) continue;
    const handle = await fs.open(
      entry.filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (
        !sameArtifact(entry.stat, await handle.stat(BIGINT)) ||
        !sameArtifact(entry.stat, await fs.lstat(entry.filename, BIGINT))
      )
        throw new Error(`Parser artifact changed before read: ${entry.label}`);
      hash.update(`${Buffer.byteLength(entry.label)}\0${entry.label}\0${entry.stat.size}\0`);
      let length = 0;
      while (true) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, Number(entry.stat.size) - length + 1),
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
        if (length > Number(entry.stat.size))
          throw new Error(`Parser artifact changed during read: ${entry.label}`);
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (
        length !== Number(entry.stat.size) ||
        !sameArtifact(entry.stat, await handle.stat(BIGINT)) ||
        !sameArtifact(entry.stat, await fs.lstat(entry.filename, BIGINT))
      )
        throw new Error(`Parser artifact changed during read: ${entry.label}`);
    } finally {
      await handle.close();
    }
  }
  const after = await inventory();
  if (
    entries.length !== after.length ||
    entries.some(
      (entry, index) =>
        entry.label !== after[index]!.label || !sameArtifact(entry.stat, after[index]!.stat),
    )
  )
    throw new Error('Parser artifact inventory changed during capture');
  return hash.digest('hex');
}

let runtimeBaseline: Promise<string> | undefined;

/** Capture once, before importing the analyzer; a failed capture cannot be retried in this process. */
export function initializeWorkspaceParserRuntime(): Promise<string> {
  return (runtimeBaseline ??= computeWorkspaceParserIdentity());
}

/** Replay requires a baseline captured before the analyzer was loaded. Never initialize it late. */
export async function supervisedWorkspaceParserIdentity(): Promise<string | null> {
  return runtimeBaseline ? workspaceParserIdentity() : null;
}

/** Verify supervised runtime bytes against startup; ordinary callers retain disk-only identity. */
export async function workspaceParserIdentity(): Promise<string> {
  const baseline = runtimeBaseline;
  const expected = baseline ? await baseline : undefined;
  const identity = await computeWorkspaceParserIdentity();
  if (expected !== undefined && identity !== expected) {
    throw new Error('Parser runtime changed; restart the process before parsing.');
  }
  return identity;
}

async function computeWorkspaceParserIdentity(): Promise<string> {
  const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
  const sourceMode = path.extname(fileURLToPath(import.meta.url)) === '.ts';
  const roots: Array<readonly [string, string]> = [['runtime', runtimeRoot]];
  if (sourceMode) {
    roots.push(['shared', path.dirname(fileURLToPath(import.meta.resolve('ontoindex-shared')))]);
  } else if (!(await fs.lstat(path.join(runtimeRoot, '_shared/index.js'))).isFile()) {
    throw new Error('Built parser runtime is missing _shared/index.js');
  }
  const hash = createHash('sha256').update('ontoindex-parser-code-v4\0');
  hash.update(sourceMode ? 'source\0' : 'built\0');
  hash.update(await runtimeArtifactIdentity(roots, path.join(runtimeRoot, '../package.json')));
  const grammars = [
    ['tree-sitter-javascript', 'JavaScript', ['src/node-types.json']],
    [
      'tree-sitter-typescript',
      'TypeScript',
      ['typescript/src/node-types.json', 'tsx/src/node-types.json'],
    ],
    ['tree-sitter-python', 'Python', ['src/node-types.json']],
    ['tree-sitter-cpp', 'C++', ['src/node-types.json']],
    ['tree-sitter-rust', 'Rust', ['src/node-types.json']],
  ] as const;
  for (const [packageName, languageName, nodeTypeFiles] of grammars) {
    const loadedNativeIdentity = require(packageName).__ontoindexNativeIdentity as
      | { path: string; digest: string }
      | undefined;
    const grammarRoot = path.dirname(require.resolve(`${packageName}/package.json`));
    const nativePath =
      typeof process.versions.bun === 'string'
        ? path.join(
            grammarRoot,
            'prebuilds',
            `${process.platform}-${process.arch}`,
            `${packageName}.node`,
          )
        : require(require.resolve('node-gyp-build', { paths: [grammarRoot] })).path(grammarRoot);
    const grammarFiles = [
      ['native', nativePath],
      ...['bindings/node/index.js', ...nodeTypeFiles].map(
        (file) => [file, path.join(grammarRoot, file)] as const,
      ),
    ] as const;
    const grammarContents = await Promise.all(grammarFiles.map(([, file]) => fs.readFile(file)));
    if (
      loadedNativeIdentity?.path !== nativePath ||
      loadedNativeIdentity.digest !== createHash('sha256').update(grammarContents[0]!).digest('hex')
    ) {
      throw new Error(`${languageName} grammar changed; restart the process before parsing.`);
    }
    for (let index = 0; index < grammarFiles.length; index++) {
      const content = grammarContents[index]!;
      hash.update(`${packageName}/${grammarFiles[index]![0]}\0${content.length}\0`).update(content);
    }
  }
  return hash.digest('hex');
}
