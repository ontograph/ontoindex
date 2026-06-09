/**
 * CE Reranker singleton (W2b-v11 — Pillar 2).
 *
 * Uses AutoTokenizer + AutoModelForSequenceClassification + sigmoid forward
 * pass — NOT pipeline('text-classification') which saturates to 1.0 silently
 * (per W2a-v10 finding, probe-ce-reranker.ts).
 *
 * Activated by ONTOINDEX_CE_RERANK=<model-id>. When env is unset this module
 * should not be imported by callers (gate check in backend-search.ts).
 *
 * trust_remote_code is intentionally NOT enabled (security boundary).
 *
 * W2b-v11: scoreCEBatch uses batched tokenizer + single model forward pass
 * (per W2a-v11 probe: 776ms cold / 456ms warm vs 4843ms sequential, 6-12×).
 * Sub-batching caps padding overhead via ONTOINDEX_CE_BATCH_CAP (default 30).
 * ONTOINDEX_CE_FORCE_SEQUENTIAL=1 forces the old sequential path (debug/fallback).
 */

// Suppress ONNX Runtime native warnings before any onnxruntime import.
if (!process.env.ORT_LOG_LEVEL) {
  process.env.ORT_LOG_LEVEL = '3';
}

import { env, AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';

type CERerankTensorData = ArrayLike<number>;

interface CERerankTensor {
  data: CERerankTensorData;
}

interface CERerankTokenizerOutput {
  input_ids: unknown;
  attention_mask: unknown;
  token_type_ids?: unknown;
}

interface CERerankTokenizerOptions<TText extends string | string[]> {
  text_pair?: TText extends string ? string | null : string[] | null;
  padding?: boolean | 'max_length';
  truncation?: boolean | null;
  max_length?: number | null;
}

type CERerankTokenizer = <TText extends string | string[]>(
  text: TText,
  options?: CERerankTokenizerOptions<TText>,
) => CERerankTokenizerOutput | Promise<CERerankTokenizerOutput>;

interface CERerankModelOutput {
  logits: CERerankTensor;
}

type CERerankModel = (inputs: CERerankTokenizerOutput) => Promise<CERerankModelOutput>;

// Module-level singleton state (mirrors embedder.ts pattern).
let tokenizerInstance: CERerankTokenizer | null = null;
let modelInstance: CERerankModel | null = null;
let isInitializing = false;
let initPromise: Promise<void> | null = null;

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// W2b-v11 batch config: cap sub-batch size to bound padding overhead from
// mixed-length docs (W2a risk flag: uniform synthetic docs underestimate real
// corpus padding).  Default 30 keeps p50 well under 800ms budget.
const MAX_RERANK_BATCH = parseInt(process.env.ONTOINDEX_CE_BATCH_CAP ?? '30', 10);

/**
 * Lazy-load the CE model + tokenizer identified by ONTOINDEX_CE_RERANK.
 * Idempotent: subsequent calls return immediately once loaded.
 */
async function initCEReranker(): Promise<void> {
  if (tokenizerInstance && modelInstance) return;
  if (isInitializing && initPromise) return initPromise;

  const modelId = process.env.ONTOINDEX_CE_RERANK;
  if (!modelId) {
    throw new Error('[ce-reranker] ONTOINDEX_CE_RERANK is not set — CE reranker cannot be loaded.');
  }

  isInitializing = true;
  initPromise = (async () => {
    try {
      env.allowLocalModels = true;
      env.cacheDir = process.env.HF_HOME ?? `${process.env.HOME}/.cache/huggingface`;

      console.error(`OntoIndex [ce-reranker]: Loading CE model ${modelId} …`);

      tokenizerInstance = (await AutoTokenizer.from_pretrained(modelId)) as CERerankTokenizer;
      modelInstance = (await AutoModelForSequenceClassification.from_pretrained(modelId, {
        dtype: 'fp32',
        device: 'cpu',
        // trust_remote_code intentionally omitted (security boundary).
      })) as CERerankModel;

      console.error(`OntoIndex [ce-reranker]: CE model loaded (${modelId})`);
    } catch (error) {
      isInitializing = false;
      initPromise = null;
      tokenizerInstance = null;
      modelInstance = null;
      throw error;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
}

/**
 * Score a single (query, doc) pair.
 * Delegates to scoreCEBatchInner with a single-element array.
 * Returns a calibrated relevance probability in [0, 1] via sigmoid(logit[0]).
 */
export async function scoreCEPair(query: string, doc: string): Promise<number> {
  await initCEReranker();
  const scores = await scoreCEBatchInner(query, [doc]);
  return scores[0];
}

/**
 * Score a batch of (query, doc) pairs using batched tokenizer + single model
 * forward pass (W2b-v11). Falls back to sequential when
 * ONTOINDEX_CE_FORCE_SEQUENTIAL=1.
 *
 * Large batches are split into sub-batches of MAX_RERANK_BATCH (default 30)
 * to bound padding overhead from variable-length real-corpus docs.
 *
 * Returns scores array aligned with docs[].
 */
export async function scoreCEBatch(query: string, docs: string[]): Promise<number[]> {
  if (docs.length === 0) return [];
  await initCEReranker();

  // Debug/fallback: sequential path preserved for comparison or emergency.
  if (process.env.ONTOINDEX_CE_FORCE_SEQUENTIAL === '1') {
    const scores: number[] = [];
    for (const doc of docs) {
      const inputs = await tokenizerInstance!(query, {
        text_pair: doc,
        padding: true,
        truncation: true,
        max_length: 512,
      });
      const output = await modelInstance!(inputs);
      scores.push(sigmoid(output.logits.data[0]));
    }
    return scores;
  }

  // Batched path: process in sub-batches of MAX_RERANK_BATCH.
  const allScores: number[] = [];
  for (let i = 0; i < docs.length; i += MAX_RERANK_BATCH) {
    const subBatch = docs.slice(i, i + MAX_RERANK_BATCH);
    const subScores = await scoreCEBatchInner(query, subBatch);
    allScores.push(...subScores);
  }
  return allScores;
}

/**
 * Inner batched inference: single tokenizer call + single model forward pass.
 * docs must be non-empty.
 */
async function scoreCEBatchInner(query: string, docs: string[]): Promise<number[]> {
  const tokenizer = tokenizerInstance!;
  const model = modelInstance!;
  const inputs = await tokenizer(Array(docs.length).fill(query), {
    text_pair: docs,
    padding: true,
    truncation: true,
    max_length: 512,
  });
  const out = await model(inputs);
  // out.logits.data is Float32Array of length docs.length (single relevance
  // logit per pair for jina-reranker-v1-tiny-en, shape [N, 1]).
  return Array.from(out.logits.data).map((x: number) => sigmoid(x));
}
