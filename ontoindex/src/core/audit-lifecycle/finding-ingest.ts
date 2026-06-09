import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  AuditClaimDsl,
  AuditFinding,
  AuditFreshness,
  AuditSeverity,
  ReasonCode,
} from './audit-types.js';
import {
  createFindingFingerprint,
  hashAuditSource,
  normalizeFindingText,
  type LayeredFindingFingerprint,
} from './finding-fingerprint.js';
import { computeAuditFreshness, type AuditFreshnessMetadata } from './freshness.js';
import { matchTombstoneByFingerprint, type AuditTombstoneRecord } from './tombstones.js';

export interface AuditFindingIngestInput {
  repoPath: string;
  targetRepo?: string;
  targetRef?: string;
  sourcePath?: string;
  sourceText?: string;
  graphIndexId?: string;
  now?: Date;
  tombstones?: readonly AuditTombstoneRecord[];
}

export interface CandidateDuplicateChild {
  rawIndex: number;
  title: string;
  claimedEvidence: string[];
  sourceLine?: number;
  lineOnlyEvidence: boolean;
}

export type CandidateAuditFinding = AuditFinding & {
  rawIndex: number;
  sourceLine?: number;
  exactDuplicateKey: string;
  evidenceQuality: {
    lineOnly: boolean;
    sufficientForOpen: false;
    reason: 'line-only-evidence' | 'candidate-ingest-only';
  };
  duplicateChildren: CandidateDuplicateChild[];
};

export interface AuditFindingIngestResult {
  sessionId: string;
  targetRepo: string;
  targetRef: string;
  targetHead: string;
  sourcePath: string;
  sourceHash: string;
  ingestedAt: string;
  graphIndexId: string;
  rawCount: number;
  dedupedCount: number;
  duplicatesCollapsed: number;
  duplicateGroups: Array<{
    fingerprint: string;
    parentFindingId: string;
    childCount: number;
  }>;
  freshness: AuditFreshness;
  freshnessMetadata: AuditFreshnessMetadata;
  findings: CandidateAuditFinding[];
}

interface RawFindingCandidate {
  rawIndex: number;
  sourceLine?: number;
  title: string;
  severity: AuditSeverity;
  summary: string;
  claimedEvidence: string[];
  path?: string;
  line?: number;
  symbol?: string;
  claimDsl: AuditClaimDsl | null;
  lineOnlyEvidence: boolean;
}

export async function ingestAuditFindings(
  input: AuditFindingIngestInput,
): Promise<AuditFindingIngestResult> {
  const source = await readAuditSource(input);
  const sourceHash = hashAuditSource(source.text);
  const freshnessMetadata = await computeAuditFreshness(input.repoPath, {
    ref: input.targetRef,
    now: input.now,
  });
  const targetHead = freshnessMetadata.targetHead.commit;
  const targetRef = freshnessMetadata.targetHead.ref;
  const ingestedAt = (input.now ?? new Date()).toISOString();
  const graphIndexId =
    input.graphIndexId ?? `git:${freshnessMetadata.targetHead.shortCommit}:audit-lifecycle:m2`;
  const targetRepo = input.targetRepo ?? path.basename(freshnessMetadata.targetHead.gitRoot);
  const rawCandidates = parseMarkdownCandidates(source.text);
  const deduped = dedupeCandidates({
    candidates: rawCandidates,
    targetHead,
    sourceHash,
    sourcePath: source.path,
    ingestedAt,
    graphIndexId,
    targetRepo,
    targetRef,
    dirtyWorktree: freshnessMetadata.state === 'dirty',
    tombstones: input.tombstones ?? [],
  });

  return {
    sessionId: `audit-session-${hashAuditSource(
      [targetRepo, targetHead, sourceHash].join('\n'),
    ).slice(7, 19)}`,
    targetRepo,
    targetRef,
    targetHead,
    sourcePath: source.path,
    sourceHash,
    ingestedAt,
    graphIndexId,
    rawCount: rawCandidates.length,
    dedupedCount: deduped.findings.length,
    duplicatesCollapsed: rawCandidates.length - deduped.findings.length,
    duplicateGroups: deduped.duplicateGroups,
    freshness: {
      targetHead,
      verifiedHead: null,
      verifiedAt: null,
      graphIndexId,
      workingTreeDirtyAtVerify: freshnessMetadata.state === 'dirty',
    },
    freshnessMetadata,
    findings: deduped.findings,
  };
}

