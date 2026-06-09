/**
 * HTTP Embedding Client
 *
 * Shared fetch+retry logic for OpenAI-compatible /v1/embeddings endpoints.
 * Imported by both the core embedder (batch) and MCP embedder (query).
 */

import pLimit from 'p-limit';

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BACKOFF_MS = 1_000;
const HTTP_BATCH_SIZE = 64;
const DEFAULT_DIMS = 384;
const HTTP_EMBED_CONCURRENCY = 4;

const limit = pLimit(HTTP_EMBED_CONCURRENCY);

interface HttpConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number;
}

/**
 * Build config from the current process.env snapshot.
 * Returns null when ONTOINDEX_EMBEDDING_URL + ONTOINDEX_EMBEDDING_MODEL are unset.
 * Not cached — env vars are read fresh so late configuration takes effect.
 */
const readConfig = (): HttpConfig | null => {
  const baseUrl = process.env.ONTOINDEX_EMBEDDING_URL;
  const model = process.env.ONTOINDEX_EMBEDDING_MODEL;
  if (!baseUrl || !model) return null;

  const rawDims = process.env.ONTOINDEX_EMBEDDING_DIMS;
  let dimensions: number | undefined;
  if (rawDims !== undefined) {
    const parsed = parseInt(rawDims, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`ONTOINDEX_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`);
    }
    dimensions = parsed;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: process.env.ONTOINDEX_EMBEDDING_API_KEY ?? 'unused',
    dimensions,
  };
};

/**
 * Check whether HTTP embedding mode is active (env vars are set).
 */
export const isHttpMode = (): boolean => readConfig() !== null;

/**
 * Return the configured embedding dimensions for HTTP mode, or undefined
 * if HTTP mode is not active or no explicit dimensions are set.
 */
export const getHttpDimensions = (): number | undefined => readConfig()?.dimensions;

/**
 * Return a safe representation of a URL for error messages.
 * Strips query string (may contain tokens) and userinfo.
 */
const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
};

interface EmbeddingItem {
  embedding: number[];
}

/**
 * Send a single batch of texts to the embedding endpoint with retry.
 *
 * @param url - Full endpoint URL (e.g. https://host/v1/embeddings)
 * @param batch - Texts to embed
 * @param model - Model name for the request body
 * @param apiKey - Bearer token (only used in Authorization header)
 * @param batchIndex - Logical batch number (for error context)
 * @param attempt - Current retry attempt (internal)
 */
