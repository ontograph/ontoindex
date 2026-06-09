import type { MarkdownApiSpecFact, MarkdownLineSpan } from './markdown-document-facts.js';
import {
  createRouteDataAuditReport,
  type CreateRouteDataAuditReportOptions,
  type RouteDataAuditField,
  type RouteDataAuditRecord,
  type RouteDataAuditReport,
  type RouteDataAuditSupportState,
} from './route-data-audit.js';

export type NormalizedRouteCandidateSource = 'code' | 'doc';

export type NormalizedRouteCandidateState = 'supported' | 'partial' | 'unsupported';

export type RouteCandidateUnavailableField = 'method' | 'path' | RouteDataAuditField;

export interface RouteCandidateNormalization {
  readonly method: string;
  readonly path: string;
  readonly reasons: string[];
}

export interface RouteCandidateUnsupportedMetadata {
  readonly state: Exclude<NormalizedRouteCandidateState, 'supported'>;
  readonly reason: string;
  readonly field?: RouteCandidateUnavailableField;
}

export interface RouteCandidateAmbiguityMetadata {
  readonly reason: 'duplicate-route-identity' | 'unknown-method-or-path';
  readonly identity: string;
  readonly count?: number;
  readonly sampleHandlers?: string[];
}

export interface NormalizedRouteCandidate {
  readonly method: string;
  readonly path: string;
  readonly source: NormalizedRouteCandidateSource;
  readonly id?: string;
  readonly filePath?: string;
  readonly lineSpan?: MarkdownLineSpan;
  readonly framework?: string;
  readonly confidence: number;
  readonly state: NormalizedRouteCandidateState;
  readonly normalizationReasons: string[];
  readonly unsupported?: RouteCandidateUnsupportedMetadata;
  readonly ambiguous?: RouteCandidateAmbiguityMetadata;
  readonly metadata?: {
    readonly docPath?: string;
    readonly routeKey?: string;
    readonly headingPath?: string[];
    readonly extractor?: string;
    readonly missingFields?: RouteCandidateUnavailableField[];
  };
}

export function normalizeRouteCandidateParts(
  method: string | undefined,
  path: string | undefined,
): RouteCandidateNormalization {
  const methodResult = normalizeRouteMethod(method);
  const pathResult = normalizeRouteTemplate(path);
  return {
    method: methodResult.method,
    path: pathResult.path,
    reasons: [...methodResult.reasons, ...pathResult.reasons],
  };
}

export function normalizeRouteMethod(method: string | undefined): {
  readonly method: string;
  readonly reasons: string[];
} {
  if (!method || method.trim().length === 0 || method.trim() === '*') {
    return { method: '*', reasons: ['method.missing'] };
  }

  const trimmed = method.trim();
  const normalized = trimmed.toUpperCase();
  return {
    method: normalized,
    reasons: normalized === trimmed ? [] : ['method.uppercase'],
  };
}

export function normalizeRouteTemplate(path: string | undefined): {
  readonly path: string;
  readonly reasons: string[];
} {
  const reasons: string[] = [];
  if (!path || path.trim().length === 0 || path.trim() === '<missing-path>') {
    return { path: '<missing-path>', reasons: ['path.missing'] };
  }

  let normalized = path.trim();
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
    reasons.push('path.leading-slash-added');
  }

  const collapsed = normalized.replace(/\/{2,}/g, '/');
  if (collapsed !== normalized) reasons.push('path.duplicate-slashes-collapsed');
  normalized = collapsed;

  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/g, '');
    reasons.push('path.trailing-slash-removed');
  }

  const segments = normalized.split('/').map((segment) => normalizeRouteSegment(segment, reasons));
  normalized = segments.join('/');

  const lowerCased = normalized
    .split('/')
    .map((segment) => (segment.startsWith(':') ? segment : segment.toLowerCase()))
    .join('/');
  if (lowerCased !== normalized) reasons.push('path.lowercase');

  return { path: lowerCased, reasons: unique(reasons) };
}

