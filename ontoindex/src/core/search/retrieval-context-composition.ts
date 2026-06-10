export type RetrievalTier = 0 | 1 | 2 | 3;

export type RetrievalAltitude = 'local' | 'bridge' | 'global';

export type RetrievalCompositionFreshness = 'fresh' | 'stale' | 'degraded' | 'unknown';

export interface NavigationStep {
  source: string;
  action: string;
  target?: string;
  sequence?: number;
  details?: string;
  freshness?: RetrievalCompositionFreshness;
}

export interface RelatedRetrievalSymbol {
  id: string;
  label: string;
  relationType: string;
  score: number;
  source?: string;
  lane?: string;
  freshness?: RetrievalCompositionFreshness;
}

export interface TieredRetrievalCandidate {
  id: string;
  label: string;
  kind: string;
  tier: RetrievalTier;
  source: string;
  score: number;
  freshness: RetrievalCompositionFreshness;
  communityId: string;
  altitude: RetrievalAltitude;
  provenance: readonly NavigationStep[];
  relatedSymbols: readonly RelatedRetrievalSymbol[];
}

export interface TieredRetrievalCandidateInput {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  tier?: unknown;
  source?: unknown;
  sourceLane?: unknown;
  score?: unknown;
  freshness?: unknown;
  communityId?: unknown;
  altitude?: unknown;
  provenance?: readonly unknown[];
  relatedSymbols?: readonly unknown[];
}

export interface RetrievalCompositionLimits {
  maxCandidates: number;
  maxRelatedSymbolsPerCandidate: number;
  maxProvenanceStepsPerCandidate: number;
  maxWarnings: number;
}

export interface RetrievalContextCompositionInput {
  candidates?: readonly TieredRetrievalCandidateInput[];
  limits?: Partial<RetrievalCompositionLimits>;
}

export interface RetrievalContextCompositionReport {
  limits: RetrievalCompositionLimits;
  observed: {
    candidates: number;
    relatedSymbols: number;
    provenanceSteps: number;
    warnings: number;
  };
  emitted: {
    candidates: number;
    relatedSymbols: number;
    provenanceSteps: number;
  };
  byTier: Record<string, number>;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
  byFreshness: Record<RetrievalCompositionFreshness, number>;
  byCommunity: Record<string, number>;
  byAltitude: Record<RetrievalAltitude, number>;
  truncated: {
    candidates: boolean;
    relatedSymbols: boolean;
    provenanceSteps: boolean;
    warnings: boolean;
  };
  candidates: readonly TieredRetrievalCandidate[];
  warnings: readonly string[];
}

const KNOWN_TIERS = new Map<string, RetrievalTier>([
  ['0', 0],
  ['1', 1],
  ['2', 2],
  ['3', 3],
  ['repo', 0],
  ['system', 0],
  ['repository', 0],
  ['file', 1],
  ['module', 1],
  ['symbol', 2],
  ['fragment', 3],
  ['chunk', 3],
]);

const ALLOWED_FRESHNESS = new Set<RetrievalCompositionFreshness>([
  'fresh',
  'stale',
  'degraded',
  'unknown',
]);

const ALLOWED_ALTITUDES = new Set<RetrievalAltitude>(['local', 'bridge', 'global']);

const DEFAULT_LIMITS: RetrievalCompositionLimits = {
  maxCandidates: 64,
  maxRelatedSymbolsPerCandidate: 8,
  maxProvenanceStepsPerCandidate: 8,
  maxWarnings: 128,
};

interface InternalRelatedSymbol extends RelatedRetrievalSymbol {}

interface InternalCandidate {
  id: string;
  label: string;
  kind: string;
  tier: RetrievalTier;
  source: string;
  score: number;
  freshness: RetrievalCompositionFreshness;
  communityId: string;
  altitude: RetrievalAltitude;
  provenance: InternalNavigationStep[];
  relatedSymbols: InternalRelatedSymbol[];
}

