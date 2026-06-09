export type SidecarRequestPurpose =
  | 'type-aware-resolution'
  | 'security-invariant'
  | 'dataflow-invariant'
  | 'architecture-enrichment'
  | 'markdown-document-enrichment'
  | 'targeted-symbol-lookup';

export type SidecarRequestPriority =
  | 'user-requested'
  | 'unresolved-calls'
  | 'public-api'
  | 'changed-files'
  | 'high-centrality'
  | 'recent-query'
  | 'background-remainder';

export type SidecarRequestStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'superseded';

export type SidecarRequestDurability = 'persistent' | 'volatile';

export interface SidecarRequestInput {
  id?: string;
  repoId: string;
  sourceIndexId: string;
  analyzerId: string;
  analyzerVersion: string;
  purpose: SidecarRequestPurpose;
  scopeHash: string;
  priority: SidecarRequestPriority;
  requestedAt: string | Date;
  status?: SidecarRequestStatus;
  expiresAt?: string | Date;
  durability?: SidecarRequestDurability;
  sessionId?: string;
}

export interface SidecarEnrichmentRequest {
  id: string;
  repoId: string;
  sourceIndexId: string;
  analyzerId: string;
  analyzerVersion: string;
  purpose: SidecarRequestPurpose;
  scopeHash: string;
  priority: SidecarRequestPriority;
  status: SidecarRequestStatus;
  durability: SidecarRequestDurability;
  requestedAt: string;
  updatedAt: string;
  expiresAt?: string;
  sessionId?: string;
  mergedRequestIds: string[];
}

export interface SubmitSidecarRequestResult {
  request: SidecarEnrichmentRequest;
  status: 'queued' | 'merged';
}

export interface QueryRequestRateLimitPolicy {
  windowMs: number;
  maxRequests: number;
}

export interface QueryRequestCoalescingInput {
  now: string | Date;
  existingRequests: readonly SidecarEnrichmentRequest[];
  repoId: string;
  sessionId: string;
  analyzerId: string;
  scopeHash: string;
  policy?: QueryRequestRateLimitPolicy;
}

export interface QueryRequestCoalescingDecision {
  allowed: boolean;
  reason: 'allowed' | 'coalesced' | 'rate-limited';
  coalescedWithRequestId?: string;
  retryAfterMs?: number;
}

export interface SchedulerFairnessOptions {
  now: string | Date;
  highPrioritySelectionsSinceLowerPriority: number;
  maxHighPrioritySelections: number;
  lowerPriorityWindowStartedAt?: string | Date;
  maxLowerPriorityDelayMs?: number;
}

export const SIDECAR_REQUEST_PRIORITY_ORDER: readonly SidecarRequestPriority[] = [
  'user-requested',
  'unresolved-calls',
  'public-api',
  'changed-files',
  'high-centrality',
  'recent-query',
  'background-remainder',
] as const;

const SIDECAR_REQUEST_PURPOSES = new Set<SidecarRequestPurpose>([
  'type-aware-resolution',
  'security-invariant',
  'dataflow-invariant',
  'architecture-enrichment',
  'markdown-document-enrichment',
  'targeted-symbol-lookup',
]);
const SIDECAR_REQUEST_STATUSES = new Set<SidecarRequestStatus>([
  'queued',
  'running',
  'complete',
  'partial',
  'failed',
  'cancelled',
  'stale',
  'superseded',
]);
const SIDECAR_REQUEST_DURABILITIES = new Set<SidecarRequestDurability>(['persistent', 'volatile']);
const QUEUED_STATUSES = new Set<SidecarRequestStatus>(['queued']);
const ACTIVE_STATUSES = new Set<SidecarRequestStatus>(['queued', 'running']);
const DEFAULT_QUERY_RATE_LIMIT: QueryRequestRateLimitPolicy = {
  windowMs: 60_000,
  maxRequests: 3,
};

