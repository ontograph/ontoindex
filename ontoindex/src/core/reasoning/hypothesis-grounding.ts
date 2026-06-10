import {
  type EvidenceDiagnosticAuthority,
  type EvidenceDiagnosticRecord,
} from '../runtime/evidence-diagnostics.js';

export interface DiscoveryHypothesis {
  id: string;
  statement: string;
  subject?: string;
}

export interface HypothesisPremise {
  id: string;
  statement: string;
  required?: boolean;
  evidenceKind?: 'docs' | 'code' | 'graph' | 'any';
}

export type GroundingRelationKind = 'supports' | 'refutes' | 'mentions' | 'ambiguous';

export interface GroundingCitation {
  filePath?: string;
  symbolName?: string;
  processId?: string;
  graphIdentity?: string;
  docPath?: string;
  diagnosticId?: string;
  repoPath?: string;
}

export interface GroundingEvidence {
  id: string;
  relation: GroundingRelationKind;
  premiseId?: string;
  citation: GroundingCitation;
  diagnostic?: EvidenceDiagnosticRecord;
}

export interface HypothesisGroundingInput {
  hypothesis: DiscoveryHypothesis;
  premises: readonly HypothesisPremise[];
  evidence: readonly GroundingEvidence[];
  maxEvidencePerPremise?: number;
  maxGaps?: number;
}

export type PremiseGroundingVerdictKind = 'supported' | 'refuted' | 'ambiguous' | 'missing';

export interface PremiseGroundingVerdict {
  premiseId: string;
  premiseStatement: string;
  required: boolean;
  status: PremiseGroundingVerdictKind;
  supportEvidenceIds: readonly string[];
  refuteEvidenceIds: readonly string[];
  otherEvidenceIds: readonly string[];
  reason: string;
}

export type GroundingGapKind =
  | 'missing-required-premise'
  | 'refuted-premise'
  | 'ambiguous-premise'
  | 'uncited-evidence'
  | 'truncated-evidence';

export interface GroundingGap {
  kind: GroundingGapKind;
  premiseId?: string;
  evidenceId?: string;
  reason: string;
  relatedEvidenceIds?: readonly string[];
}

export interface HypothesisGroundingSummary {
  premiseCount: number;
  requiredPremiseCount: number;
  evidenceCount: number;
  citedEvidenceCount: number;
  supportedPremiseCount: number;
  refutedPremiseCount: number;
  ambiguousPremiseCount: number;
  missingPremiseCount: number;
  missingRequiredPremiseCount: number;
  gapCount: number;
  uncitedEvidenceCount: number;
  truncatedEvidenceCount: number;
  truncatedGapCount: number;
  relationCounts: {
    supporting: number;
    refuting: number;
    other: number;
  };
}

export interface HypothesisGroundingReport {
  hypothesis: DiscoveryHypothesis;
  premiseVerdicts: readonly PremiseGroundingVerdict[];
  gapManifest: readonly GroundingGap[];
  diagnostics: readonly EvidenceDiagnosticRecord[];
  summary: HypothesisGroundingSummary;
}

const REPORT_DIAGNOSTIC_SOURCE = 'hypothesis-grounding';
const REPORT_DIAGNOSTIC_CATEGORY = 'runtime';