interface InternalNavigationStep extends NavigationStep {
  source: string;
  action: string;
  sequence?: number;
}

export function composeRetrievalContext(input: RetrievalContextCompositionInput = {}): RetrievalContextCompositionReport {
  const limits = resolveLimits(input.limits);
  const warnings: string[] = [];

  const rawCandidates = input.candidates ?? [];
  const dedupedById = new Map<string, InternalCandidate>();

  for (const item of rawCandidates) {
    const normalized = normalizeCandidate(item, warnings);
    if (!normalized) continue;

    const existing = dedupedById.get(normalized.id);
    if (!existing) {
      dedupedById.set(normalized.id, normalized);
      continue;
    }

    warnings.push(`Duplicate candidate id "${normalized.id}" was merged.`);
    dedupedById.set(
      normalized.id,
      mergeCandidate(existing, normalized, warnings),
    );
  }

  const dedupedCandidates = Array.from(dedupedById.values()).sort(compareCandidate);

  const observed = {
    candidates: dedupedCandidates.length,
    relatedSymbols: dedupedCandidates.reduce((sum, candidate) => sum + candidate.relatedSymbols.length, 0),
    provenanceSteps: dedupedCandidates.reduce((sum, candidate) => sum + candidate.provenance.length, 0),
    warnings: 0,
  };

  const candidateIds = new Set(dedupedCandidates.map((candidate) => candidate.id));
  for (const candidate of dedupedCandidates) {
    for (const symbol of candidate.relatedSymbols) {
      const hasExplicitSourceHint =
        typeof symbol.source === 'string' && symbol.source.length > 0 ? symbol.source : undefined;
      const hasExplicitLaneHint =
        typeof symbol.lane === 'string' && symbol.lane.length > 0 ? symbol.lane : undefined;
      const isLikelyExternalRef =
        Boolean(hasExplicitSourceHint || hasExplicitLaneHint) &&
        Boolean(
          (hasExplicitSourceHint && hasExplicitSourceHint !== candidate.source) ||
            (hasExplicitLaneHint && hasExplicitLaneHint !== candidate.source),
        );

      if (!candidateIds.has(symbol.id) && !isLikelyExternalRef) {
        warnings.push(`Dangling related-symbol reference "${symbol.id}" in candidate "${candidate.id}".`);
      }
    }
  }

  const emittedCandidates = dedupedCandidates.slice(0, limits.maxCandidates).map((candidate) => ({
    ...candidate,
    provenance: applyProvenanceLimits(candidate.provenance, limits.maxProvenanceStepsPerCandidate),
    relatedSymbols: applyRelatedLimits(candidate.relatedSymbols, limits.maxRelatedSymbolsPerCandidate),
  }));

  const emitted = {
    candidates: emittedCandidates.length,
    relatedSymbols: emittedCandidates.reduce((sum, candidate) => sum + candidate.relatedSymbols.length, 0),
    provenanceSteps: emittedCandidates.reduce((sum, candidate) => sum + candidate.provenance.length, 0),
  };

  const truncated = {
    candidates: dedupedCandidates.length > limits.maxCandidates,
    relatedSymbols: emitted.relatedSymbols < observed.relatedSymbols,
    provenanceSteps: emitted.provenanceSteps < observed.provenanceSteps,
    warnings: false,
  };

  observed.warnings = warnings.length;
  let reportWarnings = uniqueWarnings(warnings);
  if (reportWarnings.length > limits.maxWarnings) {
    reportWarnings = reportWarnings.slice(0, limits.maxWarnings);
    truncated.warnings = true;
  }

  const normalizedWarnings = reportWarnings;
  if (truncated.warnings) {
    normalizedWarnings.push('Warning output was truncated by maxWarnings.');
  }

  const byTier = countTiers(dedupedCandidates);
  const byKind = countBy(dedupedCandidates, (candidate) => candidate.kind);
  const bySource = countBy(dedupedCandidates, (candidate) => candidate.source);
  const byCommunity = countBy(dedupedCandidates, (candidate) => candidate.communityId);
  const byFreshness = countFreshness(dedupedCandidates);
  const byAltitude = countAltitude(dedupedCandidates);

  return {
    limits,
    observed,
    emitted,
    byTier,
    byKind,
    bySource,
    byFreshness,
    byCommunity,
    byAltitude,
    truncated,
    candidates: emittedCandidates,
    warnings: normalizedWarnings,
  };
}

