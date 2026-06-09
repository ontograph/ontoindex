/**
 * Advisory project memory parser — SERENA-D3
 *
 * Parses and validates markdown files from .ontoindex/memories/ against the
 * ADR 0021 front matter contract. Memories are advisory only and must never
 * drive audit status decisions (not_audit_evidence: true is required).
 */

import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';

/** Required front matter fields per ADR 0021 § Advisory project memories. */
export const REQUIRED_MEMORY_FIELDS = [
  'version',
  'repo',
  'created_at',
  'source_commit',
  'indexed_commit',
  'freshness',
  'kind',
  'not_audit_evidence',
  'sources',
] as const;

export type RequiredMemoryField = (typeof REQUIRED_MEMORY_FIELDS)[number];

export interface MemoryFrontMatter {
  version?: string | number;
  repo?: string;
  created_at?: string;
  source_commit?: string;
  indexed_commit?: string;
  freshness?: string;
  kind?: string;
  not_audit_evidence?: boolean | string;
  sources?: string[];
  [key: string]: unknown;
}

export interface ParsedMemory {
  filePath: string;
  fileName: string;
  /** True only when all required front matter fields are present. */
  valid: boolean;
  missingFields: string[];
  invalidFields: string[];
  validationErrors: string[];
  frontMatter: MemoryFrontMatter;
  body: string;
  sizeBytes?: number;
}

export interface NormalizedMemoryName {
  fileName: string;
  stem: string;
}

export interface ResolvedMemoryPath extends NormalizedMemoryName {
  memoriesDir: string;
  filePath: string;
}

export interface LoadedMemory {
  content: string | null;
  memory: ParsedMemory;
}

export const MEMORIES_DIR = '.ontoindex/memories';
export const MAX_MEMORY_FILE_SIZE_BYTES = 64 * 1024;
export const CANONICAL_MEMORY_FRESHNESS = ['fresh', 'stale-index', 'unknown'] as const;

const URL_LIKE_NAME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function buildInvalidMemory(
  filePath: string,
  fileName: string,
  validationErrors: string[],
  options: {
    frontMatter?: MemoryFrontMatter;
    body?: string;
    missingFields?: string[];
    invalidFields?: string[];
    sizeBytes?: number;
  } = {},
): ParsedMemory {
  return {
    filePath,
    fileName,
    valid: false,
    missingFields: options.missingFields ?? [],
    invalidFields: options.invalidFields ?? [],
    validationErrors,
    frontMatter: options.frontMatter ?? {},
    body: options.body ?? '',
    sizeBytes: options.sizeBytes,
  };
}

function pushValidationError(
  invalidFields: string[],
  validationErrors: string[],
  field: string,
  reason: string,
): void {
  if (!invalidFields.includes(field)) {
    invalidFields.push(field);
  }
  if (!validationErrors.includes(reason)) {
    validationErrors.push(reason);
  }
}

