import type { EnrichmentRecordInput } from './enrichment-record.js';
import {
  CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
  type MarkdownChunkFact,
} from './markdown-document-facts.js';
import {
  MARKDOWN_DOCUMENT_ANALYZER_ID,
  MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION,
} from './markdown-sidecar-request.js';
import {
  hashText,
  produceMarkdownSidecarFacts,
  type MarkdownCodeMentionResolver,
} from './markdown-sidecar-producer.js';
import type { SidecarEnrichmentRequest } from './sidecar-request-pool.js';
import type { SidecarRunnerCallbacks, SidecarRunnerExecutionResult } from './sidecar-runner.js';
import type { LocalSidecarStore } from './sidecar-store.js';

export interface MarkdownSidecarDocumentInput {
  docPath: string;
  source: string;
  sourceCommitHash: string;
}

export interface MarkdownSidecarRunnerExecutorOptions {
  store: Pick<LocalSidecarStore, 'upsertEnrichment'>;
  documents: readonly MarkdownSidecarDocumentInput[];
  resolveCodeMention?: MarkdownCodeMentionResolver;
  excerptMaxBytes?: number;
  excerptMaxLines?: number;
}

export function createMarkdownSidecarRunnerExecutor(
  options: MarkdownSidecarRunnerExecutorOptions,
): SidecarRunnerCallbacks['executeRequest'] {
  return async (request, context) => runMarkdownSidecarRequest(request, context, options);
}

async function runMarkdownSidecarRequest(
  request: SidecarEnrichmentRequest,
  context: Parameters<SidecarRunnerCallbacks['executeRequest']>[1],
  options: MarkdownSidecarRunnerExecutorOptions,
): Promise<SidecarRunnerExecutionResult> {
  assertMarkdownDocumentRequest(request);

  for (const document of options.documents) {
    const record = createMarkdownEnrichmentRecord(request, document, options);
    await options.store.upsertEnrichment(record);
    if (!(await context.heartbeat())) {
      return { status: 'partial', failureReason: 'markdown sidecar heartbeat lost' };
    }
  }

  return { status: 'complete' };
}

function createMarkdownEnrichmentRecord(
  request: SidecarEnrichmentRequest,
  document: MarkdownSidecarDocumentInput,
  options: MarkdownSidecarRunnerExecutorOptions,
): EnrichmentRecordInput {
  const records = produceMarkdownSidecarFacts({
    docPath: document.docPath,
    source: document.source,
    sourceCommitHash: document.sourceCommitHash,
    options: {
      excerptMaxBytes: options.excerptMaxBytes,
      excerptMaxLines: options.excerptMaxLines,
      resolveCodeMention: options.resolveCodeMention,
    },
  });
  const chunk = records.find((fact): fact is MarkdownChunkFact => fact.kind === 'markdown-chunk');

  return {
    sourceIndexId: request.sourceIndexId,
    sourceCommitHash: document.sourceCommitHash,
    schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
    analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
    analyzerVersion: request.analyzerVersion,
    filePath: document.docPath,
    fileHash: chunk?.fileHash ?? hashText(document.source),
    status: 'complete',
    confidence: 1,
    records,
  };
}

function assertMarkdownDocumentRequest(request: SidecarEnrichmentRequest): void {
  if (request.analyzerId !== MARKDOWN_DOCUMENT_ANALYZER_ID) {
    throw new Error(`Markdown sidecar runner received non-Markdown request: ${request.analyzerId}`);
  }
  if (request.purpose !== 'markdown-document-enrichment') {
    throw new Error(`Markdown sidecar runner received unsupported purpose: ${request.purpose}`);
  }
  if (request.analyzerVersion.trim().length === 0) {
    throw new Error('Markdown sidecar runner received empty analyzerVersion');
  }
}

export { MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION };
