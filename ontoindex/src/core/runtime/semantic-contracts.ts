import {
  assertEvidenceDiagnosticCategory,
  assertEvidenceDiagnosticKind,
  isEvidenceDiagnosticTruncationReason,
  type EvidenceDiagnosticRecord,
} from './evidence-diagnostics.js';
import type {
  MarkdownConceptConfidence,
  MarkdownKnowledgeAuthority,
} from '../ingestion/enrichment/markdown-concept-clusters.js';

type SemanticContractName =
  | 'quality-state-placement'
  | 'authority-consistency'
  | 'freshness-consistency'
  | 'docs-authority-boundary'
  | 'truncation-visibility'
  | 'citation-requirement';

type SemanticContractDiagnostic = Partial<Omit<EvidenceDiagnosticRecord, 'authority' | 'kind'>> & {
  authority?: MarkdownKnowledgeAuthority;
  confidence?: MarkdownConceptConfidence;
  kind?: string;
  linkedFiles?: readonly string[];
  linkedSymbols?: readonly string[];
  linkedGraphIdentities?: readonly string[];
};

interface SemanticEvidenceLink {
  subject?: string;
  source?: string;
  file?: string;
  path?: string;
  symbol?: string;
  graphIdentity?: string;
}

export interface SemanticContractInput {
  diagnostics: readonly SemanticContractDiagnostic[];
  graphFreshness?: string;
  evidenceLinks?: readonly SemanticEvidenceLink[];
  boundedOutput?: {
    evidenceOmitted?: boolean;
    omittedEvidenceCount?: number;
  };
  userFacing?: boolean;
}

export interface SemanticContractViolation {
  contract: SemanticContractName;
  subject: string;
  evidence: string;
  source: string;
  reason: string;
}

export interface SemanticContractResult {
  passed: boolean;
  violations: SemanticContractViolation[];
  summary: {
    total: number;
    byContract: Record<SemanticContractName, number>;
  };
}

const CONTRACTS: SemanticContractName[] = [
  'quality-state-placement',
  'authority-consistency',
  'freshness-consistency',
  'docs-authority-boundary',
  'truncation-visibility',
  'citation-requirement',
];

export function evaluateSemanticContracts(input: SemanticContractInput): SemanticContractResult {
  const violations: SemanticContractViolation[] = [];
  const requireCitations = input.userFacing !== false;

  for (const diagnostic of input.diagnostics) {
    evaluateQualityStatePlacement(diagnostic, violations);
    evaluateAuthorityConsistency(diagnostic, violations);
    evaluateFreshnessConsistency(diagnostic, input.graphFreshness, violations);
    evaluateDocsAuthorityBoundary(diagnostic, input.evidenceLinks ?? [], violations);

    if (requireCitations) {
      evaluateCitationRequirement(diagnostic, violations);
    }
  }

  evaluateTruncationVisibility(input, violations);

  return buildResult(violations);
}

export function summarizeSemanticContractResult(result: SemanticContractResult): string {
  if (result.passed) {
    return 'Semantic contracts passed (0 violations).';
  }

  const counts = CONTRACTS.map(
    (contract) => [contract, result.summary.byContract[contract]] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([contract, count]) => `${contract}: ${count}`)
    .join(', ');

  return `Semantic contracts failed (${result.summary.total} violations): ${counts}.`;
}

function evaluateQualityStatePlacement(
  diagnostic: SemanticContractDiagnostic,
  violations: SemanticContractViolation[],
): void {
  if (typeof diagnostic.category === 'string') {
    try {
      assertEvidenceDiagnosticCategory(diagnostic.category);
    } catch (error) {
      violations.push(violation('quality-state-placement', diagnostic, reasonFromError(error)));
    }
  }

  try {
    assertEvidenceDiagnosticKind(String(diagnostic.kind ?? ''));
  } catch (error) {
    violations.push(violation('quality-state-placement', diagnostic, reasonFromError(error)));
  }
}

function evaluateAuthorityConsistency(
  diagnostic: SemanticContractDiagnostic,
  violations: SemanticContractViolation[],
): void {
  if (diagnostic.authority === 'authoritative' && diagnostic.advisory === true) {
    violations.push(
      violation(
        'authority-consistency',
        diagnostic,
        'authoritative diagnostics cannot also be advisory',
      ),
    );
  }
}

function evaluateFreshnessConsistency(
  diagnostic: SemanticContractDiagnostic,
  graphFreshness: string | undefined,
  violations: SemanticContractViolation[],
): void {
  if (!isGraphDerived(diagnostic)) {
    return;
  }

  const freshness = diagnostic.freshness ?? graphFreshness;
  if (!isStaleOrDegraded(freshness)) {
    return;
  }

  const downgraded =
    diagnostic.authority === 'advisory' ||
    diagnostic.advisory === true ||
    diagnostic.degraded === true ||
    diagnostic.kind === 'degraded' ||
    diagnostic.kind === 'stale';

  if (!downgraded) {
    violations.push(
      violation(
        'freshness-consistency',
        diagnostic,
        'stale or degraded graph freshness must downgrade graph-derived claims',
      ),
    );
  }
}

