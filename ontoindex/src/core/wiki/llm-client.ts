/**
 * LLM Client for Wiki Generation
 *
 * OpenAI-compatible API client using native fetch.
 * Supports OpenAI, Azure, LiteLLM, Ollama, and any OpenAI-compatible endpoint.
 *
 * Config priority: CLI flags > env vars > defaults
 */

export type LLMProvider = 'openai' | 'openrouter' | 'azure' | 'custom' | 'cursor';

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** Provider type — controls auth header behaviour */
  provider?: 'openai' | 'openrouter' | 'azure' | 'custom' | 'cursor';
  /** Azure api-version query param (e.g. '2024-10-21'). Appended to URL when set. */
  apiVersion?: string;
  /** When true, strips sampling params and uses max_completion_tokens instead of max_tokens */
  isReasoningModel?: boolean;
}

export interface LLMResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Resolve LLM configuration from env vars, saved config, and optional overrides.
 * Priority: overrides (CLI flags) > env vars > ~/.ontoindex/config.json > error
 *
 * If no API key is found, returns config with empty apiKey (caller should handle).
 */
export async function resolveLLMConfig(overrides?: Partial<LLMConfig>): Promise<LLMConfig> {
  const { loadCLIConfig } = await import('../../storage/repo-manager.js');
  const savedConfig = await loadCLIConfig();

  const apiKey =
    overrides?.apiKey ||
    process.env.ONTOINDEX_API_KEY ||
    process.env.OPENAI_API_KEY ||
    savedConfig.apiKey ||
    '';

  return {
    apiKey,
    baseUrl:
      overrides?.baseUrl ||
      process.env.ONTOINDEX_LLM_BASE_URL ||
      savedConfig.baseUrl ||
      'https://openrouter.ai/api/v1',
    model:
      overrides?.model ||
      process.env.ONTOINDEX_MODEL ||
      (savedConfig.provider === 'cursor' ? savedConfig.cursorModel : undefined) ||
      savedConfig.model ||
      'minimax/minimax-m2.5',
    maxTokens: overrides?.maxTokens ?? 16_384,
    temperature: overrides?.temperature ?? 0,
    provider: overrides?.provider ?? savedConfig.provider ?? 'openai',
    apiVersion:
      overrides?.apiVersion || process.env.ONTOINDEX_AZURE_API_VERSION || savedConfig.apiVersion,
    isReasoningModel: overrides?.isReasoningModel ?? savedConfig.isReasoningModel,
  };
}

/**
 * Estimate token count from text (rough heuristic: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Returns true if the given base URL is an Azure OpenAI endpoint.
 * Uses proper hostname matching to avoid spoofed URLs like
 * "https://myresource.openai.azure.com.evil.com/v1".
 */
export function isAzureProvider(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com');
  } catch {
    // If URL is malformed, fall back to substring check
    return baseUrl.includes('.openai.azure.com') || baseUrl.includes('.services.ai.azure.com');
  }
}

/**
 * Returns true if the model name matches a known reasoning model pattern,
 * or if the explicit override is true.
 * Pass override=false to force non-reasoning even for o-series names.
 */
export function isReasoningModel(model: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  // Match known bare reasoning models (o1, o3) and any o-series with -mini/-preview suffix
  return /^o[1-9]\d*(-mini|-preview)$|^o1$|^o3$/i.test(model);
}

/**
 * Build the full chat completions URL, appending ?api-version when provided.
 */
export function buildRequestUrl(baseUrl: string, apiVersion: string | undefined): string {
  const base = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return apiVersion ? `${base}?api-version=${encodeURIComponent(apiVersion)}` : base;
}

export interface CallLLMOptions {
  onChunk?: (charsReceived: number) => void;
}

const parsePositiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const LLM_REQUEST_TIMEOUT_MS = parsePositiveIntEnv('ONTOINDEX_LLM_TIMEOUT_MS', 10 * 60_000);
const MAX_LLM_STREAM_BYTES = parsePositiveIntEnv(
  'ONTOINDEX_LLM_MAX_STREAM_BYTES',
  20 * 1024 * 1024,
);
const MAX_LLM_STREAM_CHARS = parsePositiveIntEnv(
  'ONTOINDEX_LLM_MAX_STREAM_CHARS',
  10 * 1024 * 1024,
);
const MAX_LLM_SSE_BUFFER_CHARS = parsePositiveIntEnv(
  'ONTOINDEX_LLM_MAX_SSE_BUFFER_CHARS',
  1024 * 1024,
);
const MAX_LLM_ERROR_BODY_BYTES = parsePositiveIntEnv(
  'ONTOINDEX_LLM_MAX_ERROR_BODY_BYTES',
  512 * 1024,
);

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface ErrorFields {
  code?: unknown;
  message?: unknown;
}

function getErrorFields(err: unknown): ErrorFields | undefined {
  if ((typeof err !== 'object' && typeof err !== 'function') || err === null) {
    return undefined;
  }
  return err as ErrorFields;
}

function isRetryableNetworkError(err: unknown): boolean {
  const fields = getErrorFields(err);
  if (!fields) return false;

  const { code, message } = fields;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    (typeof message === 'string' && message.includes('fetch'))
  );
}

function asChatCompletionResponse(value: unknown): ChatCompletionResponse {
  return value as ChatCompletionResponse;
}

/**
 * Call an OpenAI-compatible LLM API.
 * Uses streaming when onChunk callback is provided for real-time progress.
 * Retries up to 3 times on transient failures (429, 5xx, network errors).
 */
