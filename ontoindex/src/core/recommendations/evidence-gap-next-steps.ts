import { validateOrganicRecommendation } from './organic.js';
import {
  DEFAULT_ORGANIC_NON_TOOL_ACTION_NAMES,
  type OrganicRecommendationNextStep,
  type OrganicRecommendationValidationError,
} from './types.js';

export const EVIDENCE_GAP_CONDITIONS = [
  'stale_index',
  'tool_contract_drift',
  'docs_only_code_behavior_claim',
  'edit_risk_without_impact_evidence',
  'audit_finding_without_replay_evidence',
  'runtime_diagnostic_support',
  'unknown_evidence_class',
] as const;

export type EvidenceGapCondition = (typeof EVIDENCE_GAP_CONDITIONS)[number];

export const EVIDENCE_GAP_NON_TOOL_ACTION_NAMES = [
  'fix_registry_drift',
  'verify_graph_or_code_evidence',
  'mark_advisory_degraded',
  'classify_or_downgrade_evidence',
] as const;

export type EvidenceGapNonToolActionName = (typeof EVIDENCE_GAP_NON_TOOL_ACTION_NAMES)[number];

export interface EvidenceGapNextStep {
  kind: 'tool' | 'non-tool-action';
  name: string;
  condition: EvidenceGapCondition;
  reason: string;
}

export interface EvidenceGapNextStepIssue {
  condition: string;
  field: string;
  message: string;
  value?: unknown;
}

export interface EvidenceGapNextStepOptions {
  callableToolNames?: readonly string[];
  nonToolActionNames?: readonly string[];
}

export interface EvidenceGapNextStepResult {
  nextSteps: EvidenceGapNextStep[];
  nextTools: string[];
  nonToolActions: string[];
  issues: EvidenceGapNextStepIssue[];
}

type EvidenceGapNextStepCandidate = Omit<EvidenceGapNextStep, 'condition'>;

const CONDITION_SET = new Set<string>(EVIDENCE_GAP_CONDITIONS);

const DEFAULT_NON_TOOL_ACTION_NAMES = [
  ...DEFAULT_ORGANIC_NON_TOOL_ACTION_NAMES,
  ...EVIDENCE_GAP_NON_TOOL_ACTION_NAMES,
] as const;

const NEXT_STEPS_BY_CONDITION: Record<
  EvidenceGapCondition,
  readonly EvidenceGapNextStepCandidate[]
> = {
  stale_index: [
    {
      kind: 'tool',
      name: 'gn_ensure_fresh',
      reason: 'Refresh or report stale graph/index evidence before retrieval-heavy work.',
    },
  ],
  tool_contract_drift: [
    {
      kind: 'tool',
      name: 'gn_tool_contract',
      reason: 'Verify advertised tools against the registered callable frontier.',
    },
    {
      kind: 'non-tool-action',
      name: 'fix_registry_drift',
      reason: 'Reconcile registry, help, or runtime drift after contract evidence identifies it.',
    },
  ],
  docs_only_code_behavior_claim: [
    {
      kind: 'non-tool-action',
      name: 'verify_graph_or_code_evidence',
      reason:
        'Promote docs-only behavior claims only after graph or direct code evidence confirms them.',
    },
  ],
  edit_risk_without_impact_evidence: [
    {
      kind: 'tool',
      name: 'gn_safe_edit_check',
      reason: 'Collect pre-edit impact evidence before changing the target symbol.',
    },
  ],
  audit_finding_without_replay_evidence: [
    {
      kind: 'tool',
      name: 'gn_audit_replay',
      reason: 'Replay audit findings against the target HEAD before accepting status evidence.',
    },
  ],
  runtime_diagnostic_support: [
    {
      kind: 'non-tool-action',
      name: 'mark_advisory_degraded',
      reason:
        'Runtime diagnostics can support advisory/degraded guidance, not authoritative claims.',
    },
  ],
  unknown_evidence_class: [
    {
      kind: 'non-tool-action',
      name: 'classify_or_downgrade_evidence',
      reason:
        'Classify unknown evidence before recommending, or downgrade the recommendation authority.',
    },
  ],
};

export function recommendEvidenceGapNextSteps(
  conditions: readonly string[],
  options: EvidenceGapNextStepOptions = {},
): EvidenceGapNextStepResult {
  const nextSteps: EvidenceGapNextStep[] = [];
  const issues: EvidenceGapNextStepIssue[] = [];
  const seen = new Set<string>();

  for (const requestedCondition of conditions) {
    const condition = normalizeCondition(requestedCondition, issues);
    for (const candidate of NEXT_STEPS_BY_CONDITION[condition]) {
      const validationErrors = validateCandidate(condition, candidate, options);
      if (validationErrors.length > 0) {
        issues.push(
          ...validationErrors.map((error) => ({
            condition,
            field: error.field,
            message: error.message,
            value: error.value,
          })),
        );
        continue;
      }

      const key = `${candidate.kind}:${candidate.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      nextSteps.push({ ...candidate, condition });
    }
  }

  return {
    nextSteps,
    nextTools: nextSteps.filter((step) => step.kind === 'tool').map((step) => step.name),
    nonToolActions: nextSteps
      .filter((step) => step.kind === 'non-tool-action')
      .map((step) => step.name),
    issues,
  };
}

function normalizeCondition(
  requestedCondition: string,
  issues: EvidenceGapNextStepIssue[],
): EvidenceGapCondition {
  const condition = requestedCondition.trim();
  if (CONDITION_SET.has(condition)) return condition as EvidenceGapCondition;

  issues.push({
    condition: requestedCondition,
    field: 'condition',
    message: 'unrecognized evidence gap condition; using unknown_evidence_class downgrade action',
    value: requestedCondition,
  });
  return 'unknown_evidence_class';
}

function validateCandidate(
  condition: EvidenceGapCondition,
  candidate: EvidenceGapNextStepCandidate,
  options: EvidenceGapNextStepOptions,
): OrganicRecommendationValidationError[] {
  const nextStep: OrganicRecommendationNextStep =
    candidate.kind === 'tool' ? candidate.name : { kind: 'non-tool-action', name: candidate.name };
  const result = validateOrganicRecommendation(
    {
      id: `evidence-gap-next-step:${condition}:${candidate.kind}:${candidate.name}`,
      action: 'resolve-evidence-gap-next-step',
      target: { kind: 'process', name: condition },
      reason: `${condition} is resolved by evidence-gap-next-step-map through ${candidate.name}.`,
      confidence: 'low',
      evidenceIds: ['evidence-gap-next-step-map'],
      evidenceClasses: ['runtime_diagnostic'],
      nextTools: [nextStep],
    },
    {
      callableToolNames: options.callableToolNames,
      nonToolActionNames: options.nonToolActionNames ?? DEFAULT_NON_TOOL_ACTION_NAMES,
    },
  );

  return 'errors' in result ? result.errors : [];
}