async function readAuditSource(
  input: AuditFindingIngestInput,
): Promise<{ text: string; path: string }> {
  if (input.sourceText !== undefined) {
    return { text: input.sourceText, path: input.sourcePath ?? '<pasted>' };
  }
  if (!input.sourcePath) {
    throw new Error('sourceText or sourcePath is required for audit ingest');
  }
  return { text: await fs.readFile(input.sourcePath, 'utf8'), path: input.sourcePath };
}

function parseMarkdownCandidates(text: string): RawFindingCandidate[] {
  const lines = text.split(/\r?\n/);
  const sections: Array<{ title: string; line: number; body: string[] }> = [];
  let current: { title: string; line: number; body: string[] } | undefined;

  lines.forEach((line, index) => {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: cleanupTitle(heading[2]), line: index + 1, body: [] };
      return;
    }
    current?.body.push(line);
  });
  if (current) sections.push(current);

  const candidates = sections
    .filter((section) => !isContainerHeading(section.title))
    .map((section, index) => candidateFromSection(section, index))
    .filter((candidate) => candidate.title.length > 0);

  if (candidates.length > 0) return candidates;

  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^[-*]\s+/.test(line) && line.trim().length > 3)
    .map(({ line, index }, rawIndex) =>
      candidateFromText(cleanupTitle(line.replace(/^[-*]\s+/, '')), rawIndex, index + 1),
    );
}

function candidateFromSection(
  section: { title: string; line: number; body: string[] },
  rawIndex: number,
): RawFindingCandidate {
  const body = section.body.join('\n');
  const pathLine = extractPathLine(`${section.title}\n${body}`);
  const evidence = extractEvidenceLines(section.body);
  const summary = normalizeFindingText(body).slice(0, 400);
  const title = stripNumberPrefix(section.title);
  const claim = evidence[0] ?? summary ?? title;

  return {
    rawIndex,
    sourceLine: section.line,
    title,
    severity: extractSeverity(body),
    summary,
    claimedEvidence: evidence.length > 0 ? evidence : [claim],
    path: pathLine.path,
    line: pathLine.line,
    symbol: extractField(body, 'symbol'),
    claimDsl: buildClaimDsl({ rawIndex, title, claim, pathLine }),
    lineOnlyEvidence: isLineOnlyEvidence(evidence, pathLine),
  };
}

function candidateFromText(
  title: string,
  rawIndex: number,
  sourceLine: number,
): RawFindingCandidate {
  const pathLine = extractPathLine(title);
  return {
    rawIndex,
    sourceLine,
    title,
    severity: extractSeverity(title),
    summary: normalizeFindingText(title),
    claimedEvidence: [title],
    path: pathLine.path,
    line: pathLine.line,
    claimDsl: buildClaimDsl({ rawIndex, title, claim: title, pathLine }),
    lineOnlyEvidence: isLineOnlyEvidence([title], pathLine),
  };
}

function dedupeCandidates(input: {
  candidates: RawFindingCandidate[];
  targetHead: string;
  sourceHash: string;
  sourcePath: string;
  ingestedAt: string;
  graphIndexId: string;
  targetRepo: string;
  targetRef: string;
  dirtyWorktree: boolean;
  tombstones: readonly AuditTombstoneRecord[];
}): {
  findings: CandidateAuditFinding[];
  duplicateGroups: AuditFindingIngestResult['duplicateGroups'];
} {
  const byExact = new Map<string, CandidateAuditFinding>();
  const duplicateGroups = new Map<string, AuditFindingIngestResult['duplicateGroups'][number]>();

  for (const candidate of input.candidates) {
    const layered = createFindingFingerprint({
      title: candidate.title,
      claim: candidate.claimedEvidence.join('\n'),
      path: candidate.path,
      line: candidate.line,
      symbol: candidate.symbol,
      targetHead: input.targetHead,
      sourceHash: input.sourceHash,
    });
    const existing = byExact.get(layered.exactKey);
    if (existing) {
      existing.duplicateChildren.push(toDuplicateChild(candidate));
      const group = duplicateGroups.get(layered.exactKey) ?? {
        fingerprint: layered.exactKey,
        parentFindingId: existing.findingId,
        childCount: 0,
      };
      group.childCount += 1;
      duplicateGroups.set(layered.exactKey, group);
      continue;
    }
    byExact.set(layered.exactKey, toFinding(candidate, layered, input));
  }

  return {
    findings: [...byExact.values()],
    duplicateGroups: [...duplicateGroups.values()],
  };
}