function evaluateDocsAuthorityBoundary(
  diagnostic: SemanticContractDiagnostic,
  evidenceLinks: readonly SemanticEvidenceLink[],
  violations: SemanticContractViolation[],
): void {
  if (diagnostic.authority !== 'authoritative' || !isDocsDerived(diagnostic)) {
    return;
  }
  if (diagnostic.confidence === 'low') {
    violations.push(
      violation(
        'docs-authority-boundary',
        diagnostic,
        'authoritative docs evidence must have high confidence',
      ),
    );
  }
  if (!hasCodeOrGraphLink(diagnostic, evidenceLinks)) {
    violations.push(
      violation(
        'docs-authority-boundary',
        diagnostic,
        'docs evidence cannot be authoritative without linked code or graph evidence',
      ),
    );
  }
}

function evaluateTruncationVisibility(
  input: SemanticContractInput,
  violations: SemanticContractViolation[],
): void {
  const omittedEvidence =
    input.boundedOutput?.evidenceOmitted === true ||
    (input.boundedOutput?.omittedEvidenceCount ?? 0) > 0;

  if (!omittedEvidence) {
    return;
  }

  const hasTruncationDiagnostic = input.diagnostics.some(
    (diagnostic) =>
      diagnostic.truncated === true ||
      diagnostic.kind === 'truncated' ||
      isEvidenceDiagnosticTruncationReason(String(diagnostic.reason ?? '')),
  );

  if (!hasTruncationDiagnostic) {
    violations.push({
      contract: 'truncation-visibility',
      subject: 'bounded output',
      evidence: `omitted evidence count: ${input.boundedOutput?.omittedEvidenceCount ?? 'unknown'}`,
      source: 'semantic-contract-input',
      reason: 'bounded outputs that omit evidence must include a truncated diagnostic',
    });
  }
}

function evaluateCitationRequirement(
  diagnostic: SemanticContractDiagnostic,
  violations: SemanticContractViolation[],
): void {
  const missing = [
    isBlank(diagnostic.subject) ? 'subject' : '',
    isBlank(diagnostic.reason) ? 'evidence' : '',
    isBlank(diagnostic.source) ? 'source' : '',
  ].filter(Boolean);

  if (missing.length === 0) {
    return;
  }

  violations.push({
    contract: 'citation-requirement',
    subject: normalizedText(diagnostic.subject, 'uncited diagnostic'),
    evidence: diagnosticEvidence(diagnostic),
    source: normalizedText(diagnostic.source, 'semantic-contract-input'),
    reason: `user-facing diagnostics must cite ${missing.join(', ')}`,
  });
}

function buildResult(violations: SemanticContractViolation[]): SemanticContractResult {
  const byContract = CONTRACTS.reduce(
    (counts, contract) => {
      counts[contract] = 0;
      return counts;
    },
    {} as Record<SemanticContractName, number>,
  );

  for (const violationRecord of violations) {
    byContract[violationRecord.contract] += 1;
  }

  return {
    passed: violations.length === 0,
    violations,
    summary: {
      total: violations.length,
      byContract,
    },
  };
}

function violation(
  contract: SemanticContractName,
  diagnostic: SemanticContractDiagnostic,
  reason: string,
): SemanticContractViolation {
  return {
    contract,
    subject: normalizedText(diagnostic.subject, 'uncited diagnostic'),
    evidence: diagnosticEvidence(diagnostic),
    source: normalizedText(diagnostic.source, 'semantic-contract-input'),
    reason,
  };
}

function diagnosticEvidence(diagnostic: SemanticContractDiagnostic): string {
  const category = normalizedText(diagnostic.category, 'uncategorized');
  const kind = normalizedText(diagnostic.kind, 'unknown-kind');
  const authority = normalizedText(diagnostic.authority, 'unknown-authority');
  const reason = normalizedText(diagnostic.reason, 'no cited reason');
  return `${category}/${kind}/${authority}: ${reason}`;
}

function isGraphDerived(diagnostic: SemanticContractDiagnostic): boolean {
  return includesToken(diagnostic.source, 'graph') || includesToken(diagnostic.category, 'graph');
}

function isDocsDerived(diagnostic: SemanticContractDiagnostic): boolean {
  return (
    includesToken(diagnostic.source, 'doc') ||
    includesToken(diagnostic.source, 'adr') ||
    includesToken(diagnostic.category, 'doc') ||
    includesToken(diagnostic.category, 'adr')
  );
}

function hasCodeOrGraphLink(
  diagnostic: SemanticContractDiagnostic,
  evidenceLinks: readonly SemanticEvidenceLink[],
): boolean {
  if (
    hasValues(diagnostic.linkedFiles) ||
    hasValues(diagnostic.linkedSymbols) ||
    hasValues(diagnostic.linkedGraphIdentities)
  ) {
    return true;
  }

  return evidenceLinks.some((link) => {
    const matchesDiagnostic =
      !link.subject || link.subject === diagnostic.subject || link.source === diagnostic.source;
    const hasLink = Boolean(link.file || link.path || link.symbol || link.graphIdentity);
    return matchesDiagnostic && hasLink;
  });
}

function hasValues(values: readonly string[] | undefined): boolean {
  return Boolean(values?.some((value) => value.trim().length > 0));
}

function isStaleOrDegraded(value: string | undefined): boolean {
  return /\b(stale|degraded)\b/i.test(value ?? '');
}

function includesToken(value: string | undefined, token: string): boolean {
  return value?.toLowerCase().includes(token) ?? false;
}

function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

function normalizedText(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? value : fallback;
}

function reasonFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