export function normalizeMemoryFreshness(value: unknown): string | undefined {
  if (value === 'current') {
    return 'fresh';
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  return CANONICAL_MEMORY_FRESHNESS.includes(value as (typeof CANONICAL_MEMORY_FRESHNESS)[number])
    ? value
    : undefined;
}

export function normalizeMemoryName(
  rawName: string,
  options: { allowImplicitMarkdown?: boolean } = {},
): NormalizedMemoryName {
  const allowImplicitMarkdown = options.allowImplicitMarkdown ?? true;
  let candidate = rawName.trim();

  if (candidate === '') {
    throw new Error('Memory name is required');
  }
  if (CONTROL_CHARS.test(candidate)) {
    throw new Error('Memory name contains control characters');
  }
  if (candidate.startsWith('/') || candidate.startsWith('\\') || path.isAbsolute(candidate)) {
    throw new Error('Memory name must not be absolute');
  }
  if (candidate.startsWith('//') || URL_LIKE_NAME.test(candidate)) {
    throw new Error('Memory name must not be URL-like');
  }
  if (candidate.includes('/') || candidate.includes('\\')) {
    throw new Error('Memory name must be a direct child of .ontoindex/memories/');
  }

  if (!candidate.endsWith('.md')) {
    if (!allowImplicitMarkdown) {
      throw new Error('Memory name must end with .md');
    }
    if (path.extname(candidate) !== '') {
      throw new Error('Memory name must refer to a Markdown file');
    }
    candidate = `${candidate}.md`;
  }

  if (!candidate.endsWith('.md')) {
    throw new Error('Memory name must end with .md');
  }
  if (path.basename(candidate) !== candidate) {
    throw new Error('Memory name must not include path segments');
  }
  if (candidate.startsWith('.')) {
    throw new Error('Memory name must not be hidden');
  }

  const stem = candidate.slice(0, -3);
  if (stem === '' || stem === '.' || stem === '..') {
    throw new Error('Memory name must have a visible basename');
  }

  return { fileName: candidate, stem };
}

export function resolveMemoryPath(
  repoPath: string,
  rawName: string,
  options: { allowImplicitMarkdown?: boolean } = {},
): ResolvedMemoryPath {
  const normalized = normalizeMemoryName(rawName, options);
  const memoriesDir = path.resolve(repoPath, MEMORIES_DIR);
  const filePath = path.resolve(memoriesDir, normalized.fileName);
  const relativePath = path.relative(memoriesDir, filePath);

  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath) ||
    path.dirname(relativePath) !== '.'
  ) {
    throw new Error('Memory path escapes .ontoindex/memories/');
  }

  return {
    ...normalized,
    memoriesDir,
    filePath,
  };
}

async function readResolvedMemoryFile(resolved: ResolvedMemoryPath): Promise<LoadedMemory | null> {
  let stat;
  try {
    stat = await fs.stat(resolved.filePath);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    return {
      content: null,
      memory: buildInvalidMemory(
        resolved.filePath,
        resolved.fileName,
        [`Could not stat memory file: ${(error as Error).message}`],
        { invalidFields: ['file'] },
      ),
    };
  }

  if (!stat.isFile()) {
    return {
      content: null,
      memory: buildInvalidMemory(
        resolved.filePath,
        resolved.fileName,
        ['Memory path is not a file'],
        {
          invalidFields: ['file'],
          sizeBytes: stat.size,
        },
      ),
    };
  }

  if (stat.size > MAX_MEMORY_FILE_SIZE_BYTES) {
    return {
      content: null,
      memory: buildInvalidMemory(
        resolved.filePath,
        resolved.fileName,
        [`Memory file exceeds ${MAX_MEMORY_FILE_SIZE_BYTES} bytes`],
        { invalidFields: ['file'], sizeBytes: stat.size },
      ),
    };
  }

  try {
    const content = await fs.readFile(resolved.filePath, 'utf8');
    const memory = parseMemoryFile(resolved.filePath, content);
    memory.sizeBytes = stat.size;
    return { content, memory };
  } catch (error: unknown) {
    return {
      content: null,
      memory: buildInvalidMemory(
        resolved.filePath,
        resolved.fileName,
        [`Could not read memory file: ${(error as Error).message}`],
        { invalidFields: ['file'], sizeBytes: stat.size },
      ),
    };
  }
}

/**
 * Parse YAML-style front matter from a markdown string.
 * Supports scalar values, booleans, integers, and flat lists (- item).
 */
export function parseMemoryFrontMatter(content: string): {
  frontMatter: MemoryFrontMatter;
  body: string;
} {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontMatter: {}, body: content };
  }

  const raw: Record<string, unknown> = {};
  let endIndex = lines.length;
  let currentListKey: string | undefined;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') {
      endIndex = i + 1;
      break;
    }
    const listMatch = /^\s+-\s+(.+)$/.exec(line);
    if (listMatch && currentListKey) {
      const arr = (raw[currentListKey] as string[] | undefined) ?? [];
      arr.push(listMatch[1]!.trim());
      raw[currentListKey] = arr;
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kvMatch) {
      currentListKey = undefined;
      const key = kvMatch[1]!;
      const rawVal = kvMatch[2]!.trim();
      if (rawVal === '') {
        currentListKey = key;
        raw[key] = [];
      } else if (rawVal === 'true') {
        raw[key] = true;
      } else if (rawVal === 'false') {
        raw[key] = false;
      } else if (/^\d+$/.test(rawVal)) {
        raw[key] = parseInt(rawVal, 10);
      } else {
        raw[key] = rawVal.replace(/^['"]|['"]$/g, '');
      }
      continue;
    }
    currentListKey = undefined;
  }

  const body = lines.slice(endIndex).join('\n');
  return { frontMatter: raw as MemoryFrontMatter, body };
}