function resolveLimits(input: Partial<RetrievalCompositionLimits> = {}): RetrievalCompositionLimits {
  return {
    maxCandidates: normalizeLimit(input?.maxCandidates, DEFAULT_LIMITS.maxCandidates),
    maxRelatedSymbolsPerCandidate: normalizeLimit(
      input?.maxRelatedSymbolsPerCandidate,
      DEFAULT_LIMITS.maxRelatedSymbolsPerCandidate,
    ),
    maxProvenanceStepsPerCandidate: normalizeLimit(
      input?.maxProvenanceStepsPerCandidate,
      DEFAULT_LIMITS.maxProvenanceStepsPerCandidate,
    ),
    maxWarnings: normalizeLimit(input?.maxWarnings, DEFAULT_LIMITS.maxWarnings),
  };
}

function normalizeCandidate(
  input: TieredRetrievalCandidateInput | undefined,
  warnings: string[],
): InternalCandidate | null {
  if (!input || typeof input !== 'object') return null;

  const candidateId = normalizeText((input as Record<string, unknown>).id);
  if (candidateId.length === 0) {
    warnings.push('Skipped candidate without a usable id.');
    return null;
  }

  const score = normalizeScore((input as Record<string, unknown>).score, candidateId, warnings);
  const tier = normalizeTier((input as Record<string, unknown>).tier, candidateId, warnings);
  const freshness = normalizeFreshness((input as Record<string, unknown>).freshness, candidateId, warnings);
  const altitude = normalizeAltitude((input as Record<string, unknown>).altitude, candidateId, warnings);
  const source = normalizeText(
    (input as Record<string, unknown>).source ?? (input as Record<string, unknown>).sourceLane,
  );
  const rawProvenance = Array.isArray((input as Record<string, unknown>).provenance)
    ? ((input as Record<string, unknown>).provenance as readonly unknown[])
    : [];
  const rawRelated = Array.isArray((input as Record<string, unknown>).relatedSymbols)
    ? ((input as Record<string, unknown>).relatedSymbols as readonly unknown[])
    : [];

  return {
    id: candidateId,
    label: normalizeText((input as Record<string, unknown>).label, candidateId),
    kind: normalizeText((input as Record<string, unknown>).kind, 'symbol'),
    tier,
    source: source.length > 0 ? source : 'unknown',
    score,
    freshness,
    communityId: normalizeText((input as Record<string, unknown>).communityId, 'unknown'),
    altitude,
    provenance: normalizeProvenance(rawProvenance),
    relatedSymbols: normalizeRelatedSymbols(rawRelated),
  };
}

function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : fallback;
  }

  return fallback;
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : 0;
  }

  return fallback;
}

function normalizeScore(raw: unknown, candidateId: string, warnings: string[]): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

  warnings.push(`Invalid score for candidate "${candidateId}"; defaulting to 0.`);
  return 0;
}

function normalizeTier(
  raw: unknown,
  candidateId: string,
  warnings: string[],
): RetrievalTier {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 3) {
    return raw as RetrievalTier;
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    warnings.push(`Unknown tier "${raw}" for candidate "${candidateId}"; defaulting to 3.`);
    return 3;
  }

  const normalized = normalizeText(raw, '').toLowerCase();
  if (normalized.length > 0 && KNOWN_TIERS.has(normalized)) {
    return KNOWN_TIERS.get(normalized)!;
  }

  warnings.push(`Unknown tier "${String(raw)}" for candidate "${candidateId}"; defaulting to 3.`);
  return 3;
}

