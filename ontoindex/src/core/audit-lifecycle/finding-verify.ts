import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { execFileText } from '../process/exec-file.js';
import {
  evaluateFreshnessGatePolicy,
  projectStatusForFreshnessGate,
  type AuditFreshnessPolicyInput,
} from '../../mcp/shared/freshness-policy.js';
import type {
  AuditClaimDsl,
  AuditEvidenceSource,
  AuditEvidence,
  AuditFinding,
  AuditLifecycleStatus,
  AuditSnapshotMode,
  EvidenceMode,
  ReasonCode,
} from './audit-types.js';
import { findFixHistoryCandidates, type FixHistoryCandidate } from './fix-history.js';
import { validateStatusTransition } from './status-transitions.js';
import {
  classifyTombstoneMatch,
  type AuditTombstoneRecord,
  type TombstoneClassification,
} from './tombstones.js';
import {
  DEFAULT_VERIFIER_CAPABILITIES,
  classifyUnsupportedClaim,
  type VerifierCapability,
} from './verifier-capabilities.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const DEFAULT_VERIFIER_ID = 'audit-lifecycle-core-fresh-evidence';
export const FINDING_VERIFIER_VERSION = '0.1.0';

export interface VerifyFindingOptions {
  repoPath: string;
  finding: AuditFinding;
  now?: Date;
  capabilities?: readonly VerifierCapability[];
  graphIndexId?: string;
  maxTestFiles?: number;
  tombstones?: readonly AuditTombstoneRecord[];
  freshnessPolicy?: AuditFreshnessPolicyInput;
  snapshotMode?: AuditSnapshotMode;
  changedFiles?: readonly string[];
  changedSymbols?: readonly string[];
  staleWarnings?: readonly string[];
}

export interface VerifyFindingResult {
  finding: AuditFinding;
  evidence: AuditEvidence[];
  negativeEvidence: AuditEvidence[];
  comments: AuditEvidence[];
  testMentions: AuditEvidence[];
  fixHistory: FixHistoryCandidate[];
  warnings: ReasonCode[];
}

interface TargetFileSnapshot {
  path: string;
  content: string;
  fileHash: string;
  source: AuditEvidenceSource;
}

interface RelocatedSymbol {
  name: string;
  line: number;
  snippet: string;
}

