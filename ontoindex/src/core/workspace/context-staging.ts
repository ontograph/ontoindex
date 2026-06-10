export type StagedContextEntryKind =
  | 'symbol'
  | 'file'
  | 'process'
  | 'diagnostic'
  | 'adr'
  | 'retrieval-result'
  | 'note';

export interface StagedContextLineSpan {
  start: number;
  end?: number;
}

export interface StagedContextEntry {
  kind: StagedContextEntryKind;
  title: string;
  content: string;
  id?: string;
  sourceTool?: string;
  graphUid?: string;
  filePath?: string;
  lineSpan?: StagedContextLineSpan;
  confidence?: number;
  contentHash?: string;
}

export interface StagedContextDiagnostic {
  code:
    | 'staged-context-deduplicated-entry'
    | 'staged-context-max-entries'
    | 'staged-context-max-estimated-bytes';
  message: string;
  truncatedCount?: number;
  maxEntries?: number;
  maxEstimatedBytes?: number;
}

export interface StagedContextLimits {
  maxEntries: number;
  maxEstimatedBytes: number;
}

export interface StagedContextBuildInput {
  entries?: readonly StagedContextEntry[];
  limits?: Partial<StagedContextLimits>;
}

export interface StagedContext {
  readonly entries: readonly StagedContextEntry[];
  readonly limits: StagedContextLimits;
  readonly estimatedBytes: number;
  readonly warnings: readonly StagedContextDiagnostic[];
}

const KIND_ORDER: StagedContextEntryKind[] = [
  'symbol',
  'file',
  'process',
  'diagnostic',
  'adr',
  'retrieval-result',
  'note',
];

const KIND_PRIORITY: Record<StagedContextEntryKind, number> = KIND_ORDER.reduce(
  (acc, kind, index) => {
    acc[kind] = index;
    return acc;
  },
  {} as Record<StagedContextEntryKind, number>,
);

const DEFAULT_LIMITS: StagedContextLimits = {
  maxEntries: 128,
  maxEstimatedBytes: 1_048_576,
};

interface InternalStagedContextEntry extends StagedContextEntry {
  readonly identity: string;
  readonly insertionOrder: number;
  readonly estimatedBytes: number;
}

function normalizeKind(value: unknown): StagedContextEntryKind {
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (KIND_ORDER.includes(lower as StagedContextEntryKind)) {
      return lower as StagedContextEntryKind;
    }
  }
  return 'note';
}

function normalizeText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeLineSpan(lineSpan: unknown): StagedContextLineSpan | undefined {
  if (!lineSpan || typeof lineSpan !== 'object') return undefined;
  const raw = lineSpan as Partial<StagedContextLineSpan>;
  if (typeof raw.start !== 'number' || !Number.isFinite(raw.start)) return undefined;
  const normalizedLineSpan: StagedContextLineSpan = {
    start: Math.trunc(raw.start),
  };
  if (typeof raw.end === 'number' && Number.isFinite(raw.end)) {
    normalizedLineSpan.end = Math.trunc(raw.end);
  }
  return normalizedLineSpan;
}

function stableIdentity(entry: StagedContextEntry): string {
  const trimmedId = normalizeText(entry.id).trim();
  if (trimmedId.length > 0) return `id:${trimmedId}`;

  const trimmedGraphUid = normalizeText(entry.graphUid).trim();
  if (trimmedGraphUid.length > 0) return `graph:${trimmedGraphUid}`;

  const trimmedFilePath = normalizeText(entry.filePath).trim();
  const lineSpan = normalizeLineSpan(entry.lineSpan);
  if (trimmedFilePath.length > 0 && lineSpan && Number.isFinite(lineSpan.start)) {
    const lineEnd = Number.isFinite(lineSpan.end as number) ? lineSpan.end : '';
    return `fileSpan:${trimmedFilePath}#${lineSpan.start}:${lineEnd}`;
  }

  const trimmedContentHash = normalizeText(entry.contentHash).trim();
  if (trimmedContentHash.length > 0) return `content:${trimmedContentHash}`;

  return `fallback:${entry.kind}|${JSON.stringify(normalizeText(entry.title))}|${JSON.stringify(
    normalizeText(entry.content),
  )}`;
}

function estimatedBytes(entry: StagedContextEntry): number {
  const serialized = JSON.stringify({
    kind: entry.kind,
    title: entry.title,
    content: entry.content,
    id: entry.id,
    sourceTool: entry.sourceTool,
    graphUid: entry.graphUid,
    filePath: entry.filePath,
    lineSpan: entry.lineSpan,
    confidence: entry.confidence,
    contentHash: entry.contentHash,
  });
  return new TextEncoder().encode(serialized).length;
}