export function createSidecarRequest(input: SidecarRequestInput): SidecarEnrichmentRequest {
  const requestedAt = toIsoTimestamp(input.requestedAt, 'requestedAt');
  const durability = input.durability ?? defaultDurabilityForPriority(input.priority);

  return {
    id: input.id ?? createSidecarRequestKey(input),
    repoId: requireNonEmpty(input.repoId, 'repoId'),
    sourceIndexId: requireNonEmpty(input.sourceIndexId, 'sourceIndexId'),
    analyzerId: requireNonEmpty(input.analyzerId, 'analyzerId'),
    analyzerVersion: requireNonEmpty(input.analyzerVersion, 'analyzerVersion'),
    purpose: requireKnownValue(input.purpose, SIDECAR_REQUEST_PURPOSES, 'purpose'),
    scopeHash: requireNonEmpty(input.scopeHash, 'scopeHash'),
    priority: requireKnownValue(
      input.priority,
      new Set(SIDECAR_REQUEST_PRIORITY_ORDER),
      'priority',
    ),
    status: requireKnownValue(input.status ?? 'queued', SIDECAR_REQUEST_STATUSES, 'status'),
    durability: requireKnownValue(durability, SIDECAR_REQUEST_DURABILITIES, 'durability'),
    requestedAt,
    updatedAt: requestedAt,
    expiresAt: input.expiresAt ? toIsoTimestamp(input.expiresAt, 'expiresAt') : undefined,
    sessionId: input.sessionId,
    mergedRequestIds: [],
  };
}

export function createSidecarRequestKey(
  request:
    | Pick<
        SidecarRequestInput,
        'sourceIndexId' | 'analyzerId' | 'analyzerVersion' | 'purpose' | 'scopeHash'
      >
    | Pick<
        SidecarEnrichmentRequest,
        'sourceIndexId' | 'analyzerId' | 'analyzerVersion' | 'purpose' | 'scopeHash'
      >,
): string {
  return [
    request.sourceIndexId,
    request.analyzerId,
    request.analyzerVersion,
    request.purpose,
    request.scopeHash,
  ]
    .map((part) => encodeURIComponent(requireNonEmpty(part, 'dedupe key part')))
    .join(':');
}

export class SidecarRequestPool {
  private readonly requests = new Map<string, SidecarEnrichmentRequest>();

  constructor(initialRequests: readonly SidecarEnrichmentRequest[] = []) {
    for (const request of initialRequests) {
      this.requests.set(createSidecarRequestKey(request), normalizeExistingRequest(request));
    }
  }

  list(): SidecarEnrichmentRequest[] {
    return Array.from(this.requests.values());
  }

  submit(input: SidecarRequestInput): SubmitSidecarRequestResult {
    const request = createSidecarRequest(input);
    const key = createSidecarRequestKey(request);
    const existing = this.requests.get(key);

    if (existing && ACTIVE_STATUSES.has(existing.status)) {
      const merged = mergeCompatibleRequests(existing, request);
      this.requests.set(key, merged);
      return { request: merged, status: 'merged' };
    }

    this.requests.set(key, request);
    return { request, status: 'queued' };
  }

  selectNext(options?: Partial<SchedulerFairnessOptions>): SidecarEnrichmentRequest | undefined {
    return selectNextSidecarRequest(this.list(), options);
  }
}

export function selectNextSidecarRequest(
  requests: readonly SidecarEnrichmentRequest[],
  fairness?: Partial<SchedulerFairnessOptions>,
): SidecarEnrichmentRequest | undefined {
  const freshQueued = requests.filter((request) => isFreshQueuedRequest(request, fairness?.now));
  if (freshQueued.length === 0) return undefined;

  const fairnessCandidate = selectFairnessCandidate(freshQueued, fairness);
  if (fairnessCandidate) return fairnessCandidate;

  return sortByScheduleOrder(freshQueued)[0];
}

export function decideQueryTriggeredSidecarRequest(
  input: QueryRequestCoalescingInput,
): QueryRequestCoalescingDecision {
  const nowMs = Date.parse(toIsoTimestamp(input.now, 'now'));
  const coalesced = input.existingRequests.find(
    (request) =>
      ACTIVE_STATUSES.has(request.status) &&
      request.repoId === input.repoId &&
      request.sessionId === input.sessionId &&
      request.analyzerId === input.analyzerId &&
      request.scopeHash === input.scopeHash,
  );

  if (coalesced) {
    return {
      allowed: false,
      reason: 'coalesced',
      coalescedWithRequestId: coalesced.id,
    };
  }

  const policy = input.policy ?? DEFAULT_QUERY_RATE_LIMIT;
  const windowStartMs = nowMs - policy.windowMs;
  const requestTimes = input.existingRequests
    .filter(
      (request) =>
        request.priority === 'recent-query' &&
        request.repoId === input.repoId &&
        request.sessionId === input.sessionId &&
        request.analyzerId === input.analyzerId,
    )
    .map((request) => Date.parse(request.requestedAt))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= windowStartMs)
    .sort((left, right) => left - right);

  if (requestTimes.length >= policy.maxRequests) {
    return {
      allowed: false,
      reason: 'rate-limited',
      retryAfterMs: Math.max(0, requestTimes[0] + policy.windowMs - nowMs),
    };
  }

  return { allowed: true, reason: 'allowed' };
}