function toFinding(
  candidate: RawFindingCandidate,
  layered: LayeredFindingFingerprint,
  input: {
    targetHead: string;
    sourceHash: string;
    sourcePath: string;
    ingestedAt: string;
    graphIndexId: string;
    targetRepo: string;
    targetRef: string;
    dirtyWorktree: boolean;
    tombstones: readonly AuditTombstoneRecord[];
  },
): CandidateAuditFinding {
  const tombstoneMatch = matchTombstoneByFingerprint(
    { fingerprint: layered.fingerprint },
    input.tombstones,
  );
  const reasonCodes: ReasonCode[] = candidate.lineOnlyEvidence ? ['missing-status-proof'] : [];
  if (tombstoneMatch) reasonCodes.push('tombstone-match');
  if (isRuntimeOnlyText(candidate)) reasonCodes.push('runtime-required');

  return {
    findingId: layered.stableId,
    title: candidate.title,
    severity: candidate.severity,
    status: isRuntimeOnlyText(candidate)
      ? 'HOLD'
      : tombstoneMatch
        ? 'NEEDS-REVERIFY'
        : 'NEEDS-VERIFY',
    source: {
      path: input.sourcePath,
      hash: input.sourceHash,
      ingestedAt: input.ingestedAt,
      dirtyWorktree: input.dirtyWorktree,
    },
    targetRepo: input.targetRepo,
    targetRef: input.targetRef,
    targetHead: input.targetHead,
    graphIndexId: input.graphIndexId,
    claimedEvidence: candidate.claimedEvidence,
    verifiedEvidence: [],
    negativeEvidence: [],
    statusReason: ingestStatusReason(candidate, tombstoneMatch !== null),
    fixCommit: null,
    confidence: 0,
    reasonCodes,
    fingerprint: layered.fingerprint,
    claimDsl: candidate.claimDsl,
    verificationKind: isRuntimeOnlyText(candidate) ? 'runtime' : 'unsupported',
    verifiedAt: null,
    verifiedHead: null,
    statusChangedAt: null,
    statusChangedBy: 'ontoindex',
    statusTransitionEvidence: [],
    reopenTrigger: isRuntimeOnlyText(candidate)
      ? {
          kind: 'environment-available',
          detail: 'Re-run when runtime verification evidence is available.',
        }
      : null,
    blocker: isRuntimeOnlyText(candidate)
      ? {
          kind: 'runtime-required',
          detail:
            'Claim depends on runtime, telemetry, host, privileged container, load, or race-under-load evidence.',
        }
      : null,
    tombstoneMatch: tombstoneMatch?.tombstone.id ?? null,
    rawIndex: candidate.rawIndex,
    sourceLine: candidate.sourceLine,
    exactDuplicateKey: layered.exactKey,
    evidenceQuality: {
      lineOnly: candidate.lineOnlyEvidence,
      sufficientForOpen: false,
      reason: candidate.lineOnlyEvidence ? 'line-only-evidence' : 'candidate-ingest-only',
    },
    duplicateChildren: [],
  };
}

function toDuplicateChild(candidate: RawFindingCandidate): CandidateDuplicateChild {
  return {
    rawIndex: candidate.rawIndex,
    title: candidate.title,
    claimedEvidence: candidate.claimedEvidence,
    sourceLine: candidate.sourceLine,
    lineOnlyEvidence: candidate.lineOnlyEvidence,
  };
}

