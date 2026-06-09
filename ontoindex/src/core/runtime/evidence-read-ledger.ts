import { createHash } from 'node:crypto';
import path from 'node:path';

export const EVIDENCE_READ_CLASSES = [
  'graph_evidence',
  'docs_evidence',
  'audit_evidence',
  'advisory_memory',
  'runtime_diagnostic',
  'unknown',
] as const;

export type EvidenceReadClass = (typeof EVIDENCE_READ_CLASSES)[number];

export const NON_AUTHORITATIVE_EVIDENCE_READ_CLASSES = [
  'advisory_memory',
  'runtime_diagnostic',
] as const satisfies readonly EvidenceReadClass[];

export function createEmptyEvidenceReadClassCounts(): Record<EvidenceReadClass, number> {
  return Object.fromEntries(EVIDENCE_READ_CLASSES.map((readClass) => [readClass, 0])) as Record<
    EvidenceReadClass,
    number
  >;
}

export type EvidenceReadTargetType = string;

export interface EvidenceReadEventInput {
  readClass: EvidenceReadClass;
  surface: string;
  target: string;
  targetType: EvidenceReadTargetType;
  tool?: string;
  repo?: string;
  sessionId?: string;
  memoryFreshness?: string;
  isSensitive?: boolean;
  notAuditEvidence?: boolean;
}

export interface EvidenceReadEvent {
  eventId: number;
  timestamp: number;
  readClass: EvidenceReadClass;
  surface: string;
  target: string;
  targetType: EvidenceReadTargetType;
  tool?: string;
  repo?: string;
  sessionIdHash?: string;
  freshness: string;
  memoryFreshness?: string;
  notAuditEvidence?: boolean;
}

export interface EvidenceReadSummary {
  total: number;
  byClass: Record<EvidenceReadClass, number>;
  bySurface: Record<string, number>;
  byRepo: Record<string, number>;
  recentTargets: EvidenceReadEvent[];
  droppedOverCap: number;
  recorderErrors: number;
}

export interface BasedOnReadsSummary {
  graph_evidence: number;
  docs_evidence: number;
  audit_evidence: number;
  advisory_memory: number;
  runtime_diagnostic: number;
  unknown: number;
  stale: boolean;
  degraded: boolean;
  advisory_memory_stale_index: boolean;
  advisory_memory_not_audit_evidence: boolean;
  details?: {
    staleSurfaces: string[];
    degradedSurfaces: string[];
  };
}

export const EVIDENCE_READ_LEDGER_CAPACITY = 1000;
const TARGET_LENGTH_CAP = 256;

export class EvidenceReadLedger {
  private events: EvidenceReadEvent[] = [];
  private nextEventId = 1;
  private droppedOverCap = 0;
  private recorderErrors = 0;
  private readonly capacity: number;

  constructor(capacity = EVIDENCE_READ_LEDGER_CAPACITY) {
    this.capacity = capacity;
  }

  public record(input: EvidenceReadEventInput): void {
    try {
      if (this.events.length >= this.capacity) {
        this.events.shift();
        this.droppedOverCap++;
      }

      const { freshness, memoryFreshness } = mapMemoryFreshness(input.memoryFreshness);

      const event: EvidenceReadEvent = {
        eventId: this.nextEventId++,
        timestamp: Date.now(),
        readClass: input.readClass,
        surface: input.surface,
        target: sanitizeTarget(input.target, { isSensitive: input.isSensitive }),
        targetType: input.targetType,
        tool: input.tool,
        repo: input.repo,
        sessionIdHash: input.sessionId ? hashSessionId(input.sessionId) : undefined,
        freshness,
        memoryFreshness,
        notAuditEvidence: input.notAuditEvidence,
      };

      this.events.push(event);
    } catch (err) {
      this.recorderErrors++;
    }
  }

