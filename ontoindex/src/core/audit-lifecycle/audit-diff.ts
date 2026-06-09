export type AuditFindingFingerprint =
  | string
  | {
      location?: string;
      claim?: string;
      history?: string;
    };

export interface AuditDiffFindingLike {
  id?: string;
  findingId?: string;
  fingerprint?: AuditFindingFingerprint;
  status: string;
  title?: string;
  targetHead?: string;
  evidence?: readonly AuditEvidenceLike[];
  verifiedEvidence?: readonly AuditEvidenceLike[];
  negativeEvidence?: readonly AuditEvidenceLike[];
  statusTransitionEvidence?: readonly AuditEvidenceLike[];
  reasonCodes?: readonly string[];
  verifiedAt?: string | null;
  verifiedHead?: string | null;
}

export interface AuditEvidenceLike {
  kind?: string;
  mode?: string;
  targetHead?: string;
  verifiedHead?: string;
  graphIndexId?: string;
  verifierVersion?: string;
  reasonCodes?: readonly string[];
  verifiedAt?: string;
}

export interface AuditDiffSessionLike {
  id?: string;
  sessionId?: string;
  targetRepo?: string;
  targetHead?: string;
  graphIndexId?: string;
  verifierVersion?: string;
  sidecarStateHash?: string;
  sourceHash?: string;
}

export interface AuditEvidenceSummary {
  total: number;
  kinds: string[];
  targetHeads: string[];
  verifiedHeads: string[];
  graphIndexIds: string[];
  verifierVersions: string[];
  reasonCodes: string[];
  latestVerifiedAt?: string;
}

export interface AuditFindingDiffSnapshot {
  id: string;
  fingerprint?: string;
  status: string;
  title?: string;
  evidence: AuditEvidenceSummary;
}

export interface AuditSessionDiffEntry {
  identity: string;
  match: 'fingerprint' | 'id';
  previous?: AuditFindingDiffSnapshot;
  current?: AuditFindingDiffSnapshot;
  evidenceDelta?: AuditEvidenceDelta;
}

export interface AuditEvidenceDelta {
  totalDelta: number;
  addedKinds: string[];
  removedKinds: string[];
  addedReasonCodes: string[];
  removedReasonCodes: string[];
}

export function diffEvidence(
  previous: AuditEvidenceSummary,
  current: AuditEvidenceSummary,
): AuditEvidenceDelta {
  return {
    totalDelta: current.total - previous.total,
    addedKinds: current.kinds.filter((k) => !previous.kinds.includes(k)),
    removedKinds: previous.kinds.filter((k) => !current.kinds.includes(k)),
    addedReasonCodes: current.reasonCodes.filter((r) => !previous.reasonCodes.includes(r)),
    removedReasonCodes: previous.reasonCodes.filter((r) => !current.reasonCodes.includes(r)),
  };
}

export interface AuditStatusChangedDiffEntry extends AuditSessionDiffEntry {
  previous: AuditFindingDiffSnapshot;
  current: AuditFindingDiffSnapshot;
  previousStatus: string;
  currentStatus: string;
}

export interface AuditUnchangedDiffEntry extends AuditSessionDiffEntry {
  previous: AuditFindingDiffSnapshot;
  current: AuditFindingDiffSnapshot;
}

export interface AuditSessionDiff {
  sessionA: AuditSessionDiffSessionSnapshot;
  sessionB: AuditSessionDiffSessionSnapshot;
  added: AuditSessionDiffEntry[];
  removed: AuditSessionDiffEntry[];
  statusChanged: AuditStatusChangedDiffEntry[];
  unchanged: AuditUnchangedDiffEntry[];
  summary: AuditDeltaSummary;
}

export interface AuditDeltaSummary {
  added: number;
  removed: number;
  statusChanged: number;
  unchanged: number;
  totalFindings: {
    previous: number;
    current: number;
  };
}

export function summarizeAuditDelta(diff: Omit<AuditSessionDiff, 'summary'>): AuditDeltaSummary {
  return {
    added: diff.added.length,
    removed: diff.removed.length,
    statusChanged: diff.statusChanged.length,
    unchanged: diff.unchanged.length,
    totalFindings: {
      previous: diff.removed.length + diff.statusChanged.length + diff.unchanged.length,
      current: diff.added.length + diff.statusChanged.length + diff.unchanged.length,
    },
  };
}

export interface AuditSessionDiffSessionSnapshot {
  id: string;
  targetRepo?: string;
  targetHead?: string;
  graphIndexId?: string;
  verifierVersion?: string;
  sourceHash?: string;
}

interface IndexedFinding {
  key: string;
  match: 'fingerprint' | 'id';
  finding: AuditDiffFindingLike;
  id: string;
  fingerprint?: string;
}

interface MatchedFinding extends IndexedFinding {
  indexedKey: string;
}

export function buildAuditSessionDiff(
  sessionA: AuditDiffSessionLike,
  findingsA: readonly AuditDiffFindingLike[],
  sessionB: AuditDiffSessionLike,
  findingsB: readonly AuditDiffFindingLike[],
): AuditSessionDiff {
  const indexedB = indexFindings(findingsB);
  const matchedBKeys = new Set<string>();
  const added: AuditSessionDiffEntry[] = [];
  const removed: AuditSessionDiffEntry[] = [];
  const statusChanged: AuditStatusChangedDiffEntry[] = [];
  const unchanged: AuditUnchangedDiffEntry[] = [];

  for (const previousFinding of findingsA) {
    const previous = indexFinding(previousFinding);
    const current = findMatchingFinding(previousFinding, indexedB);

    if (current === undefined) {
      removed.push({
        identity: previous.key,
        match: previous.match,
        previous: snapshotFinding(previousFinding),
      });
      continue;
    }

    matchedBKeys.add(current.indexedKey);
    const previousSnapshot = snapshotFinding(previousFinding);
    const currentSnapshot = snapshotFinding(current.finding);
    const evidenceDelta = diffEvidence(previousSnapshot.evidence, currentSnapshot.evidence);

    if (previousFinding.status !== current.finding.status) {
      statusChanged.push({
        identity: current.key,
        match: current.match,
        previous: previousSnapshot,
        current: currentSnapshot,
        previousStatus: previousFinding.status,
        currentStatus: current.finding.status,
        evidenceDelta,
      });
      continue;
    }

    unchanged.push({
      identity: current.key,
      match: current.match,
      previous: previousSnapshot,
      current: currentSnapshot,
      evidenceDelta,
    });
  }

  for (const current of indexedB.byOrder) {
    if (!matchedBKeys.has(current.key)) {
      added.push({
        identity: current.key,
        match: current.match,
        current: snapshotFinding(current.finding),
      });
    }
  }

  const result: Omit<AuditSessionDiff, 'summary'> = {
    sessionA: snapshotSession(sessionA),
    sessionB: snapshotSession(sessionB),
    added: sortEntries(added),
    removed: sortEntries(removed),
    statusChanged: sortEntries(statusChanged),
    unchanged: sortEntries(unchanged),
  };

  return {
    ...result,
    summary: summarizeAuditDelta(result),
  };
}

export function snapshotFinding(finding: AuditDiffFindingLike): AuditFindingDiffSnapshot {
  const id = findingId(finding);
  const fingerprint = fingerprintKey(finding.fingerprint);
  return {
    id,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    status: finding.status,
    ...(finding.title !== undefined ? { title: finding.title } : {}),
    evidence: summarizeAuditEvidence(finding),
  };
}

export function summarizeAuditEvidence(finding: AuditDiffFindingLike): AuditEvidenceSummary {
  const evidence = collectEvidence(finding);
  const latestVerifiedAt = latestString([
    ...evidence.map((item) => item.verifiedAt),
    finding.verifiedAt ?? undefined,
  ]);

  return {
    total: evidence.length,
    kinds: uniqueSorted(evidence.map((item) => item.kind ?? item.mode)),
    targetHeads: uniqueSorted(evidence.map((item) => item.targetHead)),
    verifiedHeads: uniqueSorted([
      ...evidence.map((item) => item.verifiedHead),
      finding.verifiedHead ?? undefined,
    ]),
    graphIndexIds: uniqueSorted(evidence.map((item) => item.graphIndexId)),
    verifierVersions: uniqueSorted(evidence.map((item) => item.verifierVersion)),
    reasonCodes: uniqueSorted([
      ...evidence.flatMap((item) => item.reasonCodes ?? []),
      ...(finding.reasonCodes ?? []),
    ]),
    ...(latestVerifiedAt !== undefined ? { latestVerifiedAt } : {}),
  };
}

export function findingIdentity(finding: AuditDiffFindingLike): string {
  return indexFinding(finding).key;
}

export function findingId(finding: AuditDiffFindingLike): string {
  const id = finding.id ?? finding.findingId;
  if (id === undefined || id.trim().length === 0) {
    throw new Error('audit finding must include id or findingId');
  }
  return id;
}

export function fingerprintKey(
  fingerprint: AuditFindingFingerprint | undefined,
): string | undefined {
  if (typeof fingerprint === 'string') {
    const trimmed = fingerprint.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (fingerprint === undefined) {
    return undefined;
  }
  const location = fingerprint.location?.trim();
  const claim = fingerprint.claim?.trim();
  const history = fingerprint.history?.trim();
  const parts = [location, claim, history].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join('|') : undefined;
}

function indexFindings(findings: readonly AuditDiffFindingLike[]) {
  const byFingerprint = new Map<string, IndexedFinding>();
  const byId = new Map<string, IndexedFinding>();
  const byOrder: IndexedFinding[] = [];

  for (const finding of findings) {
    const indexed = indexFinding(finding);
    const id = findingId(finding);
    const fingerprint = fingerprintKey(finding.fingerprint);
    byOrder.push(indexed);
    byId.set(id, indexed);
    if (fingerprint !== undefined) {
      byFingerprint.set(fingerprint, indexed);
    }
  }

  return { byFingerprint, byId, byOrder };
}

function indexFinding(finding: AuditDiffFindingLike): IndexedFinding {
  const fingerprint = fingerprintKey(finding.fingerprint);
  return {
    key: fingerprint ?? findingId(finding),
    match: fingerprint !== undefined ? 'fingerprint' : 'id',
    finding,
    id: findingId(finding),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
}

function findMatchingFinding(
  finding: AuditDiffFindingLike,
  indexed: ReturnType<typeof indexFindings>,
): MatchedFinding | undefined {
  const fingerprint = fingerprintKey(finding.fingerprint);
  if (fingerprint !== undefined) {
    const match = indexed.byFingerprint.get(fingerprint);
    if (match !== undefined) {
      return { ...match, indexedKey: match.key };
    }
  }
  const match = indexed.byId.get(findingId(finding));
  if (match === undefined) {
    return undefined;
  }
  return {
    ...match,
    key: match.id,
    match: 'id',
    indexedKey: match.key,
  };
}

function snapshotSession(session: AuditDiffSessionLike): AuditSessionDiffSessionSnapshot {
  const id = session.id ?? session.sessionId;
  if (id === undefined || id.trim().length === 0) {
    throw new Error('audit session must include id or sessionId');
  }
  return {
    id,
    ...(session.targetRepo !== undefined ? { targetRepo: session.targetRepo } : {}),
    ...(session.targetHead !== undefined ? { targetHead: session.targetHead } : {}),
    ...(session.graphIndexId !== undefined ? { graphIndexId: session.graphIndexId } : {}),
    ...(session.verifierVersion !== undefined ? { verifierVersion: session.verifierVersion } : {}),
    ...(session.sourceHash !== undefined ? { sourceHash: session.sourceHash } : {}),
  };
}

function collectEvidence(finding: AuditDiffFindingLike): AuditEvidenceLike[] {
  return [
    ...(finding.evidence ?? []),
    ...(finding.verifiedEvidence ?? []),
    ...(finding.negativeEvidence ?? []),
    ...(finding.statusTransitionEvidence ?? []),
  ];
}

function uniqueSorted(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function latestString(values: readonly (string | undefined)[]): string | undefined {
  return uniqueSorted(values).at(-1);
}

function sortEntries<T extends AuditSessionDiffEntry>(entries: T[]): T[] {
  return [...entries].sort((left, right) => left.identity.localeCompare(right.identity));
}