export async function verifyFindingFreshEvidence(
  options: VerifyFindingOptions,
): Promise<VerifyFindingResult> {
  const finding = options.finding;
  const verifiedAt = (options.now ?? new Date()).toISOString();
  const graphIndexId = options.graphIndexId ?? finding.graphIndexId;
  const snapshotMode = options.snapshotMode ?? 'committed-head';
  const capabilities = options.capabilities ?? DEFAULT_VERIFIER_CAPABILITIES;
  const freshnessDecision = options.freshnessPolicy
    ? evaluateFreshnessGatePolicy({
        ...options.freshnessPolicy,
        evidenceTargetHead: finding.targetHead,
        targetHead: options.freshnessPolicy.targetHead || finding.targetHead,
      })
    : null;
  const runtimeOnly = isRuntimeOnlyFinding(finding);
  const classification = runtimeOnly
    ? {
        supported: false,
        behavior: 'HOLD' as const,
        reasonCodes: ['runtime-required'] satisfies ReasonCode[],
        capability: null,
      }
    : classifyUnsupportedClaim(finding.claimDsl, capabilities);

  if (!classification.supported) {
    const status = classification.behavior;
    const next = applyStatus(finding, {
      status,
      verifiedAt,
      evidence: [],
      negativeEvidence: [],
      reasonCodes: classification.reasonCodes,
      verificationKind: 'unsupported',
      statusReason: `Unsupported verifier claim: ${classification.reasonCodes.join(', ')}`,
      blocker: status === 'HOLD' ? unsupportedBlocker(classification.reasonCodes) : finding.blocker,
      reopenTrigger:
        status === 'HOLD'
          ? {
              kind: 'environment-available',
              detail: 'Re-run when required verification capability is available.',
            }
          : finding.reopenTrigger,
    });
    return {
      finding: next,
      evidence: [],
      negativeEvidence: [],
      comments: [],
      testMentions: [],
      fixHistory: [],
      warnings: classification.reasonCodes,
    };
  }

  const tombstone = options.tombstones?.length
    ? classifyTombstoneMatch(finding, options.tombstones, {
        verifierVersion: FINDING_VERIFIER_VERSION,
        graphIndexId,
      })
    : null;
  if (tombstone?.match && !tombstone.reopenAllowed) {
    const next = applyStatus(finding, {
      status: tombstone.status,
      verifiedAt,
      evidence: [],
      negativeEvidence: tombstone.evidence,
      reasonCodes: tombstone.reasonCodes,
      verificationKind: 'static',
      statusReason: tombstoneStatusReason(tombstone),
      tombstoneMatch: tombstone.match.tombstone.id,
    });
    return {
      finding: next,
      evidence: [],
      negativeEvidence: tombstone.evidence,
      comments: [],
      testMentions: [],
      fixHistory: [],
      warnings: validateStatusTransition({
        from: finding.status,
        to: next.status,
        finding: next,
      }).warnings.map((warning) => warning.code),
    };
  }

  const claim = finding.claimDsl;
  const snapshot = claim?.path
    ? await readFileSnapshot({
        repoPath: options.repoPath,
        targetHead: finding.targetHead,
        filePath: claim.path,
        snapshotMode,
        changedFiles: options.changedFiles ?? [],
      })
    : null;
  const symbol = snapshot && claim?.symbol ? relocateSymbol(snapshot, claim.symbol) : null;
  const evalResult = snapshot
    ? evaluateClaim({
        claim,
        snapshot,
        symbol,
        finding,
        verifiedAt,
        graphIndexId,
        classification,
        freshnessDecision,
        staleWarnings: options.staleWarnings ?? [],
      })
    : missingSnapshotEvidence({
        finding,
        claim,
        verifiedAt,
        graphIndexId,
        freshnessDecision,
        staleWarnings: options.staleWarnings ?? [],
      });
  const commentEvidence = snapshot
    ? searchCommentMentions({
        finding,
        claim,
        snapshot,
        verifiedAt,
        graphIndexId,
        freshnessDecision,
        staleWarnings: options.staleWarnings ?? [],
      })
    : [];
  const testEvidence = await searchTestMentions({
    repoPath: options.repoPath,
    finding,
    claim,
    verifiedAt,
    graphIndexId,
    maxTestFiles: options.maxTestFiles ?? 40,
    freshnessDecision,
    staleWarnings: options.staleWarnings ?? [],
  });
  const history = claim?.path
    ? await findFixHistoryCandidates({
        repoPath: options.repoPath,
        targetHead: finding.targetHead,
        path: claim.path,
        patterns: claimPatterns(claim),
        limit: 10,
      })
    : [];
  const fixEvidence =
    evalResult.positive.length === 0 && history.length > 0
      ? [
          createEvidence({
            finding,
            id: 'fix-history',
            mode: 'git-history',
            polarity: 'fix-proof',
            verifiedAt,
            graphIndexId,
            source: 'git-object',
            sourceFresh: freshnessDecision?.sourceFresh ?? true,
            graphStale: freshnessDecision?.graphStale ?? false,
            staleWarnings: options.staleWarnings,
            path: claim?.path,
            symbol: claim?.symbol,
            confidence: 'medium',
            reasonCodes: ['fix-commit-found'],
            detail: `Git history changed claimed pattern in ${history[0].commit.slice(0, 12)}.`,
            fileHash: snapshot?.fileHash,
          }),
        ]
      : [];

  const negativeEvidence = [...evalResult.negative, ...fixEvidence];
  const allEvidence = [...evalResult.positive, ...commentEvidence, ...testEvidence];
  const status = applyFreshnessPolicyStatus(
    chooseStatus({
      positiveEvidence: evalResult.positive,
      negativeEvidence,
      classificationBehavior: classification.behavior,
    }),
    options.freshnessPolicy,
  );
  const reasonCodes = Array.from(
    new Set<ReasonCode>([
      ...evalResult.reasonCodes,
      ...((freshnessDecision?.reasonCodes ?? []) as ReasonCode[]),
      ...(tombstone?.reopenAllowed ? tombstone.reasonCodes : []),
      ...negativeEvidence.flatMap((evidence) => evidence.reasonCodes),
      ...commentEvidence.flatMap((evidence) => evidence.reasonCodes),
      ...testEvidence.flatMap((evidence) => evidence.reasonCodes),
    ]),
  );
  const next = applyStatus(finding, {
    status,
    verifiedAt,
    evidence: allEvidence,
    negativeEvidence,
    reasonCodes,
    verificationKind: 'static',
    fixCommit: fixEvidence.length > 0 ? history[0].commit : finding.fixCommit,
    statusReason: statusReason(status, reasonCodes, allEvidence, negativeEvidence),
    tombstoneMatch: tombstone?.match?.tombstone.id ?? finding.tombstoneMatch,
  });

  return {
    finding: next,
    evidence: allEvidence,
    negativeEvidence,
    comments: commentEvidence,
    testMentions: testEvidence,
    fixHistory: history,
    warnings: validateStatusTransition({
      from: finding.status,
      to: next.status,
      finding: next,
    }).warnings.map((warning) => warning.code),
  };
}

