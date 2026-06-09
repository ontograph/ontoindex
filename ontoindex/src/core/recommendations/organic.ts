import { getCallableToolNames } from '../../mcp/shared/tool-registry.js';
import {
  DEFAULT_ORGANIC_NON_TOOL_ACTION_NAMES,
  ORGANIC_RECOMMENDATION_CONFIDENCE_LEVELS,
  ORGANIC_RECOMMENDATION_EVIDENCE_CLASSES,
  ORGANIC_RECOMMENDATION_TARGET_KINDS,
  type OrganicNonToolAction,
  type OrganicRecommendation,
  type OrganicRecommendationEvidenceClass,
  type OrganicRecommendationDraft,
  type OrganicRecommendationNextStep,
  type OrganicRecommendationTarget,
  type OrganicRecommendationValidationError,
  type OrganicRecommendationValidationResult,
} from './types.js';

const TARGET_KINDS = new Set<string>(ORGANIC_RECOMMENDATION_TARGET_KINDS);
const CONFIDENCE_LEVELS = new Set<string>(ORGANIC_RECOMMENDATION_CONFIDENCE_LEVELS);
const EVIDENCE_CLASSES = new Set<string>(ORGANIC_RECOMMENDATION_EVIDENCE_CLASSES);

const DEFAULT_AUTHORITATIVE_EVIDENCE_CLASSES: readonly OrganicRecommendationEvidenceClass[] = [
  'graph_evidence',
  'audit_evidence',
];

const DEFAULT_LOW_AUTHORITY_EVIDENCE_CLASSES: readonly OrganicRecommendationEvidenceClass[] = [
  'runtime_diagnostic',
  'advisory_memory',
  'docs_evidence',
];

export interface OrganicRecommendationGateOptions {
  callableToolNames?: readonly string[];
  nonToolActionNames?: readonly string[];
  authoritativeEvidenceClasses?: readonly OrganicRecommendationEvidenceClass[];
  lowAuthorityEvidenceClasses?: readonly OrganicRecommendationEvidenceClass[];
}

export function emitOrganicRecommendation(
  input: OrganicRecommendationDraft,
  options: OrganicRecommendationGateOptions = {},
): OrganicRecommendation {
  const result = validateOrganicRecommendation(input, options);
  if (!('errors' in result)) return result.value;

  const summary = result.errors.map((error) => `${error.field}: ${error.message}`).join('; ');
  throw new Error(`organic recommendation rejected: ${summary}`);
}

export function validateOrganicRecommendation(
  input: OrganicRecommendationDraft,
  options: OrganicRecommendationGateOptions = {},
): OrganicRecommendationValidationResult {
  const errors: OrganicRecommendationValidationError[] = [];
  const id = requiredText(input.id, 'id', errors);
  const action = requiredText(input.action, 'action', errors);
  const reason = requiredText(input.reason, 'reason', errors);
  const evidenceIds = uniqueNonEmptyStrings(input.evidenceIds);
  if (evidenceIds.length === 0) {
    errors.push({
      field: 'evidenceIds',
      message: 'must include at least one evidence id',
      value: input.evidenceIds,
    });
  }
  const evidenceClasses = normalizeEvidenceClasses(input.evidenceClasses, errors);

  const target = normalizeTarget(input.target, errors);
  if (reason && target && !reasonReferencesConcreteFact(reason, target, evidenceIds)) {
    errors.push({
      field: 'reason',
      message: 'must reference the concrete target or one of the evidence ids',
      value: reason,
    });
  }

  const confidence = normalizeConfidence(input.confidence, errors);
  const normalizedNextTools = normalizeNextSteps(input.nextTools ?? [], options, errors);

  if (errors.length > 0 || target === null || confidence === null || evidenceClasses === null) {
    return { ok: false, errors };
  }

  ensureConfidenceAuthority(confidence, evidenceClasses, options, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      id,
      action,
      target,
      reason,
      confidence,
      evidenceIds,
      evidenceClasses,
      scoreTrace: input.scoreTrace,
      nextTools: normalizedNextTools.nextTools,
      nonToolActions: normalizedNextTools.nonToolActions,
    },
  };
}

