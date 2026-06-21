export interface ReadFirstFileFact {
  filePath?: unknown;
  reason?: unknown;
  source?: unknown;
  priority?: unknown;
}

export interface ReadFirstFile {
  filePath: string;
  reason: string;
  source: string;
}

export interface ReadFirstProjection {
  readFirstFiles: ReadFirstFile[];
  omittedCounts: {
    invalid: number;
    duplicate: number;
    truncated: number;
    total: number;
  };
}

export interface ReadFirstProjectionOptions {
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 5;

const SOURCE_PRIORITY = new Map<string, number>([
  ['definition', 0],
  ['primary', 0],
  ['entrypoint', 0],
  ['file', 1],
  ['module', 1],
  ['caller', 2],
  ['callers', 2],
  ['callee', 2],
  ['callees', 2],
  ['cluster', 3],
  ['community', 3],
  ['docs', 4],
  ['doc', 4],
  ['other', 5],
  ['unknown', 6],
]);

interface RankedReadFirstFile extends ReadFirstFile {
  priority: number;
  inputIndex: number;
}

export function projectReadFirstFiles(
  facts: readonly ReadFirstFileFact[] = [],
  options: ReadFirstProjectionOptions = {},
): ReadFirstProjection {
  const maxFiles = normalizePositiveInt(options.maxFiles, DEFAULT_MAX_FILES);
  const omittedCounts = {
    invalid: 0,
    duplicate: 0,
    truncated: 0,
    total: 0,
  };

  const ranked: RankedReadFirstFile[] = [];
  for (const [inputIndex, fact] of facts.entries()) {
    const filePath = normalizeText(fact?.filePath);
    if (!filePath) {
      omittedCounts.invalid += 1;
      continue;
    }

    const source = normalizeText(fact?.source, 'unknown');
    const reason = normalizeText(fact?.reason, source || 'read-first candidate');
    ranked.push({
      filePath,
      reason,
      source,
      priority: normalizePriority(fact?.priority, source, inputIndex),
      inputIndex,
    });
  }

  ranked.sort(compareReadFirstFile);

  const selected: ReadFirstFile[] = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    if (seen.has(item.filePath)) {
      omittedCounts.duplicate += 1;
      continue;
    }
    seen.add(item.filePath);
    if (selected.length >= maxFiles) {
      omittedCounts.truncated += 1;
      continue;
    }
    selected.push({
      filePath: item.filePath,
      reason: item.reason,
      source: item.source,
    });
  }

  omittedCounts.total = omittedCounts.invalid + omittedCounts.duplicate + omittedCounts.truncated;

  return {
    readFirstFiles: selected,
    omittedCounts,
  };
}

function compareReadFirstFile(left: RankedReadFirstFile, right: RankedReadFirstFile): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  const bySource = left.source.localeCompare(right.source);
  if (bySource !== 0) return bySource;

  const byPath = left.filePath.localeCompare(right.filePath);
  if (byPath !== 0) return byPath;

  return left.inputIndex - right.inputIndex;
}

function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text.length > 0 ? text : fallback;
}

function normalizePriority(value: unknown, source: string, inputIndex: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return (SOURCE_PRIORITY.get(source) ?? SOURCE_PRIORITY.get('unknown') ?? 99) + inputIndex / 1000;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  const normalized = Math.floor(value ?? NaN);
  return normalized > 0 ? normalized : fallback;
}