export function defaultDurabilityForPriority(
  priority: SidecarRequestPriority,
): SidecarRequestDurability {
  return priority === 'background-remainder' ? 'volatile' : 'persistent';
}

function mergeCompatibleRequests(
  existing: SidecarEnrichmentRequest,
  incoming: SidecarEnrichmentRequest,
): SidecarEnrichmentRequest {
  const mergedIds = new Set([...existing.mergedRequestIds, incoming.id]);
  const priority = higherPriority(existing.priority, incoming.priority);

  return {
    ...existing,
    priority,
    durability:
      existing.durability === 'persistent' || incoming.durability === 'persistent'
        ? 'persistent'
        : 'volatile',
    requestedAt: minIsoTimestamp(existing.requestedAt, incoming.requestedAt),
    updatedAt: maxIsoTimestamp(existing.updatedAt, incoming.updatedAt),
    expiresAt: minOptionalIsoTimestamp(existing.expiresAt, incoming.expiresAt),
    mergedRequestIds: Array.from(mergedIds).sort(),
  };
}

function selectFairnessCandidate(
  requests: readonly SidecarEnrichmentRequest[],
  fairness?: Partial<SchedulerFairnessOptions>,
): SidecarEnrichmentRequest | undefined {
  if (!fairness) return undefined;

  const forceByCount =
    fairness.maxHighPrioritySelections !== undefined &&
    fairness.highPrioritySelectionsSinceLowerPriority !== undefined &&
    fairness.highPrioritySelectionsSinceLowerPriority >= fairness.maxHighPrioritySelections;
  const forceByTime =
    fairness.maxLowerPriorityDelayMs !== undefined &&
    fairness.lowerPriorityWindowStartedAt !== undefined &&
    Date.parse(toIsoTimestamp(fairness.now ?? new Date(), 'now')) -
      Date.parse(
        toIsoTimestamp(fairness.lowerPriorityWindowStartedAt, 'lowerPriorityWindowStartedAt'),
      ) >=
      fairness.maxLowerPriorityDelayMs;

  if (!forceByCount && !forceByTime) return undefined;

  const sorted = sortByScheduleOrder(requests);
  const highestPriorityRank = priorityRank(sorted[0].priority);
  return sorted.find((request) => priorityRank(request.priority) > highestPriorityRank);
}

function sortByScheduleOrder(
  requests: readonly SidecarEnrichmentRequest[],
): SidecarEnrichmentRequest[] {
  return [...requests].sort((left, right) => {
    const priorityDelta = priorityRank(left.priority) - priorityRank(right.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id);
  });
}

function isFreshQueuedRequest(
  request: SidecarEnrichmentRequest,
  now: string | Date | undefined,
): boolean {
  if (!QUEUED_STATUSES.has(request.status)) return false;
  if (!request.expiresAt || now === undefined) return true;
  return Date.parse(request.expiresAt) > Date.parse(toIsoTimestamp(now, 'now'));
}

function normalizeExistingRequest(request: SidecarEnrichmentRequest): SidecarEnrichmentRequest {
  return {
    ...request,
    requestedAt: toIsoTimestamp(request.requestedAt, 'requestedAt'),
    updatedAt: toIsoTimestamp(request.updatedAt, 'updatedAt'),
    expiresAt: request.expiresAt ? toIsoTimestamp(request.expiresAt, 'expiresAt') : undefined,
    mergedRequestIds: [...request.mergedRequestIds].sort(),
  };
}

function higherPriority(
  left: SidecarRequestPriority,
  right: SidecarRequestPriority,
): SidecarRequestPriority {
  return priorityRank(left) <= priorityRank(right) ? left : right;
}

function priorityRank(priority: SidecarRequestPriority): number {
  return SIDECAR_REQUEST_PRIORITY_ORDER.indexOf(priority);
}

function toIsoTimestamp(value: string | Date, fieldName: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${fieldName} must be a valid timestamp`);
  }
  return date.toISOString();
}

function minIsoTimestamp(left: string, right: string): string {
  return left <= right ? left : right;
}

function maxIsoTimestamp(left: string, right: string): string {
  return left >= right ? left : right;
}

function minOptionalIsoTimestamp(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return minIsoTimestamp(left, right);
}

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must be non-empty`);
  }
  return trimmed;
}

function requireKnownValue<T extends string>(
  value: T,
  allowed: ReadonlySet<T>,
  fieldName: string,
): T {
  if (!allowed.has(value)) {
    throw new Error(`${fieldName} has unsupported value: ${String(value)}`);
  }
  return value;
}