function extractEvidenceLines(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter(
      (line) => /^[-*]\s+/.test(line) || /^(evidence|claim|path|file|line|symbol):/i.test(line),
    )
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function extractPathLine(text: string): { path?: string; line?: number } {
  const fieldPath = extractField(text, 'path') ?? extractField(text, 'file');
  const fieldLine = extractField(text, 'line');
  const inline =
    /([\w./-]+\.(?:c|cc|cpp|cxx|h|hpp|ts|tsx|js|jsx|py|rs|go|java|kt|swift)):(\d+)/i.exec(text);
  return {
    path: fieldPath ?? inline?.[1],
    line: fieldLine
      ? Number.parseInt(fieldLine, 10)
      : inline
        ? Number.parseInt(inline[2], 10)
        : undefined,
  };
}

function extractField(text: string, field: string): string | undefined {
  const match = new RegExp(`^\\s*(?:[-*]\\s*)?${field}:\\s*(.+?)\\s*$`, 'im').exec(text);
  return match?.[1]?.trim();
}

function extractSeverity(text: string): AuditSeverity {
  const value = extractField(text, 'severity')?.toUpperCase();
  if (value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL') {
    return value;
  }
  return 'MEDIUM';
}

function buildClaimDsl(input: {
  rawIndex: number;
  title: string;
  claim: string;
  pathLine: { path?: string; line?: number };
}): AuditClaimDsl {
  const runtimeOnly = hasRuntimeOnlyHeuristic(`${input.title}\n${input.claim}`);
  return {
    id: `ingested-claim-${input.rawIndex + 1}`,
    kind: 'missing-guard',
    evidenceMode: runtimeOnly ? 'runtime' : 'manual-review',
    path: input.pathLine.path,
    requiresRuntime: runtimeOnly,
    pattern: {
      title: input.title,
      claim: input.claim,
      line: input.pathLine.line,
    },
  };
}

function ingestStatusReason(candidate: RawFindingCandidate, tombstoneMatched: boolean): string {
  if (isRuntimeOnlyText(candidate)) {
    return 'Runtime-only candidate is on HOLD until runtime evidence is available.';
  }
  if (tombstoneMatched) {
    return 'Candidate matches an existing tombstone; explicit invariant failure is required before reopening.';
  }
  if (candidate.lineOnlyEvidence) {
    return 'Candidate ingest retained line-only evidence; verification is required before OPEN.';
  }
  return 'Candidate ingest only; verification is required before OPEN.';
}

function isRuntimeOnlyText(candidate: RawFindingCandidate): boolean {
  return hasRuntimeOnlyHeuristic(
    [
      candidate.title,
      candidate.summary,
      candidate.claimedEvidence.join('\n'),
      candidate.claimDsl?.risk,
      JSON.stringify(candidate.claimDsl?.pattern ?? {}),
    ]
      .filter((item): item is string => typeof item === 'string')
      .join('\n'),
  );
}

function hasRuntimeOnlyHeuristic(value: string): boolean {
  return /\b(runtime|telemetry|cgroup(?:s)?|host behavior|privileged container|load-only|race under load|under load)\b/i.test(
    value,
  );
}

function isLineOnlyEvidence(
  evidence: readonly string[],
  pathLine: { path?: string; line?: number },
): boolean {
  return (
    evidence.length > 0 &&
    pathLine.path !== undefined &&
    pathLine.line !== undefined &&
    evidence.every((item) => normalizeFindingText(item) === `${pathLine.path}:${pathLine.line}`)
  );
}

function cleanupTitle(title: string | undefined): string {
  return (title ?? '').replace(/\s+#+\s*$/, '').trim();
}

function stripNumberPrefix(title: string): string {
  return title.replace(/^\s*(?:finding\s*)?\d+[\).:-]\s*/i, '').trim();
}

function isContainerHeading(title: string): boolean {
  return /^(findings?|summary|overview|appendix|recommendations?)$/i.test(stripNumberPrefix(title));
}
