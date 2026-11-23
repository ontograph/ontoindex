import { isHttpMode } from './http-client.js';

export class EmbeddingRevisionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingRevisionMismatchError';
  }
}

export function getConfiguredEmbeddingRevision(): string | undefined {
  if (isHttpMode()) return undefined;
  return process.env.ONTOINDEX_EMBEDDING_REVISION?.trim() || undefined;
}

export function getEmbeddingRevisionMismatch(
  indexedRevision: string | undefined,
  configuredRevision = getConfiguredEmbeddingRevision(),
): string | undefined {
  const indexed = indexedRevision?.trim() || undefined;
  if (indexed === configuredRevision) return undefined;
  if (!indexed && !configuredRevision) return undefined;

  return (
    `Embedding revision mismatch: index uses "${indexed ?? 'unrecorded/default'}" but this runtime uses "${configuredRevision ?? 'default'}". ` +
    'Keep the indexed revision or run `ontoindex clean` and re-analyze before changing ONTOINDEX_EMBEDDING_REVISION.'
  );
}