export function buildHypothesisGroundingReport(
  input: HypothesisGroundingInput,
): HypothesisGroundingReport {
  const hypothesis = normalizeHypothesis(input.hypothesis);
  const maxEvidencePerPremise = normalizePositiveLimit(input.maxEvidencePerPremise);
  const maxGaps = normalizePositiveLimit(input.maxGaps);

  const premises = input.premises.map((premise) => normalizePremise(premise));
  const premiseById = new Map<string, HypothesisPremise>(
    premises.map((premise) => [premise.id, premise]),
  );

  const evidenceByPremise = new Map<string, GroundingEvidence[]>();
  const diagnostics: EvidenceDiagnosticRecord[] = [];
  const gaps: GroundingGap[] = [];

  let uncitedEvidenceCount = 0;
  let truncatedEvidenceCount = 0;
  const relationCounts = {
    supporting: 0,
    refuting: 0,
    other: 0,
  };

  for (const evidence of input.evidence) {
    if (evidence.diagnostic) {
      diagnostics.push(evidence.diagnostic);
    }

    if (!evidence.premiseId || !evidence.premiseId.trim()) {
      diagnostics.push(
        makeDiagnostic({
          kind: 'ambiguous',
          subject: hypothesis.id,
          reason: `Unmapped evidence \"${evidence.id}\" cannot be used without a premise id.`,
          ambiguous: true,
        }),
      );
      continue;
    }

    const premise = premiseById.get(evidence.premiseId.trim());
    if (!premise) {
      diagnostics.push(
        makeDiagnostic({
          kind: 'ambiguous',
          subject: evidence.premiseId,
          reason: `Evidence \"${evidence.id}\" references unknown premise \"${evidence.premiseId}\".`,
          ambiguous: true,
        }),
      );
      continue;
    }

    if (!hasUsableCitation(evidence.citation)) {
      uncitedEvidenceCount += 1;
      const normalizedCitation = `evidence ${evidence.id} for premise ${premise.id}`;
      diagnostics.push(
        makeDiagnostic({
          kind: 'ambiguous',
          subject: premise.id,
          reason: `${normalizedCitation} has no usable citation and cannot satisfy a premise.`,
          ambiguous: true,
        }),
      );
      gaps.push({
        kind: 'uncited-evidence',
        premiseId: premise.id,
        evidenceId: evidence.id,
        reason: `${normalizedCitation} has no usable citation.`,
      });
      continue;
    }

    if (!evidenceFitsPremise(evidence, premise)) {
      uncitedEvidenceCount += 1;
      const normalizedCitation = `evidence ${evidence.id} for premise ${premise.id}`;
      diagnostics.push(
        makeDiagnostic({
          kind: 'ambiguous',
          subject: premise.id,
          reason: `${normalizedCitation} cannot support this premise because the citation is docs-only for a non-doc premise.`,
          ambiguous: true,
        }),
      );
      gaps.push({
        kind: 'uncited-evidence',
        premiseId: premise.id,
        evidenceId: evidence.id,
        reason: `${normalizedCitation} cannot support a ${premise.evidenceKind ?? 'any'} premise with docs-only citation.`,
      });
      continue;
    }

    const bucket = evidenceByPremise.get(premise.id);
    if (bucket) {
      bucket.push(evidence);
    } else {
      evidenceByPremise.set(premise.id, [evidence]);
    }
    if (evidence.relation === 'supports') {
      relationCounts.supporting += 1;
    } else if (evidence.relation === 'refutes') {
      relationCounts.refuting += 1;
    } else {
      relationCounts.other += 1;
    }
  }

  const premiseVerdicts: PremiseGroundingVerdict[] = [];
  for (const premise of premises) {
    const rawEvidence = evidenceByPremise.get(premise.id) ?? [];
    const effectiveEvidence =
      maxEvidencePerPremise !== undefined && rawEvidence.length > maxEvidencePerPremise
        ? rawEvidence.slice(0, maxEvidencePerPremise)
        : rawEvidence;

    if (rawEvidence.length > effectiveEvidence.length) {
      const omittedEvidenceCount = rawEvidence.length - effectiveEvidence.length;
      truncatedEvidenceCount += omittedEvidenceCount;
      diagnostics.push(
        makeDiagnostic({
          kind: 'truncated',
          subject: premise.id,
          reason: `Evidence for premise ${premise.id} capped at ${maxEvidencePerPremise}; ${omittedEvidenceCount} omitted.`,
          count: omittedEvidenceCount,
          truncated: true,
        }),
      );
      gaps.push({
        kind: 'truncated-evidence',
        premiseId: premise.id,
        reason: `Evidence for premise ${premise.id} was truncated; ${omittedEvidenceCount} omitted.`,
        relatedEvidenceIds: rawEvidence.slice(effectiveEvidence.length).map((item) => item.id),
      });
    }

    const supportEvidenceIds = effectiveEvidence
      .filter((item) => item.relation === 'supports')
      .map((item) => item.id);
    const refuteEvidenceIds = effectiveEvidence
      .filter((item) => item.relation === 'refutes')
      .map((item) => item.id);
    const otherEvidenceIds = effectiveEvidence
      .filter((item) => item.relation === 'mentions' || item.relation === 'ambiguous')
      .map((item) => item.id);

    const required = premise.required !== false;
    const verdict = computePremiseVerdict({
      supportCount: supportEvidenceIds.length,
      refuteCount: refuteEvidenceIds.length,
      required,
      hasAmbiguousEvidence: otherEvidenceIds.length > 0,
      premiseId: premise.id,
    });

    premiseVerdicts.push({
      premiseId: premise.id,
      premiseStatement: premise.statement,
      required,
      status: verdict.status,
      supportEvidenceIds,
      refuteEvidenceIds,
      otherEvidenceIds,
      reason: verdict.reason,
    });

    if (verdict.gapKind) {
      gaps.push({
        kind: verdict.gapKind,
        premiseId: premise.id,
        reason: verdict.reason,
        relatedEvidenceIds: verdict.relatedEvidenceIds,
      });
    }
  }

  const boundedGaps = applyGapCap(gaps, maxGaps);
  const omittedGapCount = Math.max(0, gaps.length - boundedGaps.length);
  if (omittedGapCount > 0) {
    diagnostics.push(
      makeDiagnostic({
        kind: 'truncated',
        subject: hypothesis.id,
        reason: `Gap manifest capped at ${maxGaps}; ${omittedGapCount} omitted.`,
        count: omittedGapCount,
        truncated: true,
      }),
    );
  }

  const summary = buildSummary({
    premises,
    premisesVerdicts: premiseVerdicts,
    evidenceCount: input.evidence.length,
    citedEvidenceCount: input.evidence.length - uncitedEvidenceCount,
    uncitedEvidenceCount,
    omittedGaps: omittedGapCount,
    truncatedEvidenceCount,
    relationCounts,
  });

  return {
    hypothesis,
    premiseVerdicts,
    gapManifest: boundedGaps,
    diagnostics,
    summary,
  };
}

function normalizeHypothesis(input: DiscoveryHypothesis): DiscoveryHypothesis {
  return {
    id: input.id.trim(),
    statement: input.statement.trim(),
    ...(input.subject ? { subject: input.subject.trim() } : {}),
  };
}

function normalizePremise(input: HypothesisPremise): HypothesisPremise {
  return {
    id: input.id.trim(),
    statement: input.statement.trim(),
    required: input.required !== false,
    evidenceKind: input.evidenceKind ?? 'any',
  };
}

function normalizePositiveLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasUsableCitation(citation: GroundingCitation | undefined): boolean {
  if (!citation) return false;
  return (
    hasText(citation.filePath) ||
    hasText(citation.symbolName) ||
    hasText(citation.processId) ||
    hasText(citation.graphIdentity) ||
    hasText(citation.docPath) ||
    hasText(citation.diagnosticId) ||
    hasText(citation.repoPath)
  );
}

function hasCodeOrGraphCitation(citation: GroundingCitation): boolean {
  return (
    hasText(citation.filePath) ||
    hasText(citation.symbolName) ||
    hasText(citation.processId) ||
    hasText(citation.graphIdentity)
  );
}

function evidenceFitsPremise(evidence: GroundingEvidence, premise: HypothesisPremise): boolean {
  if (premise.evidenceKind === 'code' || premise.evidenceKind === 'graph') {
    return hasCodeOrGraphCitation(evidence.citation);
  }
  if (premise.evidenceKind === 'docs') {
    return hasUsableCitation(evidence.citation);
  }
  return hasUsableCitation(evidence.citation);
}

