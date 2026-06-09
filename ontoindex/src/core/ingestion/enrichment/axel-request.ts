import { AXEL_ANALYZER_ID, AXEL_DEFAULT_ANALYZER_VERSION } from './axel-launch-contract.js';
import type { SidecarRequestInput, SidecarRequestPriority } from './sidecar-request-pool.js';

export interface AxelEnrichmentQueueInput {
  enabled: boolean;
  repoId: string;
  sourceIndexId: string;
  scopeHash: string;
  requestedAt: string | Date;
  analyzerVersion?: string;
  priority?: SidecarRequestPriority;
  expiresAt?: string | Date;
  sessionId?: string;
}

export type AxelEnrichmentQueueDecision =
  | {
      queued: false;
      reason: 'disabled';
    }
  | {
      queued: true;
      request: SidecarRequestInput;
    };

export function createAxelEnrichmentQueueRequest(
  input: AxelEnrichmentQueueInput,
): AxelEnrichmentQueueDecision {
  if (!input.enabled) {
    return { queued: false, reason: 'disabled' };
  }

  return {
    queued: true,
    request: {
      repoId: requireNonBlank(input.repoId, 'repoId'),
      sourceIndexId: requireNonBlank(input.sourceIndexId, 'sourceIndexId'),
      analyzerId: AXEL_ANALYZER_ID,
      analyzerVersion: input.analyzerVersion ?? AXEL_DEFAULT_ANALYZER_VERSION,
      purpose: 'architecture-enrichment',
      scopeHash: requireNonBlank(input.scopeHash, 'scopeHash'),
      priority: input.priority ?? 'background-remainder',
      requestedAt: input.requestedAt,
      expiresAt: input.expiresAt,
      durability: 'volatile',
      sessionId: input.sessionId,
    },
  };
}

function requireNonBlank(input: string, fieldName: string): string {
  if (input.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return input;
}
