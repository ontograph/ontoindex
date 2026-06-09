import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildAuditProjection } from '../audit-lifecycle/audit-projection.js';
import { LocalAuditEventStore } from '../audit-lifecycle/audit-event-store.js';
import type { AuditFinding, AuditSession } from '../audit-lifecycle/audit-session.js';
import {
  scanPrMarkersNearPath,
  type AuditPrMarkerScanResult,
} from '../audit-lifecycle/pr-marker-scan.js';

export type ConsolidatedMemoryEvidenceClass = 'advisory_memory' | 'authoritative_memory';
export type ConsolidatedMemoryAuthority = 'advisory' | 'authoritative';
export type ConsolidatedMemoryFreshness = 'fresh' | 'unknown' | 'stale-index';
export type ConsolidatedMemoryMode = ConsolidatedMemoryAuthority;
export type AuthoritativeMemoryDenyReason =
  | 'missing-freshness-signal'
  | 'stale-target-context'
  | 'stale-audit-projection'
  | 'missing-authority-metadata';
export type ConsolidatedMemoryFreshnessSignalState =
  | 'clean'
  | 'fresh'
  | 'dirty'
  | 'stale'
  | 'partial'
  | 'unknown';

export interface ConsolidatedMemoryFreshnessSignal {
  state: ConsolidatedMemoryFreshnessSignalState;
  checkedAt?: string;
  warnings?: readonly string[];
}

export interface ConsolidatedMemoryAuthorityInput {
  source?: 'explicit-fresh-target-context' | 'local-freshness-signal';
  freshness?: ConsolidatedMemoryFreshnessSignal;
}

export interface ConsolidateMemoryOptions {
  mode?: ConsolidatedMemoryMode;
  authority?: ConsolidatedMemoryAuthorityInput;
}

export interface ConsolidatedMemoryTrust {
  evidenceClass: ConsolidatedMemoryEvidenceClass;
  authority: ConsolidatedMemoryAuthority;
  requestedAuthority: ConsolidatedMemoryAuthority;
  freshness: ConsolidatedMemoryFreshness;
  notAuditEvidence: boolean;
  source: 'audit-event-store-projection';
  authoritySource?: ConsolidatedMemoryAuthorityInput['source'];
  freshnessSignal?: ConsolidatedMemoryFreshnessSignal;
  warnings: string[];
}

export interface ConsolidatedMemory {
  rebuiltAt: string;
  trust: ConsolidatedMemoryTrust;
  auditFindings: {
    open: AuditFinding[];
    partial: AuditFinding[];
  };
  prMarkers: AuditPrMarkerScanResult[];
}

export class AuthoritativeMemoryDeniedError extends Error {
  constructor(
    public readonly reason: AuthoritativeMemoryDenyReason,
    public readonly warnings: readonly string[],
  ) {
    super(`Authoritative memory mode denied: ${reason}`);
    this.name = 'AuthoritativeMemoryDeniedError';
  }
}

