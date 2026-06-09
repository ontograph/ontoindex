import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  isAzureProvider,
  isReasoningModel,
  buildRequestUrl,
} from '../../src/core/wiki/llm-client.js';

describe('isAzureProvider', () => {
  it('returns true for .openai.azure.com URLs', () => {
    expect(isAzureProvider('https://myresource.openai.azure.com/openai/v1')).toBe(true);
  });

  it('returns true for .services.ai.azure.com URLs', () => {
    expect(isAzureProvider('https://myresource.services.ai.azure.com/openai/v1')).toBe(true);
  });

  it('returns false for openai.com', () => {
    expect(isAzureProvider('https://api.openai.com/v1')).toBe(false);
  });

  it('returns false for openrouter', () => {
    expect(isAzureProvider('https://openrouter.ai/api/v1')).toBe(false);
  });

  it('returns false for spoofed URLs containing azure hostname as subdomain', () => {
    expect(isAzureProvider('https://myresource.openai.azure.com.evil.com/v1')).toBe(false);
  });
});

describe('isReasoningModel', () => {
  it('detects o1 model', () => {
    expect(isReasoningModel('o1')).toBe(true);
    expect(isReasoningModel('o1-mini')).toBe(true);
  });

  it('detects o3 model', () => {
    expect(isReasoningModel('o3')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
  });

  it('detects o4-mini', () => {
    expect(isReasoningModel('o4-mini')).toBe(true);
  });

  it('returns false for bare o4 (not a known reasoning model)', () => {
    expect(isReasoningModel('o4')).toBe(false);
  });

  it('returns false for gpt-4o', () => {
    expect(isReasoningModel('gpt-4o')).toBe(false);
  });

  it('returns false for minimax', () => {
    expect(isReasoningModel('minimax/minimax-m2.5')).toBe(false);
  });

  it('respects explicit override', () => {
    expect(isReasoningModel('my-azure-deployment', true)).toBe(true);
    expect(isReasoningModel('o1', false)).toBe(false);
  });
});

describe('buildRequestUrl', () => {
  it('appends /chat/completions to plain base URL', () => {
    expect(buildRequestUrl('https://api.openai.com/v1', undefined)).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('strips trailing slash before appending', () => {
    expect(buildRequestUrl('https://api.openai.com/v1/', undefined)).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('appends api-version query param when provided', () => {
    expect(
      buildRequestUrl('https://myres.openai.azure.com/openai/deployments/dep1', '2024-10-21'),
    ).toBe(
      'https://myres.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21',
    );
  });

  it('does not append api-version when undefined', () => {
    expect(buildRequestUrl('https://myres.openai.azure.com/openai/v1', undefined)).toBe(
      'https://myres.openai.azure.com/openai/v1/chat/completions',
    );
  });
});

describe('callLLM — auth header', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses Authorization: Bearer for non-Azure endpoints', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      maxTokens: 100,
      temperature: 0,
    });

    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(init.headers['Authorization']).toBe('Bearer sk-test');
    expect((init.headers as any)['api-key']).toBeUndefined();
  });

  it('uses api-key header for Azure endpoints', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'azure-key-123',
      baseUrl: 'https://myres.openai.azure.com/openai/deployments/my-dep',
      model: 'my-dep',
      maxTokens: 100,
      temperature: 0,
      provider: 'azure',
      apiVersion: '2024-10-21',
    });

    const [url, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toContain('?api-version=2024-10-21');
    expect((init.headers as any)['api-key']).toBe('azure-key-123');
    expect(init.headers['Authorization']).toBeUndefined();
  });

  it('auto-detects Azure from URL when no provider field set', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'azure-key-auto',
      baseUrl: 'https://myres.openai.azure.com/openai/v1',
      model: 'my-deployment',
      maxTokens: 100,
      temperature: 0,
      // no provider field — should auto-detect from URL
    });

    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect((init.headers as any)['api-key']).toBe('azure-key-auto');
    expect(init.headers['Authorization']).toBeUndefined();
  });
});

describe('callLLM — reasoning model params', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses max_completion_tokens and strips temperature for reasoning models', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'o3-mini',
      maxTokens: 500,
      temperature: 0,
    });

    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    const body = JSON.parse(init.body as string);
    expect(body.max_completion_tokens).toBe(500);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('uses max_completion_tokens and temperature for non-reasoning models', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      maxTokens: 500,
      temperature: 0.5,
    });

    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    const body = JSON.parse(init.body as string);
    expect(body.max_completion_tokens).toBe(500);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.5);
  });
});