export function createDocRouteCandidates(
  facts: readonly MarkdownApiSpecFact[],
): NormalizedRouteCandidate[] {
  return facts
    .filter((fact) => fact.kind === 'markdown-api-spec')
    .map((fact) => {
      const rawMethod = stringValue(fact.method);
      const rawPath = stringValue(fact.path);
      const normalized = normalizeRouteCandidateParts(rawMethod, rawPath);
      const missing = unavailableFields(rawMethod, rawPath);
      const state: NormalizedRouteCandidateState = missing.length > 0 ? 'partial' : 'supported';
      return compactCandidate({
        method: normalized.method,
        path: normalized.path,
        source: 'doc',
        id: fact.routeKey || fact.normalizedKey,
        filePath: fact.docPath,
        lineSpan: fact.lineSpan,
        confidence: clampConfidence(fact.confidence),
        state,
        normalizationReasons: normalized.reasons,
        unsupported:
          missing.length > 0
            ? {
                state: 'partial',
                reason: `${missing.join(', ')} unavailable in markdown api spec`,
                field: missing[0],
              }
            : undefined,
        ambiguous:
          missing.length > 0
            ? {
                reason: 'unknown-method-or-path',
                identity: routeIdentity(normalized.method, normalized.path),
              }
            : undefined,
        metadata: {
          docPath: fact.docPath,
          routeKey: fact.routeKey,
          headingPath: fact.headingPath,
          missingFields: missing,
        },
      });
    });
}

export function createCodeRouteCandidatesFromAuditRecords(
  records: readonly RouteDataAuditRecord[],
  options: CreateRouteDataAuditReportOptions = {},
): NormalizedRouteCandidate[] {
  const report = createRouteDataAuditReport(records, {
    ...options,
    sampleLimit: Math.max(records.length, options.sampleLimit ?? 0, 1),
  });
  return createCodeRouteCandidatesFromAuditReport(report);
}

export function createCodeRouteCandidatesFromAuditReport(
  report: RouteDataAuditReport,
): NormalizedRouteCandidate[] {
  const candidates: NormalizedRouteCandidate[] = [];

  for (const group of report.groups) {
    const stateByIdentity = routeStatesByIdentity(group.unsupportedStates);
    const ambiguousByIdentity = new Map(
      group.ambiguousRouteIdentities.map((identity) => [identity.identity, identity]),
    );

    for (const sample of group.sampleRouteIdentities) {
      const parsed = parseRouteIdentity(sample.identity);
      const rawMethod = sample.method ?? parsed.method;
      const rawPath = sample.path ?? parsed.path;
      const normalized = normalizeRouteCandidateParts(rawMethod, rawPath);
      const missingFields = unique<RouteCandidateUnavailableField>([
        ...sample.missingFields,
        ...unavailableFields(rawMethod, rawPath),
      ]);
      const state = normalizeAuditState(sample.state);
      const stateMetadata = stateByIdentity.get(sample.identity);
      const ambiguous = ambiguousByIdentity.get(sample.identity);
      const unsupported = createAuditUnsupportedMetadata(
        state,
        group.framework,
        missingFields,
        stateMetadata,
      );

      candidates.push(
        compactCandidate({
          method: normalized.method,
          path: normalized.path,
          source: 'code',
          id: `code:${group.framework}:${group.source}:${sample.identity}:${sample.sourceFile ?? sample.handler ?? 'unknown'}`,
          filePath: sample.sourceFile ?? sample.handler,
          lineSpan: sample.lineSpan
            ? { start: sample.lineSpan.startLine, end: sample.lineSpan.endLine }
            : undefined,
          framework: group.framework,
          confidence: state === 'supported' ? 0.9 : state === 'partial' ? 0.55 : 0,
          state,
          normalizationReasons: normalized.reasons,
          unsupported,
          ambiguous:
            sample.ambiguous || ambiguous
              ? {
                  reason:
                    ambiguous && ambiguous.count > 1
                      ? 'duplicate-route-identity'
                      : 'unknown-method-or-path',
                  identity: sample.identity,
                  count: ambiguous?.count,
                  sampleHandlers: ambiguous?.sampleHandlers,
                }
              : undefined,
          metadata: {
            extractor: group.source,
            missingFields,
          },
        }),
      );
    }
  }

  return candidates.sort(compareCandidates);
}