export class ConsolidatedMemoryManager {
  private readonly memoryPath: string;
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.memoryPath = path.join(repoRoot, '.ontoindex', 'memory', 'consolidated-memory.json');
  }

  async consolidate(options: ConsolidateMemoryOptions = {}): Promise<ConsolidatedMemory> {
    const { auditFindings, sessions } = await this.getAuditFindings();
    const trust = buildMemoryTrust(sessions, auditFindings, options);
    if (options.mode === 'authoritative' && trust.authoritativeDenyReason) {
      throw new AuthoritativeMemoryDeniedError(trust.authoritativeDenyReason, trust.warnings);
    }
    const prMarkers = await this.getPrMarkers(auditFindings);

    const memory: ConsolidatedMemory = {
      rebuiltAt: new Date().toISOString(),
      trust,
      auditFindings,
      prMarkers,
    };

    await this.save(memory);
    return memory;
  }

  private async getAuditFindings(): Promise<{
    auditFindings: { open: AuditFinding[]; partial: AuditFinding[] };
    sessions: AuditSession[];
  }> {
    const store = new LocalAuditEventStore(this.repoRoot);
    const state = await store.load();
    const projection = buildAuditProjection(state.events);

    return {
      auditFindings: {
        open: projection.findings.filter((finding) => finding.status === 'OPEN'),
        partial: projection.findings.filter((finding) => finding.status === 'PARTIAL'),
      },
      sessions: projection.sessions,
    };
  }

  private async getPrMarkers(findings: {
    open: AuditFinding[];
    partial: AuditFinding[];
  }): Promise<AuditPrMarkerScanResult[]> {
    const results: AuditPrMarkerScanResult[] = [];
    const allFindings = [...findings.open, ...findings.partial];

    // De-duplicate file/line combinations to avoid redundant scans
    const toScan = new Map<string, Set<number>>();
    for (const finding of allFindings) {
      for (const evidence of finding.evidence) {
        const filePath = (evidence.data?.path as string) || (evidence as any).path;
        const line = (evidence.data?.line as number) || (evidence as any).line;
        if (filePath && line) {
          if (!toScan.has(filePath)) {
            toScan.set(filePath, new Set());
          }
          toScan.get(filePath)!.add(line);
        }
      }
    }

    for (const [filePath, lines] of toScan) {
      for (const line of lines) {
        try {
          const result = await scanPrMarkersNearPath({
            filePath: path.join(this.repoRoot, filePath),
            displayFile: filePath,
            evidenceLine: line,
          });
          if (result.markers.length > 0) {
            results.push(result);
          }
        } catch (error) {
          // Skip files that might have been deleted or other read errors
        }
      }
    }

    return results;
  }

  private async save(memory: ConsolidatedMemory): Promise<void> {
    const dir = path.dirname(this.memoryPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.memoryPath, JSON.stringify(memory, null, 2), 'utf8');
  }

  async load(): Promise<ConsolidatedMemory | null> {
    try {
      const data = await fs.readFile(this.memoryPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Returns a summary of the consolidated memory for display in help.
   */
  async getSummary(): Promise<Record<string, unknown> | null> {
    const memory = await this.load();
    if (!memory) return null;

    return {
      rebuiltAt: memory.rebuiltAt,
      auditFindings: {
        openCount: memory.auditFindings.open.length,
        partialCount: memory.auditFindings.partial.length,
      },
      trust: memory.trust,
      prMarkerCount: memory.prMarkers.reduce((sum, res) => sum + res.markers.length, 0),
    };
  }
}

function buildMemoryTrust(
  sessions: readonly AuditSession[],
  findings: { open: readonly AuditFinding[]; partial: readonly AuditFinding[] },
  options: ConsolidateMemoryOptions = {},
): ConsolidatedMemoryTrust & { authoritativeDenyReason?: AuthoritativeMemoryDenyReason } {
  const requestedAuthority = options.mode ?? 'advisory';
  const warnings = new Set<string>();
  const allFindings = [...findings.open, ...findings.partial];
  const stale = hasStaleSignals(sessions, allFindings);
  const authoritativeDenyReason =
    requestedAuthority === 'authoritative'
      ? getAuthoritativeMemoryDenyReason({
          sessions,
          findings: allFindings,
          freshnessSignal: options.authority?.freshness,
          stale,
        })
      : undefined;

  if (requestedAuthority === 'advisory' || authoritativeDenyReason) {
    warnings.add(
      'Consolidated memory is advisory context only and is not authoritative graph, docs, or audit evidence.',
    );
  }

  if (sessions.length === 0 && allFindings.length > 0) {
    warnings.add('No audit session metadata was available for the consolidated findings.');
  }
  if (stale) {
    warnings.add(
      'Audit projection includes stale session or evidence metadata; reverify before acting.',
    );
  }
  if (authoritativeDenyReason) {
    warnings.add(`Authoritative memory mode denied: ${authoritativeDenyReason}.`);
  }

  const authority: ConsolidatedMemoryAuthority =
    requestedAuthority === 'authoritative' && !authoritativeDenyReason
      ? 'authoritative'
      : 'advisory';

  return {
    evidenceClass: authority === 'authoritative' ? 'authoritative_memory' : 'advisory_memory',
    authority,
    requestedAuthority,
    freshness: authority === 'authoritative' ? 'fresh' : stale ? 'stale-index' : 'unknown',
    notAuditEvidence: authority !== 'authoritative',
    source: 'audit-event-store-projection',
    authoritySource: authority === 'authoritative' ? options.authority?.source : undefined,
    freshnessSignal: options.authority?.freshness,
    warnings: [...warnings].sort(),
    authoritativeDenyReason,
  };
}

function getAuthoritativeMemoryDenyReason(input: {
  sessions: readonly AuditSession[];
  findings: readonly AuditFinding[];
  freshnessSignal?: ConsolidatedMemoryFreshnessSignal;
  stale: boolean;
}): AuthoritativeMemoryDenyReason | undefined {
  if (!input.freshnessSignal) return 'missing-freshness-signal';
  if (!isFreshMemorySignal(input.freshnessSignal)) return 'stale-target-context';
  if (input.stale) return 'stale-audit-projection';
  if (input.findings.length > 0 && input.sessions.length === 0) {
    return 'missing-authority-metadata';
  }
  return undefined;
}

function isFreshMemorySignal(signal: ConsolidatedMemoryFreshnessSignal): boolean {
  return (
    (signal.state === 'clean' || signal.state === 'fresh') && (signal.warnings?.length ?? 0) === 0
  );
}

function hasStaleSignals(
  sessions: readonly AuditSession[],
  findings: readonly AuditFinding[],
): boolean {
  return (
    sessions.some(
      (session) =>
        session.snapshotMode === 'dirty-worktree-overlay' ||
        (session.staleWarnings?.length ?? 0) > 0 ||
        (session.snapshot?.staleWarnings.length ?? 0) > 0,
    ) ||
    findings.some((finding) =>
      finding.evidence.some(
        (evidence) =>
          evidence.graphStale === true ||
          evidence.sourceFresh === false ||
          (evidence.staleWarnings?.length ?? 0) > 0,
      ),
    )
  );
}