function computePremiseVerdict(input: {
  supportCount: number;
  refuteCount: number;
  required: boolean;
  hasAmbiguousEvidence: boolean;
  premiseId: string;
}): {
  status: PremiseGroundingVerdictKind;
  reason: string;
  gapKind?: GroundingGapKind;
  relatedEvidenceIds?: readonly string[];
} {
  if (input.supportCount > 0 && input.refuteCount > 0) {
    return {
      status: 'ambiguous',
      gapKind: 'ambiguous-premise',
      relatedEvidenceIds: undefined,
      reason: `Premise ${input.premiseId} is ambiguous because it has both support and refute evidence.`,
    };
  }
  if (input.refuteCount > 0) {
    return {
      status: 'refuted',
      gapKind: 'refuted-premise',
      reason: `Premise ${input.premiseId} is refuted by collected evidence.`,
    };
  }
  if (input.supportCount > 0) {
    if (input.hasAmbiguousEvidence) {
      return {
        status: 'supported',
        reason: `Premise ${input.premiseId} is supported.`,
      };
    }
    return {
      status: 'supported',
      reason: `Premise ${input.premiseId} is supported.`,
    };
  }

  if (input.required) {
    return {
      status: 'missing',
      gapKind: 'missing-required-premise',
      reason: `Premise ${input.premiseId} is required but has no supporting evidence.`,
    };
  }

  if (input.hasAmbiguousEvidence) {
    return {
      status: 'ambiguous',
      gapKind: 'ambiguous-premise',
      reason: `Premise ${input.premiseId} has only ambiguous evidence.`,
    };
  }

  return {
    status: 'missing',
    reason: `Premise ${input.premiseId} has no supporting evidence.`,
  };
}

function applyGapCap(gaps: readonly GroundingGap[], maxGaps: number | undefined): GroundingGap[] {
  if (maxGaps === undefined) return [...gaps];
  return maxGaps <= 0 ? [] : [...gaps].slice(0, maxGaps);
}

function makeDiagnostic(input: {
  kind: 'ambiguous' | 'truncated' | 'extracted' | 'inferred' | 'stale' | 'degraded';
  subject: string;
  reason: string;
  count?: number;
  ambiguous?: boolean;
  truncated?: boolean;
}): EvidenceDiagnosticRecord {
  const authority: EvidenceDiagnosticAuthority = 'advisory';
  return {
    category: REPORT_DIAGNOSTIC_CATEGORY,
    kind: input.kind,
    source: REPORT_DIAGNOSTIC_SOURCE,
    authority,
    subject: input.subject,
    reason: input.reason,
    advisory: true,
    count: input.count,
    ...(input.ambiguous === true ? { ambiguous: true } : {}),
    ...(input.truncated === true ? { truncated: true, degraded: true } : {}),
  };
}

function buildSummary(data: {
  premises: readonly HypothesisPremise[];
  premisesVerdicts: readonly PremiseGroundingVerdict[];
  evidenceCount: number;
  citedEvidenceCount: number;
  uncitedEvidenceCount: number;
  omittedGaps: number;
  truncatedEvidenceCount: number;
  relationCounts: { supporting: number; refuting: number; other: number };
}): HypothesisGroundingSummary {
  return {
    premiseCount: data.premises.length,
    requiredPremiseCount: data.premises.filter((premise) => premise.required !== false).length,
    evidenceCount: data.evidenceCount,
    citedEvidenceCount: data.citedEvidenceCount,
    supportedPremiseCount: data.premisesVerdicts.filter((verdict) => verdict.status === 'supported').length,
    refutedPremiseCount: data.premisesVerdicts.filter((verdict) => verdict.status === 'refuted').length,
    ambiguousPremiseCount: data.premisesVerdicts.filter((verdict) => verdict.status === 'ambiguous').length,
    missingPremiseCount: data.premisesVerdicts.filter((verdict) => verdict.status === 'missing').length,
    missingRequiredPremiseCount: data.premisesVerdicts.filter(
      (verdict) => verdict.status === 'missing' && verdict.required,
    ).length,
    gapCount: Math.max(
      0,
      data.omittedGaps +
        data.premisesVerdicts.filter(
          (verdict) =>
            verdict.status === 'missing' ||
            verdict.status === 'ambiguous' ||
            verdict.status === 'refuted',
        ).length,
    ),
    uncitedEvidenceCount: data.uncitedEvidenceCount,
    truncatedEvidenceCount: data.truncatedEvidenceCount,
    truncatedGapCount: data.omittedGaps,
    relationCounts: data.relationCounts,
  };
}
