import type { SidecarRequestInput, SidecarRequestPriority } from './sidecar-request-pool.js';

export const MARKDOWN_DOCUMENT_ANALYZER_ID = 'markdown-document-sidecar';
export const MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION = '1.0.0';

export interface MarkdownDocumentEnrichmentQueueInput {
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

export type MarkdownDocumentEnrichmentQueueDecision =
  | {
      queued: false;
      reason: 'disabled';
    }
  | {
      queued: true;
      request: SidecarRequestInput;
    };

export function createMarkdownDocumentEnrichmentQueueRequest(
  input: MarkdownDocumentEnrichmentQueueInput,
): MarkdownDocumentEnrichmentQueueDecision {
  if (!input.enabled) {
    return { queued: false, reason: 'disabled' };
  }

  return {
    queued: true,
    request: {
      repoId: requireNonBlank(input.repoId, 'repoId'),
      sourceIndexId: requireNonBlank(input.sourceIndexId, 'sourceIndexId'),
      analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
      analyzerVersion: input.analyzerVersion ?? MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION,
      purpose: 'markdown-document-enrichment',
      scopeHash: requireNonBlank(input.scopeHash, 'scopeHash'),
      priority: input.priority ?? 'background-remainder',
      requestedAt: input.requestedAt,
      expiresAt: input.expiresAt,
      durability: 'persistent',
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
