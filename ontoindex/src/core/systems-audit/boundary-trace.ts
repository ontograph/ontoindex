export type BoundaryMechanism = 'SCM_RIGHTS' | 'pidfd_getfd' | 'fork' | 'exec-close-on-exec';

export interface BoundaryTraceEvidence {
  kind: string;
  message: string;
  filePath?: string;
  line?: number;
  fact?: Record<string, unknown>;
}

export interface BoundaryTraceFact {
  kind: string;
  mechanism?: BoundaryMechanism;
  resourceInstanceId?: string;
  sourceResourceInstanceId?: string;
  processId?: string | number;
  childProcessId?: string | number;
  senderProcessId?: string | number;
  receiverProcessId?: string | number;
  targetProcessId?: string | number;
  handle?: string | number;
  senderHandle?: string | number;
  receiverHandle?: string | number;
  sourceHandle?: string | number;
  targetHandle?: string | number;
  flags?: string[];
  closeOnExec?: boolean;
  filePath?: string;
  line?: number;
  [key: string]: unknown;
}

export interface BoundaryTraceSegment {
  resourceInstanceId?: string;
  senderHandle?: string | number;
  receiverHandle?: string | number;
  senderProcessId?: string | number;
  receiverProcessId?: string | number;
  mechanism: BoundaryMechanism;
  evidence: BoundaryTraceEvidence[];
  confidence: number;
  unresolvedGaps: string[];
}

export interface BoundaryTraceParams {
  resource?: string;
  start?: string | number;
  end?: string | number;
  kind?: BoundaryMechanism;
  facts?: BoundaryTraceFact[];
  maxSegments?: number;
}

export interface BoundaryTraceReport {
  version: 1;
  tool: 'gn_trace_boundary';
  status: 'ok' | 'partial' | 'unresolved';
  primaryGraphFacts: unknown[];
  systemsEvidence: BoundaryTraceEvidence[];
  findings: [];
  segments: BoundaryTraceSegment[];
  limits: {
    truncated: boolean;
    maxSegments: number;
    emitted: number;
    total: number;
  };
  freshness: {
    status: 'not-applicable';
    reason: string;
  };
  skipReasons: string[];
  warnings: string[];
  nextTools: string[];
}

const DEFAULT_MAX_SEGMENTS = 50;
const MAX_SEGMENTS = 100;

export function traceBoundary(params: BoundaryTraceParams): BoundaryTraceReport {
  const maxSegments = normalizeLimit(params.maxSegments, DEFAULT_MAX_SEGMENTS, MAX_SEGMENTS);
  const facts = params.facts ?? [];
  const segments = [
    ...traceScmRights(params, facts),
    ...tracePidfdGetfd(params, facts),
    ...traceForkInheritance(params, facts),
    ...traceExecCloseOnExec(params, facts),
  ].filter((segment) => !params.kind || segment.mechanism === params.kind);

  const total = segments.length;
  const boundedSegments = segments.slice(0, maxSegments);
  const unresolved = boundedSegments.some((segment) => segment.unresolvedGaps.length > 0);

  return {
    version: 1,
    tool: 'gn_trace_boundary',
    status: total > maxSegments ? 'partial' : unresolved ? 'unresolved' : 'ok',
    primaryGraphFacts: [],
    systemsEvidence: boundedSegments.flatMap((segment) => segment.evidence),
    findings: [],
    segments: boundedSegments,
    limits: {
      truncated: total > maxSegments,
      maxSegments,
      emitted: boundedSegments.length,
      total,
    },
    freshness: {
      status: 'not-applicable',
      reason: 'boundary trace MVP consumes caller-supplied systems facts only',
    },
    skipReasons: [],
    warnings: [],
    nextTools: ['gn_audit_logic'],
  };
}

function traceScmRights(
  params: BoundaryTraceParams,
  facts: BoundaryTraceFact[],
): BoundaryTraceSegment[] {
  const sends = facts.filter((fact) => isMechanism(fact, 'SCM_RIGHTS') && fact.kind === 'send');
  const receives = facts.filter(
    (fact) => isMechanism(fact, 'SCM_RIGHTS') && fact.kind === 'receive',
  );
  const segments: BoundaryTraceSegment[] = [];

  for (const send of sends) {
    if (!matchesResource(params, send.resourceInstanceId)) {
      continue;
    }
    const receive = receives.find(
      (candidate) =>
        candidate.resourceInstanceId !== undefined &&
        candidate.resourceInstanceId === send.resourceInstanceId &&
        processMatches(params.end, candidate.receiverProcessId ?? candidate.processId),
    );

    segments.push({
      resourceInstanceId: send.resourceInstanceId,
      senderHandle: send.senderHandle ?? send.handle,
      receiverHandle: receive?.receiverHandle ?? receive?.handle,
      senderProcessId: send.senderProcessId ?? send.processId,
      receiverProcessId: receive?.receiverProcessId ?? receive?.processId,
      mechanism: 'SCM_RIGHTS',
      evidence: [
        factEvidence(send, 'SCM_RIGHTS send'),
        ...(receive ? [factEvidence(receive, 'SCM_RIGHTS receive')] : []),
      ],
      confidence: receive ? 0.9 : 0.45,
      unresolvedGaps: receive
        ? []
        : ['missing receive side for SCM_RIGHTS handoff; FD number equality is not identity proof'],
    });
  }

  return segments;
}

function tracePidfdGetfd(
  params: BoundaryTraceParams,
  facts: BoundaryTraceFact[],
): BoundaryTraceSegment[] {
  return facts
    .filter((fact) => isMechanism(fact, 'pidfd_getfd') || fact.kind === 'pidfd_getfd')
    .filter((fact) =>
      matchesResource(params, fact.resourceInstanceId ?? fact.sourceResourceInstanceId),
    )
    .map((fact) => ({
      resourceInstanceId: fact.resourceInstanceId ?? fact.sourceResourceInstanceId,
      senderHandle: fact.sourceHandle ?? fact.senderHandle,
      receiverHandle: fact.targetHandle ?? fact.receiverHandle,
      senderProcessId: fact.processId ?? fact.senderProcessId,
      receiverProcessId: fact.targetProcessId ?? fact.receiverProcessId,
      mechanism: 'pidfd_getfd' as const,
      evidence: [factEvidence(fact, 'pidfd_getfd duplicates a remote descriptor')],
      confidence: fact.resourceInstanceId || fact.sourceResourceInstanceId ? 0.86 : 0.5,
      unresolvedGaps:
        fact.resourceInstanceId || fact.sourceResourceInstanceId
          ? []
          : [
              'pidfd_getfd fact has no resource instance; target fd number alone is not identity proof',
            ],
    }));
}

function traceForkInheritance(
  params: BoundaryTraceParams,
  facts: BoundaryTraceFact[],
): BoundaryTraceSegment[] {
  const forks = facts.filter((fact) => fact.kind === 'fork' || isMechanism(fact, 'fork'));
  const resources = facts.filter((fact) => fact.resourceInstanceId && fact.kind !== 'receive');
  const segments: BoundaryTraceSegment[] = [];

  for (const fork of forks) {
    for (const resource of resources) {
      const parentProcess = fork.processId ?? fork.senderProcessId;
      if (
        !matchesResource(params, resource.resourceInstanceId) ||
        !processMatches(parentProcess, resource.processId)
      ) {
        continue;
      }
      segments.push({
        resourceInstanceId: resource.resourceInstanceId,
        senderHandle: resource.handle ?? resource.senderHandle,
        receiverHandle: resource.handle ?? resource.senderHandle,
        senderProcessId: parentProcess,
        receiverProcessId: fork.childProcessId ?? fork.receiverProcessId,
        mechanism: 'fork',
        evidence: [
          factEvidence(fork, 'fork boundary'),
          factEvidence(resource, 'inherited descriptor'),
        ],
        confidence: 0.78,
        unresolvedGaps: [],
      });
    }
  }

  return segments;
}

function traceExecCloseOnExec(
  params: BoundaryTraceParams,
  facts: BoundaryTraceFact[],
): BoundaryTraceSegment[] {
  const execs = facts.filter(
    (fact) => fact.kind === 'exec' || isMechanism(fact, 'exec-close-on-exec'),
  );
  const resources = facts.filter((fact) => fact.resourceInstanceId && fact.kind !== 'receive');
  const segments: BoundaryTraceSegment[] = [];

  for (const exec of execs) {
    for (const resource of resources) {
      if (
        !matchesResource(params, resource.resourceInstanceId) ||
        !processMatches(exec.processId, resource.processId)
      ) {
        continue;
      }
      const closeOnExec =
        resource.closeOnExec === true ||
        (resource.flags ?? []).some((flag) =>
          ['O_CLOEXEC', 'FD_CLOEXEC', 'close-on-exec'].includes(flag),
        );
      segments.push({
        resourceInstanceId: resource.resourceInstanceId,
        senderHandle: resource.handle ?? resource.senderHandle,
        receiverHandle: closeOnExec ? undefined : (resource.handle ?? resource.senderHandle),
        senderProcessId: exec.processId,
        receiverProcessId: exec.processId,
        mechanism: 'exec-close-on-exec',
        evidence: [
          factEvidence(exec, 'exec boundary'),
          factEvidence(resource, 'descriptor close-on-exec state'),
        ],
        confidence: closeOnExec ? 0.88 : 0.74,
        unresolvedGaps: closeOnExec
          ? ['descriptor is filtered by close-on-exec and is not available after exec']
          : [],
      });
    }
  }

  return segments;
}

function factEvidence(fact: BoundaryTraceFact, message: string): BoundaryTraceEvidence {
  return {
    kind: 'systems-boundary-fact',
    message,
    filePath: fact.filePath,
    line: fact.line,
    fact: { ...fact },
  };
}

function isMechanism(fact: BoundaryTraceFact, mechanism: BoundaryMechanism): boolean {
  return fact.mechanism === mechanism;
}

function matchesResource(params: BoundaryTraceParams, resourceInstanceId: unknown): boolean {
  return params.resource === undefined || resourceInstanceId === params.resource;
}

function processMatches(expected: unknown, actual: unknown): boolean {
  return expected === undefined || actual === undefined || String(expected) === String(actual);
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}