function normalizeRouteSegment(segment: string, reasons: string[]): string {
  if (segment.length === 0) return segment;
  if (isWildcardOrCatchAllSegment(segment)) {
    reasons.push('path.wildcard-preserved');
    return segment;
  }
  if (/^:[^/]+$/.test(segment)) {
    if (segment !== ':param') reasons.push('path.parameter-normalized');
    return ':param';
  }
  if (
    /^\{[^/{}]+\}$/.test(segment) ||
    /^\[[^[\]/]+\]$/.test(segment) ||
    /^<[^/<>]+>$/.test(segment)
  ) {
    reasons.push('path.parameter-normalized');
    return ':param';
  }
  return segment;
}

function isWildcardOrCatchAllSegment(segment: string): boolean {
  return segment.includes('*') || segment.includes('...');
}

function createAuditUnsupportedMetadata(
  state: NormalizedRouteCandidateState,
  framework: string,
  missingFields: readonly RouteCandidateUnavailableField[],
  stateMetadata: RouteCandidateUnsupportedMetadata | undefined,
): RouteCandidateUnsupportedMetadata | undefined {
  if (stateMetadata) return stateMetadata;
  if (state === 'unsupported') {
    return {
      state: 'unsupported',
      reason:
        framework && framework !== 'unknown'
          ? `${framework} route extraction is unsupported`
          : 'route extraction is unsupported',
      field: 'framework',
    };
  }
  if (missingFields.length > 0) {
    return {
      state: 'partial',
      reason: `${missingFields.join(', ')} unavailable in route extraction`,
      field: missingFields[0],
    };
  }
  return undefined;
}

function routeStatesByIdentity(
  states: readonly {
    readonly state: Exclude<RouteDataAuditSupportState, 'supported'>;
    readonly reason: string;
    readonly field?: RouteDataAuditField;
    readonly sampleRouteIdentities: string[];
  }[],
): Map<string, RouteCandidateUnsupportedMetadata> {
  const byIdentity = new Map<string, RouteCandidateUnsupportedMetadata>();
  for (const state of states) {
    for (const identity of state.sampleRouteIdentities) {
      byIdentity.set(identity, {
        state: state.state,
        reason: state.reason,
        field: state.field,
      });
    }
  }
  return byIdentity;
}

function parseRouteIdentity(identity: string): {
  readonly method?: string;
  readonly path?: string;
} {
  const separator = identity.indexOf(' ');
  if (separator < 0) return {};
  return {
    method: identity.slice(0, separator),
    path: identity.slice(separator + 1),
  };
}

function unavailableFields(
  method: string | undefined,
  path: string | undefined,
): RouteCandidateUnavailableField[] {
  return [
    ...(method && method.trim().length > 0 && method.trim() !== '*' ? [] : ['method' as const]),
    ...(path && path.trim().length > 0 && path.trim() !== '<missing-path>'
      ? []
      : ['path' as const]),
  ];
}

function normalizeAuditState(state: RouteDataAuditSupportState): NormalizedRouteCandidateState {
  if (state === 'unsupported') return 'unsupported';
  if (state === 'partial') return 'partial';
  return 'supported';
}

function compactCandidate(candidate: NormalizedRouteCandidate): NormalizedRouteCandidate {
  const metadata = candidate.metadata
    ? Object.fromEntries(
        Object.entries(candidate.metadata).filter(([, value]) =>
          Array.isArray(value) ? value.length > 0 : value !== undefined,
        ),
      )
    : undefined;

  return {
    method: candidate.method,
    path: candidate.path,
    source: candidate.source,
    ...(candidate.id ? { id: candidate.id } : {}),
    ...(candidate.filePath ? { filePath: candidate.filePath } : {}),
    ...(candidate.lineSpan ? { lineSpan: candidate.lineSpan } : {}),
    ...(candidate.framework ? { framework: candidate.framework } : {}),
    confidence: candidate.confidence,
    state: candidate.state,
    normalizationReasons: candidate.normalizationReasons,
    ...(candidate.unsupported ? { unsupported: candidate.unsupported } : {}),
    ...(candidate.ambiguous ? { ambiguous: candidate.ambiguous } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function compareCandidates(
  left: NormalizedRouteCandidate,
  right: NormalizedRouteCandidate,
): number {
  return (
    left.source.localeCompare(right.source) ||
    left.method.localeCompare(right.method) ||
    left.path.localeCompare(right.path) ||
    (left.filePath ?? '').localeCompare(right.filePath ?? '')
  );
}

function routeIdentity(method: string, path: string): string {
  return `${method} ${path}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