describe('callLLM — non-streaming response parsing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('extracts content and usage tokens from a non-streaming response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'answer' } }],
            usage: { prompt_tokens: 12, completion_tokens: 34 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      }),
    ).resolves.toEqual({
      content: 'answer',
      promptTokens: 12,
      completionTokens: 34,
    });
  });

  it('preserves empty-response detection for falsy non-streaming content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      }),
    ).rejects.toThrow('LLM returned empty response');
  });
});

describe('callLLM — Azure content_filter error', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws a clear error when Azure returns content_filter 400', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'content_filter', message: 'Prompt triggered policy' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'azure-key',
        baseUrl: 'https://myres.openai.azure.com/openai/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
        provider: 'azure',
      }),
    ).rejects.toThrow('content filter');
  });

  it('does not throw Azure content filter error for non-Azure providers', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"error": {"code": "content_filter", "message": "Filtered"}}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      }),
    ).rejects.toThrow('LLM API error (400)');
  });
});

describe('readSSEStream — content_filter handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws a clear error when finish_reason is content_filter', async () => {
    const streamContent = [
      'data: {"choices":[{"delta":{"content":"partial "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(streamContent));
        controller.close();
      },
    });

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');

    await expect(
      callLLM(
        'test',
        {
          apiKey: 'azure-key',
          baseUrl: 'https://myres.openai.azure.com/openai/v1',
          model: 'gpt-4o',
          maxTokens: 100,
          temperature: 0,
          provider: 'azure',
        },
        undefined,
        { onChunk: () => {} },
      ),
    ).rejects.toThrow('content filter');
  });

  it('processes a final SSE data line without a trailing newline', async () => {
    const streamContent = 'data: {"choices":[{"delta":{"content":"final chunk"}}]}';

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(streamContent));
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    const result = await callLLM(
      'test',
      {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      },
      undefined,
      { onChunk: () => {} },
    );

    expect(result.content).toBe('final chunk');
  });
});

describe('callLLM — runtime guards', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('aborts a request that exceeds the configured timeout', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ONTOINDEX_LLM_TIMEOUT_MS', '25');
    vi.resetModules();

    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    const promise = callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      maxTokens: 100,
      temperature: 0,
    });
    const assertion = expect(promise).rejects.toThrow('LLM request timed out');

    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it.each([
    ['ECONNREFUSED code', { code: 'ECONNREFUSED' }],
    ['ETIMEDOUT code', { code: 'ETIMEDOUT' }],
    ['fetch message', new Error('fetch failed')],
  ])('retries once after a retryable %s failure', async (_label, retryError) => {
    vi.useFakeTimers();

    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(retryError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    const promise = callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      maxTokens: 100,
      temperature: 0,
    });

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3000);

    await expect(promise).resolves.toEqual({
      content: 'ok',
      promptTokens: undefined,
      completionTokens: undefined,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rethrows nullish fetch failures without replacing the caught value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(null));

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      }),
    ).rejects.toBeNull();
  });

  it('rethrows non-Error failures with falsy messages without retrying', async () => {
    const thrown = { message: '' };
    const fetchSpy = vi.fn().mockRejectedValueOnce(thrown);
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      }),
    ).rejects.toBe(thrown);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels an oversized streaming response', async () => {
    vi.stubEnv('ONTOINDEX_LLM_MAX_STREAM_CHARS', '5');
    vi.resetModules();

    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"too-long"}}]}\n\n'),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM(
        'test',
        {
          apiKey: 'sk-test',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          maxTokens: 100,
          temperature: 0,
        },
        undefined,
        { onChunk: () => {} },
      ),
    ).rejects.toThrow('LLM streamed content exceeded');
    expect(cancelled).toBe(true);
  });

  it('limits API error bodies included in thrown errors', async () => {
    vi.stubEnv('ONTOINDEX_LLM_MAX_ERROR_BODY_BYTES', '8');
    vi.resetModules();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('1234567890', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    );

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      }),
    ).rejects.toThrow('LLM API error (400): 12345678');
  });
});
