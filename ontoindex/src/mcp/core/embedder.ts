/**
 * Embedder Module (Read-Only)
 *
 * Singleton factory for transformers.js embedding pipeline.
 * For MCP, we only need to compute query embeddings, not batch embed.
 */

// Suppress ONNX Runtime native warnings (e.g. VerifyEachNodeIsAssignedToAnEp)
// Must be set BEFORE onnxruntime-node is imported by transformers.js
// Level 3 = Error only (skips Warning/Info)
if (!process.env.ORT_LOG_LEVEL) {
  process.env.ORT_LOG_LEVEL = '3';
}

import {
  pipeline,
  env,
  type FeatureExtractionPipeline,
  type PretrainedModelOptions,
} from '@huggingface/transformers';
import {
  isHttpMode,
  getHttpDimensions,
  httpEmbedQuery,
} from '../../core/embeddings/http-client.js';
import { silenceStdout, restoreStdout, realStderrWrite } from '../../core/lbug/pool-adapter.js';
import { isCudaAvailable } from '../../core/embeddings/cuda-probe.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../../core/embeddings/types.js';

// Model config — single source of truth in DEFAULT_EMBEDDING_CONFIG.modelId
const MODEL_ID = DEFAULT_EMBEDDING_CONFIG.modelId;

// Module-level state for singleton pattern
let embedderInstance: FeatureExtractionPipeline | null = null;
let isInitializing = false;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

type FeatureExtractionPipelineFactory = (
  task: 'feature-extraction',
  model: string,
  options: PretrainedModelOptions,
) => Promise<FeatureExtractionPipeline>;

type StderrWrite = {
  (buffer: Uint8Array | string, cb?: (err?: Error | null) => void): boolean;
  (str: string, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean;
};

const createFeatureExtractionPipeline: FeatureExtractionPipelineFactory = pipeline;
const silentStderrWrite: StderrWrite = () => true;

/**
 * Initialize the embedding model (lazy, on first search)
 */
export const initEmbedder = async (): Promise<FeatureExtractionPipeline> => {
  if (isHttpMode()) {
    throw new Error('initEmbedder() should not be called in HTTP mode.');
  }

  if (embedderInstance) {
    return embedderInstance;
  }

  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;

  initPromise = (async () => {
    try {
      env.allowLocalModels = false;
      // Default cache to user-writable location. transformers.js defaults to
      // ./node_modules/.cache inside its own install dir, which is unwritable
      // when ontoindex is installed globally (e.g. /usr/lib/node_modules/).
      // Respect HF_HOME if set, otherwise fall back to ~/.cache/huggingface.
      env.cacheDir = process.env.HF_HOME ?? `${process.env.HOME}/.cache/huggingface`;

      console.error('OntoIndex: Loading embedding model (first search may take a moment)...');

      // Probe for CUDA before attempting it — ONNX Runtime crashes (uncatchable native
      // error) if we request CUDA without the required shared libraries present.
      // On Linux without onnxruntime CUDA provider, fall through directly to CPU.
      const isWindows = process.platform === 'win32';
      const gpuDevice: 'dml' | 'cuda' | 'cpu' = isWindows
        ? 'dml'
        : isCudaAvailable()
          ? 'cuda'
          : 'cpu';
      const devicesToTry: Array<'dml' | 'cuda' | 'cpu'> =
        gpuDevice === 'cpu' ? ['cpu'] : [gpuDevice, 'cpu'];

      for (const device of devicesToTry) {
        try {
          // Silence stdout and stderr during model load — ONNX Runtime and transformers.js
          // may write progress/init messages that corrupt MCP stdio protocol or produce
          // noisy warnings (e.g. node assignment to execution providers).
          // Use the centralized silenceStdout() to avoid conflicts with pool-adapter's
          // own stdout patching (independent patching caused restore-order bugs).
          silenceStdout();
          process.stderr.write = silentStderrWrite;
          try {
            embedderInstance = await createFeatureExtractionPipeline(
              'feature-extraction',
              MODEL_ID,
              {
                device: device,
                dtype: 'fp32',
                session_options: { logSeverityLevel: 3 },
              },
            );
          } finally {
            restoreStdout();
            process.stderr.write = realStderrWrite;
          }
          console.error(`OntoIndex: Embedding model loaded (${device})`);
          return embedderInstance!;
        } catch {
          if (device === 'cpu') throw new Error('Failed to load embedding model');
        }
      }

      throw new Error('No suitable device found');
    } catch (error) {
      isInitializing = false;
      initPromise = null;
      embedderInstance = null;
      throw error;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
};

/**
 * Check if embedder is ready
 */
export const isEmbedderReady = (): boolean => isHttpMode() || embedderInstance !== null;

/**
 * Embed a query text for semantic search
 */
export const embedQuery = async (query: string): Promise<number[]> => {
  if (isHttpMode()) {
    return httpEmbedQuery(query);
  }

  const embedder = await initEmbedder();

  const result = await embedder(query, {
    pooling: 'mean',
    normalize: true,
  });

  return Array.from(result.data as ArrayLike<number>);
};

/**
 * Get embedding dimensions
 */
export const getEmbeddingDims = (): number => {
  return getHttpDimensions() ?? parseInt(process.env.ONTOINDEX_EMBEDDING_DIMS ?? '384', 10);
};

/**
 * Cleanup embedder
 */
export const disposeEmbedder = async (): Promise<void> => {
  if (embedderInstance) {
    try {
      if ('dispose' in embedderInstance && typeof embedderInstance.dispose === 'function') {
        await embedderInstance.dispose();
      }
    } catch {}
    embedderInstance = null;
    initPromise = null;
  }
};
