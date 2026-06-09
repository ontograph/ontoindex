export type AuditLifecycleStatus =
  | 'OPEN'
  | 'RESOLVED-ALREADY'
  | 'PARTIAL'
  | 'FALSE-POSITIVE'
  | 'NEEDS-VERIFY'
  | 'DECISION-GATED'
  | 'HOLD'
  | 'NEEDS-REVERIFY';

export type AuditSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type VerificationKind =
  | 'static'
  | 'dynamic'
  | 'runtime'
  | 'manual'
  | 'hybrid'
  | 'unsupported';

export type ClaimKind =
  | 'forbidden-call-pattern'
  | 'missing-cleanup'
  | 'unchecked-return'
  | 'missing-state-transition'
  | 'missing-guard'
  | 'missing-test'
  | 'resource-leak';

export type EvidenceMode =
  | 'ast'
  | 'call-graph'
  | 'dataflow'
  | 'resource-lifecycle'
  | 'test'
  | 'runtime'
  | 'git-history'
  | 'tombstone'
  | 'manual-review';

export type AuditSnapshotMode = 'committed-head' | 'dirty-worktree-overlay' | 'diff-ref';

export type AuditEvidenceSource = 'graph' | 'filesystem' | 'git-object' | 'sidecar' | 'runtime';

export type EvidencePolarity = 'positive' | 'negative' | 'fix-proof' | 'tombstone-proof';

export type Confidence = 'low' | 'medium' | 'high';

export type ReasonCode =
  | 'fresh-positive-evidence'
  | 'fresh-negative-evidence'
  | 'fix-commit-found'
  | 'tombstone-match'
  | 'unsupported-claim-kind'
  | 'unsupported-language'
  | 'unsupported-evidence-mode'
  | 'runtime-required'
  | 'external-blocker'
  | 'stale-evidence'
  | 'target-head-mismatch'
  | 'dirty-worktree'
  | 'partial-verification'
  | 'decision-required'
  | 'missing-reopen-trigger'
  | 'missing-blocker-metadata'
  | 'missing-status-proof';

export interface AuditFreshness {
  targetHead: string;
  verifiedHead: string | null;
  verifiedAt: string | null;
  graphIndexId: string;
  snapshotMode?: AuditSnapshotMode;
  sidecarStateHash?: string;
  workingTreeDirtyAtVerify: boolean;
}

export interface AuditEvidence {
  id: string;
  mode: EvidenceMode;
  polarity: EvidencePolarity;
  targetHead: string;
  verifiedHead: string;
  verifiedAt: string;
  verifierId: string;
  verifierVersion: string;
  source?: AuditEvidenceSource;
  sourceFresh?: boolean;
  graphStale?: boolean;
  staleWarnings?: string[];
  confidence: Confidence;
  reasonCodes: ReasonCode[];
  path?: string;
  line?: number;
  symbol?: string;
  detail: string;
  graphIndexId?: string;
  fileHash?: string;
}

export interface AuditClaimDsl {
  id: string;
  kind: ClaimKind | string;
  language?: string;
  evidenceMode?: EvidenceMode;
  symbol?: string;
  path?: string;
  risk?: string;
  pattern?: Record<string, unknown>;
  requiresRuntime?: boolean;
}

export interface AuditFingerprint {
  location: string;
  claim: string;
  history?: string;
}

export interface AuditFindingSource {
  path: string;
  hash: string;
  ingestedAt: string;
  dirtyWorktree: boolean;
}

export interface AuditReopenTrigger {
  kind:
    | 'commit-change'
    | 'file-change'
    | 'symbol-change'
    | 'environment-available'
    | 'decision-made';
  detail: string;
}

export interface AuditBlocker {
  kind: 'runtime-required' | 'external-system' | 'credentials' | 'human-decision';
  owner?: string;
  requiredEnvironment?: string;
  detail: string;
}

export interface AuditDecisionGate {
  owner: string;
  unblockCondition: string;
}

export interface AuditFinding {
  findingId: string;
  title: string;
  severity: AuditSeverity;
  status: AuditLifecycleStatus;
  source: AuditFindingSource;
  targetRepo: string;
  targetRef?: string;
  targetHead: string;
  graphIndexId: string;
  claimedEvidence: string[];
  verifiedEvidence: AuditEvidence[];
  negativeEvidence: AuditEvidence[];
  statusReason: string;
  fixCommit: string | null;
  confidence: number;
  reasonCodes: ReasonCode[];
  fingerprint: AuditFingerprint;
  claimDsl: AuditClaimDsl | null;
  verificationKind: VerificationKind;
  verifiedAt: string | null;
  verifiedHead: string | null;
  statusChangedAt: string | null;
  statusChangedBy: 'ontoindex' | 'human' | string;
  statusTransitionEvidence: AuditEvidence[];
  reopenTrigger: AuditReopenTrigger | null;
  blocker: AuditBlocker | null;
  decisionGate?: AuditDecisionGate;
  tombstoneMatch: string | null;
}

export interface AuditSession {
  sessionId: string;
  targetRepo: string;
  targetRef?: string;
  targetHead: string;
  sourcePath: string;
  sourceHash: string;
  ingestedAt: string;
  graphIndexId: string;
  snapshotMode?: AuditSnapshotMode;
  changedFiles?: string[];
  changedSymbols?: string[];
  staleWarnings?: string[];
  dirtyWorktree: boolean;
  findings: AuditFinding[];
}

export interface AuditValidationIssue {
  code: ReasonCode;
  message: string;
}

export interface AuditStatusProjection {
  status: AuditLifecycleStatus;
  reasonCodes: ReasonCode[];
  warnings: AuditValidationIssue[];
}

export interface AuditResponseEnvelope<T> {
  data: T;
  redactionMode: 'none' | 'paths' | 'snippets' | 'sensitive';
  limits: {
    maxFindings?: number;
    maxEvidence?: number;
    truncated: boolean;
  };
  freshness: AuditFreshness;
  warnings: AuditValidationIssue[];
  skipReasons: ReasonCode[];
}