function normalizeFreshness(
  raw: unknown,
  candidateId: string,
  warnings: string[],
): RetrievalCompositionFreshness {
  const normalized = normalizeText(raw, '').toLowerCase() as RetrievalCompositionFreshness;
  if ((ALLOWED_FRESHNESS as ReadonlySet<string>).has(normalized)) {
    return normalized;
  }

  if (raw !== undefined && String(raw).trim().length > 0) {
    warnings.push(`Unknown freshness "${String(raw)}" for candidate "${candidateId}"; defaulting to unknown.`);
  }

  return 'unknown';
}

function normalizeAltitude(
  raw: unknown,
  candidateId: string,
  warnings: string[],
): RetrievalAltitude {
  const normalized = normalizeText(raw, '').toLowerCase();
  if ((ALLOWED_ALTITUDES as ReadonlySet<string>).has(normalized)) {
    return normalized as RetrievalAltitude;
  }

  if (raw !== undefined && String(raw).trim().length > 0) {
    warnings.push(`Unknown altitude "${String(raw)}" for candidate "${candidateId}"; defaulting to global.`);
  }

  return 'global';
}

function normalizeProvenance(rawSteps: readonly unknown[]): InternalNavigationStep[] {
  const normalized: InternalNavigationStep[] = [];
  for (const entry of rawSteps) {
    if (!entry || typeof entry !== 'object') continue;

    const source = normalizeText((entry as Record<string, unknown>).source, 'unknown');
    const action = normalizeText((entry as Record<string, unknown>).action, 'related');
    const target = normalizeText((entry as Record<string, unknown>).target);
    const details = normalizeText((entry as Record<string, unknown>).details);
    const sequence =
      typeof (entry as Record<string, unknown>).sequence === 'number'
        ? Math.trunc((entry as Record<string, unknown>).sequence as number)
        : undefined;
    const freshness = normalizeFreshness((entry as Record<string, unknown>).freshness, `${source}:${action}`, []);

    normalized.push({
      source,
      action,
      target: target.length > 0 ? target : undefined,
      details: details.length > 0 ? details : undefined,
      sequence: Number.isFinite(sequence) ? sequence : undefined,
      freshness,
    });
  }

  normalized.sort(compareProvenanceSteps);
  return normalized;
}

function normalizeRelatedSymbols(rawSymbols: readonly unknown[]): InternalRelatedSymbol[] {
  const normalized: InternalRelatedSymbol[] = [];
  for (const entry of rawSymbols) {
    if (!entry || typeof entry !== 'object') continue;
    const score = normalizeRelatedScore((entry as Record<string, unknown>).score);
    const relationType = normalizeText((entry as Record<string, unknown>).relationType, 'related');
    const id = normalizeText((entry as Record<string, unknown>).id);
    if (!id) continue;

    normalized.push({
      id,
      label: normalizeText((entry as Record<string, unknown>).label, id),
      relationType,
      score,
      source: normalizeText((entry as Record<string, unknown>).source),
      lane: normalizeText((entry as Record<string, unknown>).lane),
      freshness: normalizeFreshness((entry as Record<string, unknown>).freshness, id, []),
    });
  }

  normalized.sort(compareRelatedSymbols);
  return normalized;
}

function normalizeRelatedScore(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return 0;
}

function compareCandidate(left: InternalCandidate, right: InternalCandidate): number {
  if (left.tier !== right.tier) return left.tier - right.tier;
  if (left.score !== right.score) return right.score - left.score;
  const idCmp = left.id.localeCompare(right.id);
  if (idCmp !== 0) return idCmp;
  return left.label.localeCompare(right.label);
}