export function isOrganicNonToolAction(value: unknown): value is OrganicNonToolAction {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).kind === 'non-tool-action' &&
    typeof (value as Record<string, unknown>).name === 'string'
  );
}

function normalizeTarget(
  target: OrganicRecommendationDraft['target'],
  errors: OrganicRecommendationValidationError[],
): OrganicRecommendationTarget | null {
  if (target === null || typeof target !== 'object') {
    errors.push({
      field: 'target',
      message: 'must be an object with kind and name',
      value: target,
    });
    return null;
  }

  const kind = typeof target.kind === 'string' ? target.kind.trim() : '';
  const name = typeof target.name === 'string' ? target.name.trim() : '';
  const filePath =
    typeof target.filePath === 'string' && target.filePath.trim()
      ? target.filePath.trim()
      : undefined;
  const startLine =
    typeof target.startLine === 'number' &&
    Number.isInteger(target.startLine) &&
    target.startLine > 0
      ? target.startLine
      : undefined;

  if (!TARGET_KINDS.has(kind)) {
    errors.push({
      field: 'target.kind',
      message: `must be one of ${Array.from(TARGET_KINDS).join(', ')}`,
      value: target.kind,
    });
  }
  if (!name) {
    errors.push({
      field: 'target.name',
      message: 'must be a concrete non-empty target name',
      value: target.name,
    });
  }

  if (!TARGET_KINDS.has(kind) || !name) return null;
  return { kind: kind as OrganicRecommendationTarget['kind'], name, filePath, startLine };
}

function normalizeConfidence(
  confidence: OrganicRecommendationDraft['confidence'],
  errors: OrganicRecommendationValidationError[],
): OrganicRecommendation['confidence'] | null {
  const normalized = typeof confidence === 'string' ? confidence.trim() : '';
  if (!CONFIDENCE_LEVELS.has(normalized)) {
    errors.push({
      field: 'confidence',
      message: `must be one of ${Array.from(CONFIDENCE_LEVELS).join(', ')}`,
      value: confidence,
    });
    return null;
  }
  return normalized as OrganicRecommendation['confidence'];
}

function normalizeEvidenceClasses(
  evidenceClasses: OrganicRecommendationDraft['evidenceClasses'],
  errors: OrganicRecommendationValidationError[],
): OrganicRecommendationEvidenceClass[] | null {
  if (!Array.isArray(evidenceClasses)) {
    errors.push({
      field: 'evidenceClasses',
      message: `must be a non-empty list containing only ${Array.from(EVIDENCE_CLASSES).join(', ')}`,
      value: evidenceClasses,
    });
    return null;
  }

  const normalized = uniqueNonEmptyStrings(
    evidenceClasses.map((value) => (typeof value === 'string' ? value : '')),
  );
  if (normalized.length === 0) {
    errors.push({
      field: 'evidenceClasses',
      message: 'must include at least one evidence class',
      value: evidenceClasses,
    });
    return null;
  }

  const invalid = normalized.filter((value) => !EVIDENCE_CLASSES.has(value));
  if (invalid.length > 0) {
    errors.push({
      field: 'evidenceClasses',
      message: `contains unsupported evidence classes: ${invalid.join(', ')}`,
      value: evidenceClasses,
    });
    return null;
  }

  return normalized as OrganicRecommendationEvidenceClass[];
}