/**
 * Parse and validate a single memory file's content against the ADR 0021 contract.
 */
export function parseMemoryFile(filePath: string, content: string): ParsedMemory {
  const { frontMatter, body } = parseMemoryFrontMatter(content);
  const fileName = path.basename(filePath);
  const invalidFields: string[] = [];
  const validationErrors: string[] = [];

  const missingFields = REQUIRED_MEMORY_FIELDS.filter((field) =>
    field === 'sources'
      ? frontMatter.sources === undefined
      : frontMatter[field] === undefined || frontMatter[field] === '',
  );

  if (frontMatter.not_audit_evidence !== undefined && frontMatter.not_audit_evidence !== true) {
    pushValidationError(
      invalidFields,
      validationErrors,
      'not_audit_evidence',
      'not_audit_evidence must be the boolean true',
    );
  }

  if (frontMatter.sources !== undefined) {
    if (!Array.isArray(frontMatter.sources)) {
      pushValidationError(
        invalidFields,
        validationErrors,
        'sources',
        'sources must be a non-empty list of strings',
      );
    } else {
      const normalizedSources = frontMatter.sources
        .filter((source): source is string => typeof source === 'string')
        .map((source) => source.trim())
        .filter((source) => source !== '');

      frontMatter.sources = normalizedSources;
      if (normalizedSources.length === 0) {
        pushValidationError(
          invalidFields,
          validationErrors,
          'sources',
          'sources must include at least one non-empty entry',
        );
      }
    }
  }

  if (frontMatter.freshness !== undefined) {
    const canonicalFreshness = normalizeMemoryFreshness(frontMatter.freshness);
    if (!canonicalFreshness) {
      pushValidationError(
        invalidFields,
        validationErrors,
        'freshness',
        `freshness must be one of ${CANONICAL_MEMORY_FRESHNESS.join(', ')} or compatibility alias current`,
      );
    } else {
      frontMatter.freshness = canonicalFreshness;
    }
  }

  return {
    filePath,
    fileName,
    valid: missingFields.length === 0 && invalidFields.length === 0,
    missingFields,
    invalidFields,
    validationErrors,
    frontMatter,
    body,
  };
}

/**
 * Load all .md files from .ontoindex/memories/ under the given repo root.
 * Returns an empty array when the directory does not exist.
 */
export async function loadMemories(repoPath: string): Promise<ParsedMemory[]> {
  const memoriesDir = path.resolve(repoPath, MEMORIES_DIR);
  let entries: Dirent<string>[] = [];
  try {
    entries = await fs.readdir(memoriesDir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }

  const memories: ParsedMemory[] = [];
  for (const entry of entries
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    let resolved: ResolvedMemoryPath;
    try {
      resolved = resolveMemoryPath(repoPath, entry.name, { allowImplicitMarkdown: false });
    } catch (error: unknown) {
      memories.push(
        buildInvalidMemory(
          path.resolve(memoriesDir, entry.name),
          entry.name,
          [(error as Error).message],
          {
            invalidFields: ['file'],
          },
        ),
      );
      continue;
    }

    const loaded = await readResolvedMemoryFile(resolved);
    if (loaded) {
      memories.push(loaded.memory);
    }
  }
  return memories;
}

export async function loadMemory(
  repoPath: string,
  memoryName: string,
): Promise<LoadedMemory | null> {
  let resolved: ResolvedMemoryPath;
  try {
    resolved = resolveMemoryPath(repoPath, memoryName);
  } catch (error: unknown) {
    return {
      content: null,
      memory: buildInvalidMemory(memoryName, memoryName, [(error as Error).message], {
        invalidFields: ['file'],
      }),
    };
  }

  return readResolvedMemoryFile(resolved);
}