function compareProvenanceSteps(left: InternalNavigationStep, right: InternalNavigationStep): number {
  const leftHasSequence = typeof left.sequence === 'number';
  const rightHasSequence = typeof right.sequence === 'number';
  if (leftHasSequence && rightHasSequence) {
    if (left.sequence !== right.sequence) return (left.sequence as number) - (right.sequence as number);
  } else if (leftHasSequence) {
    return -1;
  } else if (rightHasSequence) {
    return 1;
  }

  return (
    left.source.localeCompare(right.source) ||
    left.action.localeCompare(right.action) ||
    left.target.localeCompare(right.target ?? '')
  );
}

function compareRelatedSymbols(left: InternalRelatedSymbol, right: InternalRelatedSymbol): number {
  return (
    left.relationType.localeCompare(right.relationType) ||
    (right.score - left.score) ||
    left.id.localeCompare(right.id) ||
    left.label.localeCompare(right.label)
  );
}

function mergeCandidate(
  existing: InternalCandidate,
  incoming: InternalCandidate,
  warnings: string[],
): InternalCandidate {
  const winner = compareCandidate(incoming, existing) < 0 ? incoming : existing;
  const loser = winner === existing ? incoming : existing;
  return {
    ...winner,
    provenance: mergeNavigationSteps(winner.provenance, loser.provenance, warnings),
    relatedSymbols: mergeRelatedSymbols(winner.relatedSymbols, loser.relatedSymbols, warnings),
  };
}

function mergeNavigationSteps(
  first: InternalNavigationStep[],
  second: InternalNavigationStep[],
  _warnings: string[],
): InternalNavigationStep[] {
  const seen = new Set<string>();
  const merged: InternalNavigationStep[] = [];

  const all = [...first, ...second].sort(compareProvenanceSteps);
  for (const step of all) {
    const key = `${step.source}|${step.action}|${step.target ?? ''}|${step.sequence ?? ''}|${step.details ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(step);
  }

  return merged;
}

function mergeRelatedSymbols(
  left: InternalRelatedSymbol[],
  right: InternalRelatedSymbol[],
  _warnings: string[],
): InternalRelatedSymbol[] {
  const merged = new Map<string, InternalRelatedSymbol>();

  for (const symbol of [...left, ...right]) {
    const relatedKey = `${symbol.id}|${symbol.relationType}|${symbol.source ?? ''}|${symbol.lane ?? ''}`;
    const current = merged.get(relatedKey);
    if (!current || symbol.score > current.score) {
      merged.set(relatedKey, symbol);
      continue;
    }
    if (symbol.score === current.score && symbol.label.localeCompare(current.label) < 0) {
      merged.set(relatedKey, symbol);
    }
  }

  return [...merged.values()].sort(compareRelatedSymbols);
}

function applyProvenanceLimits(steps: InternalNavigationStep[], limit: number): InternalNavigationStep[] {
  return typeof limit === 'number' && limit > 0 ? steps.slice(0, limit) : [];
}

function applyRelatedLimits(symbols: InternalRelatedSymbol[], limit: number): InternalRelatedSymbol[] {
  return typeof limit === 'number' && limit > 0 ? symbols.slice(0, limit) : [];
}

function uniqueWarnings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function countBy(items: readonly InternalCandidate[], access: (item: InternalCandidate) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = access(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function countFreshness(items: readonly InternalCandidate[]): Record<RetrievalCompositionFreshness, number> {
  const out: Record<RetrievalCompositionFreshness, number> = {
    fresh: 0,
    stale: 0,
    degraded: 0,
    unknown: 0,
  };
  for (const item of items) {
    out[item.freshness]++;
  }
  return out;
}

function countAltitude(items: readonly InternalCandidate[]): Record<RetrievalAltitude, number> {
  const out: Record<RetrievalAltitude, number> = {
    local: 0,
    bridge: 0,
    global: 0,
  };
  for (const item of items) {
    out[item.altitude]++;
  }
  return out;
}

function countTiers(items: readonly InternalCandidate[]): Record<string, number> {
  const out: Record<string, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const item of items) {
    out[item.tier]++;
  }
  return out;
}