const httpEmbedBatch = async (
  url: string,
  batch: string[],
  model: string,
  apiKey: string,
  batchIndex = 0,
  attempt = 0,
): Promise<EmbeddingItem[]> => {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: batch, model }),
    });
  } catch (err) {
    // Timeouts should not be retried — the server is unresponsive.
    // AbortSignal.timeout() throws DOMException with name 'TimeoutError'.
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    if (isTimeout) {
      throw new Error(
        `Embedding request timed out after ${HTTP_TIMEOUT_MS}ms (${safeUrl(url)}, batch ${batchIndex})`,
      );
    }
    // DNS, connection errors — retry with backoff
    if (attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, batchIndex, attempt + 1);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Embedding request failed (${safeUrl(url)}, batch ${batchIndex}): ${reason}`);
  }

  if (!resp.ok) {
    const status = resp.status;
    if ((status === 429 || status >= 500) && attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, batchIndex, attempt + 1);
    }
    throw new Error(`Embedding endpoint returned ${status} (${safeUrl(url)}, batch ${batchIndex})`);
  }

  const body = (await resp.json()) as {
    data?: EmbeddingItem[];
    error?: unknown;
    errors?: unknown;
    detail?: unknown;
  };

  // Guard: some providers return {"error":"..."} or {"detail":"..."} with HTTP 200.
  // Confirmed: routerai.ru/api/v1 with mistral-embed-2312 returns exactly this.
  if (typeof body.error === 'string') {
    throw new Error(`HTTP embedder error (status ${resp.status}): ${body.error}`);
  }
  if (typeof body.detail === 'string') {
    throw new Error(`HTTP embedder error (status ${resp.status}): ${body.detail}`);
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const msgs = (body.errors as Array<{ message?: string }>)
      .map((e) => e.message ?? 'unknown')
      .join('; ');
    throw new Error(`HTTP embedder errors (status ${resp.status}): ${msgs}`);
  }

  return (body.data ?? []) as EmbeddingItem[];
};

/**
 * Embed texts via the HTTP backend, splitting into batches.
 * Reads config from env vars on every call.
 *
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embedding vectors
 */
export const httpEmbed = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];

  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;

  const allVectors: Float32Array[] = [];
  const windowSize = HTTP_BATCH_SIZE * HTTP_EMBED_CONCURRENCY;

  for (let start = 0; start < texts.length; start += windowSize) {
    const windowTexts = texts.slice(start, start + windowSize);
    const batches = Array.from(
      { length: Math.ceil(windowTexts.length / HTTP_BATCH_SIZE) },
      (_, i) => ({
        batch: windowTexts.slice(i * HTTP_BATCH_SIZE, (i + 1) * HTTP_BATCH_SIZE),
        batchIndex: Math.floor(start / HTTP_BATCH_SIZE) + i,
      }),
    );

    const batchResults = await Promise.all(
      batches.map(({ batch, batchIndex }) =>
        limit(() => httpEmbedBatch(url, batch, config.model, config.apiKey, batchIndex)),
      ),
    );

    for (let i = 0; i < batches.length; i++) {
      const items = batchResults[i];
      const { batch, batchIndex } = batches[i];

      if (items.length !== batch.length) {
        throw new Error(
          `Embedding endpoint returned ${items.length} vectors for ${batch.length} texts ` +
            `(${safeUrl(url)}, batch ${batchIndex})`,
        );
      }

      for (const item of items) {
        const vec = new Float32Array(item.embedding);
        // Fail fast on dimension mismatch rather than inserting bad vectors
        // into the FLOAT[N] column which would cause a cryptic Kuzu error.
        const expected = config.dimensions ?? DEFAULT_DIMS;
        if (vec.length !== expected) {
          const hint = config.dimensions
            ? 'Update ONTOINDEX_EMBEDDING_DIMS to match your model output.'
            : `Set ONTOINDEX_EMBEDDING_DIMS=${vec.length} to match your model output.`;
          throw new Error(
            `Embedding dimension mismatch: endpoint returned ${vec.length}d vector, ` +
              `but expected ${expected}d. ${hint}`,
          );
        }

        allVectors.push(vec);
      }
    }
  }

  return allVectors;
};

/**
 * Embed a single query text via the HTTP backend.
 * Convenience for MCP search where only one vector is needed.
 *
 * @param text - Query text to embed
 * @returns Embedding vector as number array
 */
export const httpEmbedQuery = async (text: string): Promise<number[]> => {
  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const items = await httpEmbedBatch(url, [text], config.model, config.apiKey);
  if (!items.length) {
    throw new Error(`Embedding endpoint returned empty response (${safeUrl(url)})`);
  }

  const embedding = items[0].embedding;
  // Same dimension checks as httpEmbed — catch mismatches before they
  // reach the Kuzu FLOAT[N] cast in search queries.
  const expected = config.dimensions ?? DEFAULT_DIMS;
  if (embedding.length !== expected) {
    const hint = config.dimensions
      ? 'Update ONTOINDEX_EMBEDDING_DIMS to match your model output.'
      : `Set ONTOINDEX_EMBEDDING_DIMS=${embedding.length} to match your model output.`;
    throw new Error(
      `Embedding dimension mismatch: endpoint returned ${embedding.length}d vector, ` +
        `but expected ${expected}d. ${hint}`,
    );
  }
  return embedding;
};
