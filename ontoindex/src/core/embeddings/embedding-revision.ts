import { isHttpMode } from './http-client.js';
import { DEFAULT_EMBEDDING_CONFIG } from './types.js';

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

export function getConfiguredEmbeddingModelId(override?: string): string {
  return (
    override?.trim() ||
    process.env.ONTOINDEX_EMBEDDING_MODEL?.trim() ||
    DEFAULT_EMBEDDING_CONFIG.modelId
  );
}

export function getEmbeddingRevisionMismatch(
  indexedRevision: string | undefined,
  configuredRevision = getConfiguredEmbeddingRevision(),
  indexedModelHash?: string,
  configuredModelHash:
    | string
    | null
    | undefined = process.env.ONTOINDEX_EMBEDDING_MODEL_HASH?.trim() || undefined,
  configuredModelId = getConfiguredEmbeddingModelId(),
): string | undefined {
  const indexed = indexedRevision?.trim() || undefined;
  const configured = configuredRevision?.trim() || undefined;
  const indexedHash = indexedModelHash?.trim() || undefined;
  const runtimeHash = configuredModelHash === null ? undefined : configuredModelHash?.trim() || undefined;

  if (indexedHash && runtimeHash && indexedHash !== runtimeHash) {
    return (
      `Embedding model mismatch: index uses "${indexedHash}" but this runtime uses "${runtimeHash}". ` +
      'Use the indexed model identity or rebuild embeddings with the configured model.'
    );
  }

  // Explicit metadata is authoritative. Never let a model-hash suffix override
  // a separately recorded revision.
  if (indexed) {
    if (indexed === configured) {
      const expectedIdentity = `${configuredModelId}@${configured}`;
      if (indexedHash && indexedHash.includes('@') && indexedHash !== expectedIdentity) {
        return (
          `Embedding model mismatch: index identity "${indexedHash}" does not match the configured ` +
          `model and revision "${expectedIdentity}".`
        );
      }
      if (indexedHash && !runtimeHash && indexedHash !== expectedIdentity) {
        return (
          `Embedding model identity is unverified: meta.json records "${indexedHash}" but this runtime ` +
          `cannot confirm it matches "${expectedIdentity}".`
        );
      }
      return undefined;
    }
  } else if (configured) {
    const legacyIdentity = `${configuredModelId}@${configured}`;
    if (
      indexedHash === legacyIdentity &&
      (!runtimeHash || runtimeHash === legacyIdentity)
    ) {
      return undefined;
    }
  } else if (!indexedHash) {
    return undefined;
  } else {
    // With no explicit revision, accept only an exact configured identity. A
    // legacy `model@revision` cannot be verified when the runtime uses HTTP or
    // otherwise has no configured revision.
    const configuredIdentity = runtimeHash ?? configuredModelId;
    if (!(isHttpMode() && indexedHash.includes('@')) && indexedHash === configuredIdentity) {
      return undefined;
    }
  }

  return (
    `Embedding revision mismatch: index uses "${indexed ?? indexedHash ?? 'unrecorded/default'}" but this runtime uses "${configured ?? 'unverified/default'}". ` +
    'Use the indexed model and revision, or rebuild embeddings with a verified model identity before changing ONTOINDEX_EMBEDDING_REVISION.'
  );
}
