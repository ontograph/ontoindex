import {
  traceBoundary,
  type BoundaryMechanism,
  type BoundaryTraceFact,
  type BoundaryTraceReport,
} from '../../core/systems-audit/boundary-trace.js';
import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';
import { resolveTargetContext } from '../shared/target-context.js';

export interface TraceBoundaryParams {
  resource?: string;
  start?: string | number;
  end?: string | number;
  kind?: BoundaryMechanism;
  mechanism?: BoundaryMechanism | 'exec';
  source?: string;
  repo?: string;
  facts?: BoundaryTraceFact[];
  maxSegments?: number;
  legacyResponse?: boolean;
}

export async function gnTraceBoundary(
  repoId: string,
  params: TraceBoundaryParams,
): Promise<BoundaryTraceReport | Record<string, unknown>> {
  const kind = normalizeMechanism(params.kind);
  const mechanism = normalizeMechanism(params.mechanism);
  if (kind && mechanism && kind !== mechanism) {
    throw new Error('kind and mechanism must identify the same boundary mechanism');
  }
  const maxSegments = params.maxSegments ?? 50;
  if (!Number.isInteger(maxSegments) || maxSegments < 1 || maxSegments > 100) {
    throw new Error('maxSegments must be an integer from 1 to 100');
  }
  for (const key of ['resource', 'start', 'end'] as const) {
    if (params[key] !== undefined) validateIdentity(params[key], key, key === 'resource');
  }
  if (params.source !== undefined && typeof params.source !== 'string') {
    throw new Error('source must be a string');
  }
  const facts = validateFacts(params.facts);
  const endpointFacts =
    params.end === undefined
      ? facts
      : facts.filter(
          (fact) =>
            fact.kind !== 'receive' ||
            fact.mechanism !== 'SCM_RIGHTS' ||
            (fact.receiverProcessId ?? fact.processId) === params.end,
        );
  const report = traceBoundary({
    resource: params.resource,
    end: params.end,
    kind: mechanism ?? kind,
    facts: endpointFacts,
    maxSegments: 100,
  });
  const filtered = report.segments.filter(
    (segment) =>
      (params.start === undefined || segment.senderProcessId === params.start) &&
      (params.end === undefined || segment.receiverProcessId === params.end),
  );
  const acquisitionTruncated = report.limits.truncated;
  const truncated = acquisitionTruncated || filtered.length > maxSegments;
  report.segments = filtered.slice(0, maxSegments);
  report.systemsEvidence = report.segments.flatMap((segment) => segment.evidence);
  const limits = {
    truncated,
    maxSegments,
    emitted: report.segments.length,
    total: filtered.length,
    totalIsExact: !acquisitionTruncated,
    totalScope: acquisitionTruncated ? 'acquired-matching-segments' : 'matching-segments',
  };
  report.limits = limits;
  report.status = truncated
    ? 'partial'
    : !filtered.length || report.segments.some((segment) => segment.unresolvedGaps.length)
      ? 'unresolved'
      : 'ok';
  if (params.source !== undefined) {
    report.warnings.push(
      'Source text is not analyzed; boundary tracing consumes caller-supplied facts only.',
    );
    report.skipReasons.push('source-analysis-unavailable');
  }
  if (!filtered.length) {
    report.warnings.push('No boundary segments match the supplied facts and endpoint identities.');
    report.skipReasons.push('no-matching-boundary-evidence');
  }
  if (acquisitionTruncated) {
    report.warnings.push(
      'Core segment acquisition was truncated before endpoint filtering; matching evidence may be omitted.',
    );
  }
  if (params.legacyResponse !== false) {
    return report;
  }

  const targetContext = await resolveTargetContext({ repo: repoId });
  return createEnvelopeFromLegacy({
    legacy: report as unknown as Record<string, unknown>,
    tool: 'gn_trace_boundary',
    status: report.status ?? 'ok',
    targetContext,
    capabilitiesUsed: ['boundary-trace'],
    nextTools: ['gn_resource_trace', 'gn_path_verify'],
    evidence: report.segments ?? [],
  });
}

function normalizeMechanism(value: unknown): BoundaryMechanism | undefined {
  if (value === undefined) return undefined;
  if (value === 'exec') return 'exec-close-on-exec';
  if (
    value === 'SCM_RIGHTS' ||
    value === 'pidfd_getfd' ||
    value === 'fork' ||
    value === 'exec-close-on-exec'
  )
    return value;
  throw new Error('Unsupported boundary mechanism');
}

function validateIdentity(value: unknown, field: string, stringOnly = false): void {
  if (typeof value === 'string' && value.length <= 1024) return;
  if (!stringOnly && typeof value === 'number' && Number.isFinite(value)) return;
  throw new Error(
    `${field} must be ${stringOnly ? 'a string' : 'a string or finite number'} with strings bounded to 1024 characters`,
  );
}

function validateFacts(value: unknown): BoundaryTraceFact[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256)
    throw new Error('facts must be an array of at most 256 facts');
  const strings = new Set(['kind', 'resourceInstanceId', 'sourceResourceInstanceId', 'filePath']);
  const identities = new Set([
    'processId',
    'childProcessId',
    'senderProcessId',
    'receiverProcessId',
    'targetProcessId',
    'handle',
    'senderHandle',
    'receiverHandle',
    'sourceHandle',
    'targetHandle',
  ]);
  return value.map((fact) => {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact))
      throw new Error('Each fact must be an object');
    if (typeof fact.kind !== 'string') throw new Error('Each fact requires a string kind');
    const validated: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(fact)) {
      if (strings.has(key)) validateIdentity(field, key, true);
      else if (identities.has(key)) validateIdentity(field, key);
      else if (key === 'mechanism') {
        if (field === undefined) throw new Error('Fact mechanism must be defined');
        validated[key] = normalizeMechanism(field);
        continue;
      } else if (key === 'line') {
        if (typeof field !== 'number' || !Number.isInteger(field) || field < 1)
          throw new Error('Fact line must be a positive integer');
      } else if (key === 'closeOnExec') {
        if (typeof field !== 'boolean') throw new Error('Fact closeOnExec must be boolean');
      } else if (key === 'flags') {
        if (
          !Array.isArray(field) ||
          field.length > 32 ||
          field.some((flag) => typeof flag !== 'string' || flag.length > 128)
        )
          throw new Error('Fact flags must contain at most 32 strings of at most 128 characters');
      } else throw new Error(`Unknown fact field: ${key}`);
      validated[key] = field;
    }
    return validated as BoundaryTraceFact;
  });
}