  public getSummary(options?: { limitRecent?: number; repo?: string }): EvidenceReadSummary {
    const limitRecent = options?.limitRecent ?? 50;
    const repoFilter = options?.repo;

    const byClass = createEmptyEvidenceReadClassCounts();
    const bySurface: Record<string, number> = {};
    const byRepo: Record<string, number> = {};

    const filteredEvents = repoFilter
      ? this.events.filter((e) => e.repo === repoFilter)
      : this.events;

    for (const event of filteredEvents) {
      byClass[event.readClass] = (byClass[event.readClass] || 0) + 1;
      bySurface[event.surface] = (bySurface[event.surface] || 0) + 1;
      if (event.repo) {
        byRepo[event.repo] = (byRepo[event.repo] || 0) + 1;
      }
    }

    return {
      total: filteredEvents.length,
      byClass,
      bySurface,
      byRepo,
      recentTargets: [...filteredEvents.slice(-limitRecent)],
      droppedOverCap: this.droppedOverCap,
      recorderErrors: this.recorderErrors,
    };
  }

  public getEvents(): EvidenceReadEvent[] {
    return [...this.events];
  }

  public reset(): void {
    this.events = [];
    this.nextEventId = 1;
    this.droppedOverCap = 0;
    this.recorderErrors = 0;
  }
}

// Process-local default instance
export const defaultEvidenceReadLedger = new EvidenceReadLedger();

export function recordEvidenceReadSafe(input: EvidenceReadEventInput): void {
  try {
    defaultEvidenceReadLedger.record(input);
  } catch {
    // Fail-open: ignore errors in recording
  }
}

export function resetEvidenceReadLedgerForTests(): void {
  defaultEvidenceReadLedger.reset();
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').substring(0, 16);
}

export function sanitizeTarget(target: string, options?: { isSensitive?: boolean }): string {
  if (options?.isSensitive) {
    return '[REDACTED]';
  }
  let sanitized = target;
  if (path.isAbsolute(sanitized)) {
    sanitized = '[ABSOLUTE_PATH]:' + path.basename(sanitized);
  }
  if (sanitized.length > TARGET_LENGTH_CAP) {
    sanitized = sanitized.substring(0, TARGET_LENGTH_CAP - 3) + '...';
  }
  return sanitized;
}

export function mapMemoryFreshness(memoryFreshness?: string): {
  freshness: string;
  memoryFreshness?: string;
} {
  switch (memoryFreshness) {
    case 'fresh':
      return { freshness: 'fresh', memoryFreshness: 'fresh' };
    case 'stale-index':
      return { freshness: 'stale', memoryFreshness: 'stale-index' };
    case 'unknown':
    case undefined:
      return { freshness: 'unknown', memoryFreshness: 'unknown' };
    case 'invalid':
      return { freshness: 'degraded', memoryFreshness: 'unknown' };
    default:
      return { freshness: 'unknown', memoryFreshness: memoryFreshness || 'unknown' };
  }
}

export function summarizeBasedOnReads(options?: {
  repo?: string;
  ledger?: EvidenceReadLedger;
}): BasedOnReadsSummary {
  const ledger = options?.ledger ?? defaultEvidenceReadLedger;
  const repoFilter = options?.repo;
  const events = ledger.getEvents();
  const summary: BasedOnReadsSummary = {
    ...createEmptyEvidenceReadClassCounts(),
    stale: false,
    degraded: false,
    advisory_memory_stale_index: false,
    advisory_memory_not_audit_evidence: false,
    details: {
      staleSurfaces: [],
      degradedSurfaces: [],
    },
  };

  const filteredEvents = repoFilter ? events.filter((e) => e.repo === repoFilter) : events;

  for (const event of filteredEvents) {
    summary[event.readClass]++;
    if (event.freshness === 'stale') {
      summary.stale = true;
      if (!summary.details!.staleSurfaces.includes(event.surface)) {
        summary.details!.staleSurfaces.push(event.surface);
      }
    }
    if (event.freshness === 'degraded') {
      summary.degraded = true;
      if (!summary.details!.degradedSurfaces.includes(event.surface)) {
        summary.details!.degradedSurfaces.push(event.surface);
      }
    }
    if (event.memoryFreshness === 'stale-index') summary.advisory_memory_stale_index = true;
    if (event.readClass === 'advisory_memory' && event.notAuditEvidence) {
      summary.advisory_memory_not_audit_evidence = true;
    }
  }

  return summary;
}