function resolveLimits(input?: Partial<StagedContextLimits>): StagedContextLimits {
  if (!input) {
    return { ...DEFAULT_LIMITS };
  }

  const maxEntries =
    typeof input.maxEntries === 'number' && Number.isFinite(input.maxEntries)
      ? Math.max(0, Math.trunc(input.maxEntries))
      : DEFAULT_LIMITS.maxEntries;

  const maxEstimatedBytes =
    typeof input.maxEstimatedBytes === 'number' && Number.isFinite(input.maxEstimatedBytes)
      ? Math.max(0, Math.trunc(input.maxEstimatedBytes))
      : DEFAULT_LIMITS.maxEstimatedBytes;

  return { maxEntries, maxEstimatedBytes };
}

export function createStagedContext(input: StagedContextBuildInput = {}): StagedContext {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const limits = resolveLimits(input.limits);
  const warnings: StagedContextDiagnostic[] = [];

  const deduped = new Map<string, InternalStagedContextEntry>();

  for (let insertionOrder = 0; insertionOrder < entries.length; insertionOrder += 1) {
    const raw = entries[insertionOrder];
    if (!raw || typeof raw !== 'object') continue;

    const normalized: StagedContextEntry = {
      kind: normalizeKind((raw as StagedContextEntry).kind),
      title: normalizeText((raw as StagedContextEntry).title),
      content: normalizeText((raw as StagedContextEntry).content),
      id: normalizeText((raw as StagedContextEntry).id),
      sourceTool: normalizeText((raw as StagedContextEntry).sourceTool),
      graphUid: normalizeText((raw as StagedContextEntry).graphUid),
      filePath: normalizeText((raw as StagedContextEntry).filePath),
      lineSpan: normalizeLineSpan((raw as StagedContextEntry).lineSpan),
      confidence:
        typeof (raw as StagedContextEntry).confidence === 'number'
          ? (raw as StagedContextEntry).confidence
          : undefined,
      contentHash: normalizeText((raw as StagedContextEntry).contentHash),
    };

    const identity = stableIdentity(normalized);

    const existing = deduped.get(identity);
    if (!existing) {
      const estimated = estimatedBytes(normalized);
      const enriched: InternalStagedContextEntry = {
        ...normalized,
        identity,
        insertionOrder,
        estimatedBytes: estimated,
      };
      deduped.set(identity, enriched);
      continue;
    }

    warnings.push({
      code: 'staged-context-deduplicated-entry',
      message: `Dropped duplicate staged entry for identity ${identity}.`,
      truncatedCount: 1,
    });
  }

  const sorted = [...deduped.values()].sort((left, right) => {
    const leftKind = KIND_PRIORITY[left.kind];
    const rightKind = KIND_PRIORITY[right.kind];
    if (leftKind !== rightKind) return leftKind - rightKind;

    const identityCmp = left.identity.localeCompare(right.identity);
    if (identityCmp !== 0) return identityCmp;
    return left.insertionOrder - right.insertionOrder;
  });

  const limitedEntries: InternalStagedContextEntry[] = [];
  let observedBytes = 0;
  let droppedByEntries = 0;
  let droppedByBytes = 0;

  for (const entry of sorted) {
    if (limitedEntries.length >= limits.maxEntries) {
      droppedByEntries = sorted.length - limitedEntries.length;
      break;
    }
    if (observedBytes + entry.estimatedBytes > limits.maxEstimatedBytes) {
      droppedByBytes = sorted.length - limitedEntries.length;
      break;
    }
    limitedEntries.push(entry);
    observedBytes += entry.estimatedBytes;
  }

  if (droppedByEntries > 0) {
    warnings.push({
      code: 'staged-context-max-entries',
      message: `Dropped ${droppedByEntries} staged context entries because maxEntries (${limits.maxEntries}) was exceeded.`,
      truncatedCount: droppedByEntries,
      maxEntries: limits.maxEntries,
    });
  }

  if (droppedByBytes > 0) {
    warnings.push({
      code: 'staged-context-max-estimated-bytes',
      message: `Dropped ${droppedByBytes} staged context entries because maxEstimatedBytes (${limits.maxEstimatedBytes}) was exceeded.`,
      truncatedCount: droppedByBytes,
      maxEstimatedBytes: limits.maxEstimatedBytes,
    });
  }

  const publicEntries: StagedContextEntry[] = limitedEntries.map((entry) => {
    const copy: StagedContextEntry = {
      kind: entry.kind,
      title: entry.title,
      content: entry.content,
    };
    if (entry.id) copy.id = entry.id;
    if (entry.sourceTool) copy.sourceTool = entry.sourceTool;
    if (entry.graphUid) copy.graphUid = entry.graphUid;
    if (entry.filePath) copy.filePath = entry.filePath;
    if (entry.lineSpan) copy.lineSpan = entry.lineSpan;
    if (entry.confidence !== undefined) copy.confidence = entry.confidence;
    if (entry.contentHash) copy.contentHash = entry.contentHash;
    return copy;
  });

  return {
    entries: publicEntries,
    limits,
    estimatedBytes: observedBytes,
    warnings,
  };
}

export function buildStagedContext(input: StagedContextBuildInput = {}): StagedContext {
  return createStagedContext(input);
}
