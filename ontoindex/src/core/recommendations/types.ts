export const ORGANIC_RECOMMENDATION_TARGET_KINDS = [
  'symbol',
  'file',
  'process',
  'doc',
  'test',
  'route',
] as const;

export type OrganicRecommendationTargetKind = (typeof ORGANIC_RECOMMENDATION_TARGET_KINDS)[number];

export const ORGANIC_RECOMMENDATION_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;

export type OrganicRecommendationConfidence =
  (typeof ORGANIC_RECOMMENDATION_CONFIDENCE_LEVELS)[number];

export const ORGANIC_RECOMMENDATION_EVIDENCE_CLASSES = EVIDENCE_READ_CLASSES;

export type OrganicRecommendationEvidenceClass = EvidenceReadClass;

export interface OrganicRecommendationTarget {
  kind: OrganicRecommendationTargetKind;
  name: string;
  filePath?: string;
  startLine?: number;
}

export interface OrganicNonToolAction {
  kind: 'non-tool-action';
  name: string;
}

export type OrganicRecommendationNextStep = string | OrganicNonToolAction;

export interface OrganicRecommendationDraft {
  id: string;
  action: string;
  target: OrganicRecommendationTarget;
  reason: string;
  confidence: OrganicRecommendationConfidence;
  evidenceIds: readonly string[];
  evidenceClasses: readonly OrganicRecommendationEvidenceClass[];
  scoreTrace?: unknown;
  nextTools?: readonly OrganicRecommendationNextStep[];
}

export interface OrganicRecommendation {
  id: string;
  action: string;
  target: OrganicRecommendationTarget;
  reason: string;
  confidence: OrganicRecommendationConfidence;
  evidenceIds: string[];
  evidenceClasses: OrganicRecommendationEvidenceClass[];
  scoreTrace?: unknown;
  nextTools: string[];
  nonToolActions: string[];
}

export interface OrganicRecommendationValidationError {
  field: string;
  message: string;
  value?: unknown;
}

export type OrganicRecommendationValidationResult =
  | {
      ok: true;
      value: OrganicRecommendation;
    }
  | {
      ok: false;
      errors: OrganicRecommendationValidationError[];
    };

export const DEFAULT_ORGANIC_NON_TOOL_ACTION_NAMES = ['manual_patch_with_guard'] as const;

export type OrganicNonToolActionName = (typeof DEFAULT_ORGANIC_NON_TOOL_ACTION_NAMES)[number];
import { EVIDENCE_READ_CLASSES, type EvidenceReadClass } from '../runtime/evidence-read-ledger.js';