async function readFileSnapshot(input: {
  repoPath: string;
  targetHead: string;
  filePath: string;
  snapshotMode: AuditSnapshotMode;
  changedFiles: readonly string[];
}): Promise<TargetFileSnapshot | null> {
  if (
    input.snapshotMode === 'dirty-worktree-overlay' &&
    (input.changedFiles.length === 0 || input.changedFiles.includes(input.filePath))
  ) {
    const overlay = await readFileFromWorktree(input.repoPath, input.filePath);
    if (overlay !== null) return overlay;
  }
  return readFileAtHead(input.repoPath, input.targetHead, input.filePath);
}

async function readFileAtHead(
  repoPath: string,
  targetHead: string,
  filePath: string,
): Promise<TargetFileSnapshot | null> {
  try {
    const content = await execFileText('git', ['show', `${targetHead}:${filePath}`], {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return {
      path: filePath,
      content,
      fileHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      source: 'git-object',
    };
  } catch {
    return null;
  }
}

async function readFileFromWorktree(
  repoPath: string,
  filePath: string,
): Promise<TargetFileSnapshot | null> {
  const absolute = path.resolve(repoPath, filePath);
  const root = path.resolve(repoPath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  try {
    const content = await fs.readFile(absolute, 'utf8');
    return {
      path: filePath,
      content,
      fileHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      source: 'filesystem',
    };
  } catch {
    return null;
  }
}

function relocateSymbol(snapshot: TargetFileSnapshot, symbolName: string): RelocatedSymbol | null {
  const lines = snapshot.content.split('\n');
  const matcher = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
  const index = lines.findIndex((line) => matcher.test(line));
  if (index < 0) return null;
  const start = Math.max(0, index - 2);
  const end = Math.min(lines.length, index + 3);
  return {
    name: symbolName,
    line: index + 1,
    snippet: lines.slice(start, end).join('\n'),
  };
}

function evaluateClaim(input: {
  claim: AuditClaimDsl | null;
  snapshot: TargetFileSnapshot;
  symbol: RelocatedSymbol | null;
  finding: AuditFinding;
  verifiedAt: string;
  graphIndexId: string;
  classification: ReturnType<typeof classifyUnsupportedClaim>;
  freshnessDecision: ReturnType<typeof evaluateFreshnessGatePolicy> | null;
  staleWarnings: readonly string[];
}): { positive: AuditEvidence[]; negative: AuditEvidence[]; reasonCodes: ReasonCode[] } {
  const claim = input.claim;
  if (!claim) {
    return { positive: [], negative: [], reasonCodes: ['unsupported-claim-kind'] };
  }

  const haystack = codeOnly(input.symbol?.snippet ?? input.snapshot.content);
  const calls = stringList(claim.pattern?.calls);
  const missingAny = stringList(claim.pattern?.missing_any);
  const cleanupAny = [
    ...stringList(claim.pattern?.cleanup_any),
    ...stringList(claim.pattern?.release_any),
  ];
  const positiveMatches = calls.filter((pattern) => includesToken(haystack, pattern));
  const missingMitigations = missingAny.filter((pattern) => !includesToken(haystack, pattern));
  const missingCleanup =
    cleanupAny.length > 0 && cleanupAny.every((pattern) => !includesToken(haystack, pattern));
  const line = input.symbol?.line ?? firstPatternLine(input.snapshot.content, positiveMatches);

  if (
    claim.kind === 'forbidden-call-pattern' &&
    positiveMatches.length > 0 &&
    (missingAny.length === 0 || missingMitigations.length > 0)
  ) {
    return {
      positive: [
        createEvidence({
          finding: input.finding,
          id: 'positive-pattern',
          mode: evidenceMode(claim),
          polarity: 'positive',
          verifiedAt: input.verifiedAt,
          graphIndexId: input.graphIndexId,
          source: input.snapshot.source,
          sourceFresh:
            input.snapshot.source === 'filesystem' ? true : input.freshnessDecision?.sourceFresh,
          graphStale: input.freshnessDecision?.graphStale,
          staleWarnings: input.staleWarnings,
          path: input.snapshot.path,
          line,
          symbol: input.symbol?.name ?? claim.symbol,
          confidence: input.symbol ? 'high' : 'medium',
          reasonCodes: ['fresh-positive-evidence'],
          detail: `Found ${positiveMatches.join(', ')} without required mitigation ${missingMitigations.join(', ') || 'n/a'}.`,
          fileHash: input.snapshot.fileHash,
        }),
      ],
      negative: [],
      reasonCodes: ['fresh-positive-evidence'],
    };
  }

  if (
    (claim.kind === 'missing-cleanup' || claim.kind === 'resource-leak') &&
    positiveMatches.length > 0 &&
    missingCleanup
  ) {
    return {
      positive: [
        createEvidence({
          finding: input.finding,
          id: 'positive-cleanup',
          mode: evidenceMode(claim),
          polarity: 'positive',
          verifiedAt: input.verifiedAt,
          graphIndexId: input.graphIndexId,
          source: input.snapshot.source,
          sourceFresh:
            input.snapshot.source === 'filesystem' ? true : input.freshnessDecision?.sourceFresh,
          graphStale: input.freshnessDecision?.graphStale,
          staleWarnings: input.staleWarnings,
          path: input.snapshot.path,
          line,
          symbol: input.symbol?.name ?? claim.symbol,
          confidence: input.symbol ? 'high' : 'medium',
          reasonCodes: ['fresh-positive-evidence'],
          detail: `Found ${positiveMatches.join(', ')} without cleanup ${cleanupAny.join(', ')}.`,
          fileHash: input.snapshot.fileHash,
        }),
      ],
      negative: [],
      reasonCodes: ['fresh-positive-evidence'],
    };
  }

  return {
    positive: [],
    negative: [
      createEvidence({
        finding: input.finding,
        id: 'negative-pattern',
        mode: evidenceMode(claim),
        polarity: 'negative',
        verifiedAt: input.verifiedAt,
        graphIndexId: input.graphIndexId,
        source: input.snapshot.source,
        sourceFresh:
          input.snapshot.source === 'filesystem' ? true : input.freshnessDecision?.sourceFresh,
        graphStale: input.freshnessDecision?.graphStale,
        staleWarnings: input.staleWarnings,
        path: input.snapshot.path,
        line: input.symbol?.line,
        symbol: input.symbol?.name ?? claim.symbol,
        confidence: 'medium',
        reasonCodes: ['fresh-negative-evidence'],
        detail: 'Claimed positive pattern was not found at the locked target HEAD.',
        fileHash: input.snapshot.fileHash,
      }),
    ],
    reasonCodes: ['fresh-negative-evidence'],
  };
}

function missingSnapshotEvidence(input: {
  finding: AuditFinding;
  claim: AuditClaimDsl | null;
  verifiedAt: string;
  graphIndexId: string;
  freshnessDecision: ReturnType<typeof evaluateFreshnessGatePolicy> | null;
  staleWarnings: readonly string[];
}): { positive: AuditEvidence[]; negative: AuditEvidence[]; reasonCodes: ReasonCode[] } {
  return {
    positive: [],
    negative: [
      createEvidence({
        finding: input.finding,
        id: 'missing-target-file',
        mode: 'ast',
        polarity: 'negative',
        verifiedAt: input.verifiedAt,
        graphIndexId: input.graphIndexId,
        source: 'git-object',
        sourceFresh: input.freshnessDecision?.sourceFresh,
        graphStale: input.freshnessDecision?.graphStale,
        staleWarnings: input.staleWarnings,
        path: input.claim?.path,
        symbol: input.claim?.symbol,
        confidence: 'medium',
        reasonCodes: ['fresh-negative-evidence'],
        detail: 'Claimed file is absent at the locked target HEAD.',
      }),
    ],
    reasonCodes: ['fresh-negative-evidence'],
  };
}

function searchCommentMentions(input: {
  finding: AuditFinding;
  claim: AuditClaimDsl | null;
  snapshot: TargetFileSnapshot;
  verifiedAt: string;
  graphIndexId: string;
  freshnessDecision: ReturnType<typeof evaluateFreshnessGatePolicy> | null;
  staleWarnings: readonly string[];
}): AuditEvidence[] {
  const terms = searchTerms(input.finding, input.claim);
  if (terms.length === 0) return [];
  const lines = input.snapshot.content.split('\n');
  const index = lines.findIndex(
    (line) => isCommentLine(line) && terms.some((term) => line.includes(term)),
  );
  if (index < 0) return [];
  return [
    createEvidence({
      finding: input.finding,
      id: 'comment-mention',
      mode: 'manual-review',
      polarity: 'positive',
      verifiedAt: input.verifiedAt,
      graphIndexId: input.graphIndexId,
      source: input.snapshot.source,
      sourceFresh:
        input.snapshot.source === 'filesystem' ? true : input.freshnessDecision?.sourceFresh,
      graphStale: input.freshnessDecision?.graphStale,
      staleWarnings: input.staleWarnings,
      path: input.snapshot.path,
      line: index + 1,
      symbol: input.claim?.symbol,
      confidence: 'low',
      reasonCodes: ['partial-verification'],
      detail: 'Comment mention may corroborate the claimed audit finding.',
      fileHash: input.snapshot.fileHash,
    }),
  ];
}

async function searchTestMentions(input: {
  repoPath: string;
  finding: AuditFinding;
  claim: AuditClaimDsl | null;
  verifiedAt: string;
  graphIndexId: string;
  maxTestFiles: number;
  freshnessDecision: ReturnType<typeof evaluateFreshnessGatePolicy> | null;
  staleWarnings: readonly string[];
}): Promise<AuditEvidence[]> {
  const terms = searchTerms(input.finding, input.claim);
  if (terms.length === 0) return [];
  const paths = await listFilesAtHead(input.repoPath, input.finding.targetHead);
  const testFiles = paths.filter(isTestPath).slice(0, input.maxTestFiles);
  for (const testPath of testFiles) {
    const snapshot = await readFileAtHead(input.repoPath, input.finding.targetHead, testPath);
    if (!snapshot) continue;
    const lineIndex = snapshot.content
      .split('\n')
      .findIndex((line) => terms.some((term) => line.includes(term)));
    if (lineIndex >= 0) {
      return [
        createEvidence({
          finding: input.finding,
          id: 'test-mention',
          mode: 'test',
          polarity: 'positive',
          verifiedAt: input.verifiedAt,
          graphIndexId: input.graphIndexId,
          source: snapshot.source,
          sourceFresh:
            snapshot.source === 'filesystem' ? true : input.freshnessDecision?.sourceFresh,
          graphStale: input.freshnessDecision?.graphStale,
          staleWarnings: input.staleWarnings,
          path: testPath,
          line: lineIndex + 1,
          symbol: input.claim?.symbol,
          confidence: 'low',
          reasonCodes: ['partial-verification'],
          detail: 'Test mention found for claimed audit finding.',
          fileHash: snapshot.fileHash,
        }),
      ];
    }
  }
  return [];
}

async function listFilesAtHead(repoPath: string, targetHead: string): Promise<string[]> {
  try {
    const output = await execFileText('git', ['ls-tree', '-r', '--name-only', targetHead], {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function chooseStatus(input: {
  positiveEvidence: readonly AuditEvidence[];
  negativeEvidence: readonly AuditEvidence[];
  classificationBehavior: 'NEEDS-VERIFY' | 'HOLD';
}): AuditLifecycleStatus {
  if (input.positiveEvidence.some((evidence) => evidence.polarity === 'positive')) return 'OPEN';
  if (
    input.negativeEvidence.some((evidence) =>
      ['negative', 'fix-proof', 'tombstone-proof'].includes(evidence.polarity),
    )
  ) {
    return 'RESOLVED-ALREADY';
  }
  return input.classificationBehavior;
}

function applyFreshnessPolicyStatus(
  status: AuditLifecycleStatus,
  policy: AuditFreshnessPolicyInput | undefined,
): AuditLifecycleStatus {
  if (policy === undefined) return status;
  const decision = evaluateFreshnessGatePolicy(policy);
  return projectStatusForFreshnessGate(status, decision) as AuditLifecycleStatus;
}

function applyStatus(
  finding: AuditFinding,
  input: {
    status: AuditLifecycleStatus;
    verifiedAt: string;
    evidence: AuditEvidence[];
    negativeEvidence: AuditEvidence[];
    reasonCodes: ReasonCode[];
    verificationKind: AuditFinding['verificationKind'];
    statusReason: string;
    fixCommit?: string | null;
    blocker?: AuditFinding['blocker'];
    reopenTrigger?: AuditFinding['reopenTrigger'];
    tombstoneMatch?: string | null;
  },
): AuditFinding {
  const candidate = {
    ...finding,
    status: input.status,
    verifiedEvidence: input.evidence,
    negativeEvidence: input.negativeEvidence,
    reasonCodes: Array.from(new Set(input.reasonCodes)),
    statusReason: input.statusReason,
    fixCommit: input.fixCommit ?? finding.fixCommit,
    verificationKind: input.verificationKind,
    verifiedAt: input.verifiedAt,
    verifiedHead: finding.targetHead,
    statusChangedAt: input.verifiedAt,
    statusChangedBy: 'ontoindex',
    statusTransitionEvidence: [...input.evidence, ...input.negativeEvidence],
    blocker: input.blocker ?? finding.blocker,
    reopenTrigger: input.reopenTrigger ?? finding.reopenTrigger,
    tombstoneMatch: input.tombstoneMatch ?? finding.tombstoneMatch,
    confidence: confidenceScore(input.evidence, input.negativeEvidence),
  };
  const projection = validateStatusTransition({
    from: finding.status,
    to: candidate.status,
    finding: candidate,
  });
  return {
    ...candidate,
    status: projection.status,
    reasonCodes: Array.from(new Set([...candidate.reasonCodes, ...projection.reasonCodes])),
  };
}

function createEvidence(input: {
  finding: AuditFinding;
  id: string;
  mode: EvidenceMode;
  polarity: AuditEvidence['polarity'];
  verifiedAt: string;
  graphIndexId: string;
  source?: AuditEvidenceSource;
  sourceFresh?: boolean;
  graphStale?: boolean;
  staleWarnings?: readonly string[];
  confidence: AuditEvidence['confidence'];
  reasonCodes: ReasonCode[];
  detail: string;
  path?: string;
  line?: number;
  symbol?: string;
  fileHash?: string;
}): AuditEvidence {
  return {
    id: `${input.finding.findingId}:${input.id}`,
    mode: input.mode,
    polarity: input.polarity,
    targetHead: input.finding.targetHead,
    verifiedHead: input.finding.targetHead,
    verifiedAt: input.verifiedAt,
    verifierId: DEFAULT_VERIFIER_ID,
    verifierVersion: FINDING_VERIFIER_VERSION,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.sourceFresh !== undefined ? { sourceFresh: input.sourceFresh } : {}),
    ...(input.graphStale !== undefined ? { graphStale: input.graphStale } : {}),
    ...(input.staleWarnings !== undefined && input.staleWarnings.length > 0
      ? { staleWarnings: [...input.staleWarnings] }
      : {}),
    confidence: input.confidence,
    reasonCodes: input.reasonCodes,
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
    detail: input.detail,
    graphIndexId: input.graphIndexId,
    ...(input.fileHash !== undefined ? { fileHash: input.fileHash } : {}),
  };
}

function evidenceMode(claim: AuditClaimDsl): EvidenceMode {
  return claim.evidenceMode ?? 'ast';
}

function claimPatterns(claim: AuditClaimDsl): string[] {
  return [
    ...stringList(claim.pattern?.calls),
    ...stringList(claim.pattern?.missing_any),
    ...stringList(claim.pattern?.cleanup_any),
    ...stringList(claim.pattern?.release_any),
  ];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function includesToken(value: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegex(token)}\\b`).test(value);
}

function firstPatternLine(content: string, patterns: readonly string[]): number | undefined {
  if (patterns.length === 0) return undefined;
  const lines = content.split('\n');
  const index = lines.findIndex((line) => patterns.some((pattern) => includesToken(line, pattern)));
  return index >= 0 ? index + 1 : undefined;
}

function searchTerms(finding: AuditFinding, claim: AuditClaimDsl | null): string[] {
  return Array.from(
    new Set(
      [
        claim?.id,
        claim?.symbol,
        ...claimPatterns(claim ?? { id: '', kind: '' }),
        ...finding.claimedEvidence.flatMap((item) =>
          item.split(/\W+/).filter((part) => part.length >= 5),
        ),
      ].filter((item): item is string => typeof item === 'string' && item.length >= 3),
    ),
  );
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.includes('//')
  );
}

function codeOnly(content: string): string {
  return content
    .split('\n')
    .filter((line) => !isCommentLine(line))
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec)(\/|$)|(\.|-)(test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

function statusReason(
  status: AuditLifecycleStatus,
  reasonCodes: readonly ReasonCode[],
  evidence: readonly AuditEvidence[],
  negativeEvidence: readonly AuditEvidence[],
): string {
  const source = evidence[0]?.source ?? negativeEvidence[0]?.source;
  const sourcePrefix = source === undefined ? '' : `${source} `;
  if (status === 'OPEN')
    return `Fresh positive ${sourcePrefix}evidence exists at the locked target HEAD.`;
  if (status === 'RESOLVED-ALREADY') {
    return `Fresh negative ${sourcePrefix}evidence or fix history contradicts the copied finding.`;
  }
  if (status === 'HOLD') return 'Verification is blocked by unsupported runtime or external proof.';
  return `Verification incomplete: ${reasonCodes.join(', ')}`;
}

function tombstoneStatusReason(tombstone: TombstoneClassification): string {
  if (tombstone.status === 'RESOLVED-ALREADY') {
    return 'Active tombstone invariant still holds at the locked target HEAD.';
  }
  return 'Matched tombstone requires re-verification before the finding can reopen.';
}

function confidenceScore(
  evidence: readonly AuditEvidence[],
  negativeEvidence: readonly AuditEvidence[],
): number {
  const all = [...evidence, ...negativeEvidence];
  if (all.some((item) => item.confidence === 'high')) return 0.9;
  if (all.some((item) => item.confidence === 'medium')) return 0.65;
  if (all.length > 0) return 0.35;
  return 0;
}

function unsupportedBlocker(reasonCodes: readonly ReasonCode[]): AuditFinding['blocker'] {
  return {
    kind: reasonCodes.includes('runtime-required') ? 'runtime-required' : 'human-decision',
    detail: `Verifier cannot complete this claim automatically: ${reasonCodes.join(', ')}`,
  };
}

function isRuntimeOnlyFinding(finding: AuditFinding): boolean {
  if (finding.claimDsl?.requiresRuntime || finding.claimDsl?.evidenceMode === 'runtime')
    return true;
  if (finding.verificationKind === 'runtime') return true;
  if (finding.reasonCodes.includes('runtime-required')) return true;
  if (finding.verifiedEvidence.some((evidence) => evidence.mode === 'runtime')) return true;
  return hasRuntimeOnlyHeuristic(
    [
      finding.title,
      finding.statusReason,
      finding.claimedEvidence.join('\n'),
      finding.claimDsl?.kind,
      finding.claimDsl?.risk,
      JSON.stringify(finding.claimDsl?.pattern ?? {}),
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