function ensureConfidenceAuthority(
  confidence: OrganicRecommendation['confidence'],
  evidenceClasses: readonly OrganicRecommendationEvidenceClass[],
  options: OrganicRecommendationGateOptions,
  errors: OrganicRecommendationValidationError[],
): void {
  if (confidence !== 'high') return;

  const authoritativeClasses = new Set<OrganicRecommendationEvidenceClass>(
    (options.authoritativeEvidenceClasses ?? DEFAULT_AUTHORITATIVE_EVIDENCE_CLASSES).filter(
      (evidenceClass) => EVIDENCE_CLASSES.has(evidenceClass),
    ),
  );
  const hasAuthoritativeEvidence = evidenceClasses.some((evidenceClass) =>
    authoritativeClasses.has(evidenceClass),
  );
  if (hasAuthoritativeEvidence) return;

  const lowAuthorityClasses = new Set<OrganicRecommendationEvidenceClass>(
    (options.lowAuthorityEvidenceClasses ?? DEFAULT_LOW_AUTHORITY_EVIDENCE_CLASSES).filter(
      (evidenceClass) => EVIDENCE_CLASSES.has(evidenceClass),
    ),
  );
  const lowAuthorityOnly = evidenceClasses.every((evidenceClass) =>
    lowAuthorityClasses.has(evidenceClass),
  );
  const expected = Array.from(authoritativeClasses).join(', ');
  errors.push({
    field: 'confidence',
    message: lowAuthorityOnly
      ? `high confidence requires authoritative evidence (${expected}); low-authority-only evidence classes are insufficient`
      : `high confidence requires at least one authoritative evidence class (${expected})`,
    value: { confidence, evidenceClasses },
  });
}

function normalizeNextSteps(
  nextSteps: readonly OrganicRecommendationNextStep[],
  options: OrganicRecommendationGateOptions,
  errors: OrganicRecommendationValidationError[],
): { nextTools: string[]; nonToolActions: string[] } {
  const callableToolNames = new Set(
    options.callableToolNames ?? getCallableToolNames({ includeFacades: true }),
  );
  const nonToolActionNames = new Set(
    options.nonToolActionNames ?? DEFAULT_ORGANIC_NON_TOOL_ACTION_NAMES,
  );
  const nextTools: string[] = [];
  const nonToolActions: string[] = [];

  nextSteps.forEach((step, index) => {
    if (typeof step === 'string') {
      const toolName = step.trim();
      if (callableToolNames.has(toolName)) {
        nextTools.push(toolName);
        return;
      }
      errors.push({
        field: `nextTools[${index}]`,
        message:
          'must be a public callable tool name; use an explicit { kind: "non-tool-action", name } marker for non-tool actions',
        value: step,
      });
      return;
    }

    if (isOrganicNonToolAction(step)) {
      const actionName = step.name.trim();
      if (nonToolActionNames.has(actionName)) {
        nonToolActions.push(actionName);
        return;
      }
      errors.push({
        field: `nextTools[${index}]`,
        message: 'uses an unsupported non-tool action name',
        value: step,
      });
      return;
    }

    errors.push({
      field: `nextTools[${index}]`,
      message: 'must be a tool name or explicit non-tool action marker',
      value: step,
    });
  });

  return {
    nextTools: unique(nextTools),
    nonToolActions: unique(nonToolActions),
  };
}

function reasonReferencesConcreteFact(
  reason: string,
  target: OrganicRecommendationTarget,
  evidenceIds: readonly string[],
): boolean {
  const haystack = normalizeText(reason);
  const concreteNeedles = [
    target.name,
    target.filePath,
    target.filePath ? lastPathSegment(target.filePath) : undefined,
    ...evidenceIds,
  ]
    .map(normalizeText)
    .filter((value) => value.length >= 3);

  return concreteNeedles.some((needle) => haystack.includes(needle));
}

function requiredText(
  value: unknown,
  field: string,
  errors: OrganicRecommendationValidationError[],
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    errors.push({
      field,
      message: 'must be a non-empty string',
      value,
    });
  }
  return normalized;
}

function uniqueNonEmptyStrings(values: readonly string[] | undefined): string[] {
  return unique(
    (values ?? [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0),
  );
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeText(value: string | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function lastPathSegment(filePath: string): string {
  const segments = filePath.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : filePath;
}