export async function callLLM(
  prompt: string,
  config: LLMConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  // Detect Azure endpoint (by provider field or URL pattern)
  const azure = config.provider === 'azure' || isAzureProvider(config.baseUrl);

  // Warn when using Azure legacy deployment URL without api-version
  if (azure && !config.apiVersion && config.baseUrl.includes('/deployments/')) {
    console.warn(
      '[ontoindex] Warning: Azure legacy deployment URL detected but no api-version set. Add --api-version 2024-10-21 or use the v1 API format.',
    );
  }

  // Detect reasoning model (o1, o3, o4-mini etc.) or explicit override
  const reasoning = isReasoningModel(config.model, config.isReasoningModel);

  const url = buildRequestUrl(config.baseUrl, azure ? config.apiVersion : undefined);
  const useStream = !!options?.onChunk;

  // Build request body — reasoning models reject temperature and use max_completion_tokens
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };

  // max_tokens is deprecated; use max_completion_tokens for all models
  body.max_completion_tokens = config.maxTokens;

  // Only send temperature for non-Azure providers — some Azure models reject non-default values
  if (!reasoning && !azure && config.temperature !== undefined) {
    body.temperature = config.temperature;
  }

  if (useStream) body.stream = true;

  // Build auth headers — Azure uses api-key header, everyone else uses Authorization: Bearer
  const authHeaders: Record<string, string> = azure
    ? { 'api-key': config.apiKey }
    : { Authorization: `Bearer ${config.apiKey}` };

  const MAX_RETRIES = 3;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LLM_REQUEST_TIMEOUT_MS);
    if (typeof timeout === 'object' && 'unref' in timeout) {
      timeout.unref();
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await readResponseTextWithLimit(response, MAX_LLM_ERROR_BODY_BYTES).catch(
          () => 'unknown error',
        );

        // Azure content filter — surface a clear message instead of a generic API error
        if (
          azure &&
          response.status === 400 &&
          (errorText.includes('content_filter') ||
            errorText.includes('ResponsibleAIPolicyViolation'))
        ) {
          throw new Error(
            `Azure content filter blocked this request. The prompt triggered content policy. Details: ${errorText.slice(0, 300)}`,
          );
        }

        // Rate limit — wait with exponential backoff and retry
        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 3000;
          await sleep(delay);
          continue;
        }

        // Server error — retry with backoff
        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
          await sleep((attempt + 1) * 2000);
          continue;
        }

        throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 500)}`);
      }

      // Streaming path
      if (useStream && response.body) {
        return await readSSEStream(response.body, options!.onChunk!);
      }

      // Non-streaming path
      const json = asChatCompletionResponse(await response.json());
      const choice = json.choices?.[0];
      if (!choice?.message?.content) {
        throw new Error('LLM returned empty response');
      }

      return {
        content: choice.message.content,
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      };
    } catch (err: unknown) {
      if (timedOut) {
        throw new Error(`LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`);
      }
      lastError = err;

      // Network error — retry with backoff
      if (attempt < MAX_RETRIES - 1 && isRetryableNetworkError(err)) {
        await sleep((attempt + 1) * 3000);
        continue;
      }

      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('LLM call failed after retries');
}

/**
 * Read an SSE stream from an OpenAI-compatible streaming response.
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (charsReceived: number) => void,
): Promise<LLMResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let content = '';
  let buffer = '';
  let bytesRead = 0;
  let contentFilterTriggered = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      if (bytesRead > MAX_LLM_STREAM_BYTES) {
        throw new Error(`LLM stream exceeded ${MAX_LLM_STREAM_BYTES} bytes`);
      }

      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_LLM_SSE_BUFFER_CHARS) {
        throw new Error(`LLM SSE buffer exceeded ${MAX_LLM_SSE_BUFFER_CHARS} characters`);
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        ({ content, contentFilterTriggered } = processSSELine(
          line,
          content,
          contentFilterTriggered,
          onChunk,
        ));
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      ({ content, contentFilterTriggered } = processSSELine(
        buffer,
        content,
        contentFilterTriggered,
        onChunk,
      ));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }

  if (contentFilterTriggered) {
    throw new Error(
      'content filter triggered mid-stream. The generated content was blocked by content policy. Adjust your prompt and retry.',
    );
  }

  if (!content) {
    throw new Error('LLM returned empty streaming response');
  }

  return { content };
}

function processSSELine(
  line: string,
  content: string,
  contentFilterTriggered: boolean,
  onChunk: (charsReceived: number) => void,
): { content: string; contentFilterTriggered: boolean } {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) {
    return { content, contentFilterTriggered };
  }
  const data = trimmed.slice(6);
  if (data === '[DONE]') {
    return { content, contentFilterTriggered };
  }

  try {
    const parsed = JSON.parse(data);
    const choice = parsed.choices?.[0];

    // Detect content filter finish reason — skip delta from this chunk
    if (choice?.finish_reason === 'content_filter') {
      return { content, contentFilterTriggered: true };
    }

    const delta = choice?.delta?.content;
    if (delta) {
      const nextContent = content + delta;
      if (nextContent.length > MAX_LLM_STREAM_CHARS) {
        throw new Error(`LLM streamed content exceeded ${MAX_LLM_STREAM_CHARS} characters`);
      }
      onChunk(nextContent.length);
      return { content: nextContent, contentFilterTriggered };
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('LLM streamed content exceeded')) {
      throw err;
    }
    // Skip malformed SSE chunks
  }

  return { content, contentFilterTriggered };
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatUint8Arrays(chunks));
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
