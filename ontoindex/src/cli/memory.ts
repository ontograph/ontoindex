import fs from 'fs/promises';
import { parseMemoryFile, resolveMemoryPath } from '../mcp/memory-parser.js';
import { getCurrentCommit, getGitRoot } from '../storage/git.js';
import { getStoragePaths, loadMeta } from '../storage/repo-manager.js';

interface MemoryCommandOptions {
  source?: string | string[];
  force?: boolean;
}

type MemoryFreshness = 'fresh' | 'stale-index' | 'unknown';

const normalizeSourceList = (value: string | string[] | undefined): string[] => {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
};

export const buildMemorySkeletonContent = (input: {
  name: string;
  createdAt: string;
  sourceCommit: string;
  indexedCommit: string;
  freshness: MemoryFreshness;
  sources: string[];
}): string => {
  const lines = [
    '---',
    'version: 1',
    'repo: OntoIndex',
    `created_at: ${input.createdAt}`,
    `source_commit: ${input.sourceCommit}`,
    `indexed_commit: ${input.indexedCommit}`,
    `freshness: ${input.freshness}`,
    'kind: advisory',
    'not_audit_evidence: true',
    'sources:',
    ...input.sources.map((source) => `  - ${source}`),
    '---',
    '',
    `# ${input.name}`,
    '',
    'Advisory draft. Replace this placeholder with repo-local guidance tied to the listed sources.',
    '',
    '## Notes',
    '',
    '- Keep this memory advisory only.',
    '- Do not treat it as audit evidence.',
    '',
  ];

  return lines.join('\n');
};

export const memoryCommand = async (name: string, options: MemoryCommandOptions = {}) => {
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.log('  Not inside a git repository.');
    console.log('  Advisory memory authoring is local-only and must target a repository.\n');
    process.exitCode = 1;
    return;
  }

  const sources = normalizeSourceList(options.source);
  if (sources.length === 0) {
    console.log('  At least one --source <path-or-adr> value is required.');
    console.log(
      '  Example: ontoindex memory onboarding --source docs/adr/0023-serena-follow-up-memory-diagnostics-guardrails.md\n',
    );
    process.exitCode = 1;
    return;
  }

  let resolved;
  try {
    resolved = resolveMemoryPath(repoPath, name);
  } catch (error: unknown) {
    console.log(`  ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  let exists = false;
  try {
    await fs.access(resolved.filePath);
    exists = true;
  } catch {}

  if (exists && !options.force) {
    console.log(`  Memory already exists: ${resolved.fileName}`);
    console.log('  Re-run with --force to overwrite the local skeleton.\n');
    process.exitCode = 1;
    return;
  }

  const sourceCommit = getCurrentCommit(repoPath);
  if (!sourceCommit) {
    console.log('  Could not resolve the current commit for this repository.\n');
    process.exitCode = 1;
    return;
  }

  const { storagePath } = getStoragePaths(repoPath);
  const meta = await loadMeta(storagePath);
  const indexedCommit = meta?.lastCommit?.trim() ? meta.lastCommit.trim() : 'unknown';
  const freshness: MemoryFreshness =
    indexedCommit === 'unknown'
      ? 'unknown'
      : indexedCommit === sourceCommit
        ? 'fresh'
        : 'stale-index';

  const content = buildMemorySkeletonContent({
    name: resolved.stem,
    createdAt: new Date().toISOString().slice(0, 10),
    sourceCommit,
    indexedCommit,
    freshness,
    sources,
  });
  const parsed = parseMemoryFile(resolved.filePath, content);

  if (!parsed.valid) {
    console.log('  Refused to write an invalid advisory memory skeleton.');
    for (const error of parsed.validationErrors) {
      console.log(`  - ${error}`);
    }
    if (parsed.missingFields.length > 0) {
      console.log(`  Missing fields: ${parsed.missingFields.join(', ')}`);
    }
    console.log('');
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(resolved.memoriesDir, { recursive: true });
  await fs.writeFile(resolved.filePath, content, 'utf8');

  console.log(
    `  ${exists ? 'Overwrote' : 'Created'} advisory memory skeleton: ${resolved.filePath}`,
  );
  console.log(`  freshness: ${freshness}\n`);
};
