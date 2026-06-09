import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelAnalyze,
  clearBackendAuthToken,
  fetchMcpDiagnostics,
  fetchGraph,
  fetchRepos,
  getBackendAuthToken,
  normalizeServerUrl,
  probeBackend,
  setBackendUrl,
  setBackendAuthToken,
  connectToServer,
  streamSSE,
} from '../../src/services/backend-client';

describe('normalizeServerUrl', () => {
  it('adds http:// to localhost', () => {
    expect(normalizeServerUrl('localhost:4747')).toBe('http://localhost:4747');
  });

  it('adds http:// to 127.0.0.1', () => {
    expect(normalizeServerUrl('127.0.0.1:4747')).toBe('http://127.0.0.1:4747');
  });

  it('adds https:// to non-local hosts', () => {
    expect(normalizeServerUrl('example.com')).toBe('https://example.com');
  });

  it('strips trailing slashes', () => {
    expect(normalizeServerUrl('http://localhost:4747/')).toBe('http://localhost:4747');
    expect(normalizeServerUrl('http://localhost:4747///')).toBe('http://localhost:4747');
  });

  it('strips /api suffix (base URL only)', () => {
    expect(normalizeServerUrl('http://localhost:4747/api')).toBe('http://localhost:4747');
  });

  it('trims whitespace', () => {
    expect(normalizeServerUrl('  localhost:4747  ')).toBe('http://localhost:4747');
  });

  it('preserves existing https://', () => {
    expect(normalizeServerUrl('https://ontoindex.example.com')).toBe(
      'https://ontoindex.example.com',
    );
  });
});

afterEach(() => {
  clearBackendAuthToken();
  window.history.pushState(null, '', '/');
  vi.restoreAllMocks();
});

describe('backend auth token handoff', () => {
  it('stores a URL query token in session storage and removes it from the browser URL', () => {
    window.history.pushState(null, '', '/?ontoindexToken=url-token&view=graph');

    expect(getBackendAuthToken()).toBe('url-token');
    expect(window.sessionStorage.getItem('ontoindex.httpToken')).toBe('url-token');
    expect(window.location.search).toBe('?view=graph');
  });

  it('accepts a token on the backend URL input and strips query params from the base URL', () => {
    setBackendUrl('localhost:4747?ontoindexToken=input-token');

    expect(getBackendAuthToken()).toBe('input-token');
    expect(normalizeServerUrl('localhost:4747?ontoindexToken=input-token')).toBe(
      'http://localhost:4747',
    );
  });

  it('adds bearer auth to protected fetch requests', async () => {
    setBackendUrl('http://localhost:4747');
    setBackendAuthToken('local-session-token');

    const repos = [{ name: 'my-repo', path: '/repos/my-repo', indexedAt: '2024-01-01' }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(repos), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchRepos();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer local-session-token');
  });

  it('keeps the public probe unauthenticated', async () => {
    setBackendUrl('http://localhost:4747');
    setBackendAuthToken('local-session-token');

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeBackend()).resolves.toBe(true);

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4747/api/info');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });
});

describe('fetchGraph', () => {
  it('requests streamed graph responses from the backend', async () => {
    setBackendUrl('http://localhost:4747');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"nodes":[],"relationships":[]}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchGraph('big-repo');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/graph?repo=big-repo&stream=true'),
      expect.any(Object),
    );
  });

  it('requests summary mode when summary option is true', async () => {
    setBackendUrl('http://localhost:4747');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"nodes":[],"relationships":[]}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchGraph('big-repo', { summary: true });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('summary=true'),
      expect.any(Object),
    );
  });

  it('parses NDJSON graph streams incrementally', async () => {
    setBackendUrl('http://localhost:4747');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              '{"type":"node","data":{"id":"File:src/app.ts","label":"File","properties":{"name":"app.ts","filePath":"src/app.ts"}}}\n',
              '{"type":"relationship","data":{"id":"File:src/app.ts_CONTAINS_Function:src/app.ts:main","type":"CONTAINS","sourceId":"File:src/app.ts","targetId":"Function:src/app.ts:main"}}\n',
            ].join(''),
          ),
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    const progress = vi.fn();
    const result = await fetchGraph('big-repo', { onProgress: progress });

    expect(result.nodes).toHaveLength(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.nodes[0].id).toBe('File:src/app.ts');
    expect(result.relationships[0].type).toBe('CONTAINS');
    expect(progress).toHaveBeenCalled();
  });

  it('parses NDJSON graph lines split across chunks', async () => {
    setBackendUrl('http://localhost:4747');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '{"type":"node","data":{"id":"File:src/app.ts","label":"File","properties":{"name":"app.ts"',
          ),
        );
        controller.enqueue(
          encoder.encode(
            ',"filePath":"src/app.ts"}}}\n{"type":"relationship","data":{"id":"File:src/app.ts_CONTAINS_Function:src/app.ts:main","type":"CONTAINS","sourceId":"File:src/app.ts","targetId":"Function:src/app.ts:main"}}\n',
          ),
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    const result = await fetchGraph('big-repo');

    expect(result.nodes).toHaveLength(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.nodes[0].properties.filePath).toBe('src/app.ts');
  });

  it('throws backend errors emitted in the NDJSON stream', async () => {
    setBackendUrl('http://localhost:4747');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"error","error":"stream failed"}\n'));
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    await expect(fetchGraph('big-repo')).rejects.toMatchObject({
      message: 'stream failed',
    });
  });

  it('streaming decoder produces the same output as accumulate-then-decode', async () => {
    setBackendUrl('http://localhost:4747');

    const payload = JSON.stringify({
      nodes: [{ id: 'n1', label: 'File', properties: { name: 'a.ts', filePath: 'a.ts' } }],
      relationships: [],
    });
    const encoder = new TextEncoder();
    const bytes = encoder.encode(payload);
    // Split into three uneven chunks to exercise multi-chunk decode
    const chunk1 = bytes.slice(0, 20);
    const chunk2 = bytes.slice(20, 60);
    const chunk3 = bytes.slice(60);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.enqueue(chunk3);
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const progressCalls: number[] = [];
    const result = await fetchGraph('test-repo', {
      onProgress: (downloaded) => progressCalls.push(downloaded),
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('n1');
    expect(result.relationships).toHaveLength(0);
    // Progress should have been called once per chunk
    expect(progressCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('throws BackendError when streaming JSON exceeds 50 MB size cap', async () => {
    setBackendUrl('http://localhost:4747');

    // Produce a stream that exceeds 50 MB
    const FIFTY_MB = 50 * 1024 * 1024;
    const bigChunk = new Uint8Array(FIFTY_MB + 1).fill(65); // 'A' * (50MB+1)

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(fetchGraph('big-repo', { onProgress: () => {} })).rejects.toMatchObject({
      name: 'BackendError',
      message: 'Graph response too large for legacy JSON mode',
    });
  });

  it('aborts body parsing when the response body exceeds the request timeout', async () => {
    vi.useFakeTimers();
    setBackendUrl('http://localhost:4747');

    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchRepos();
    const assertion = expect(promise).rejects.toThrow('aborted');

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('cleans up probe timeouts when the response body is not consumed', async () => {
    vi.useFakeTimers();
    setBackendUrl('http://localhost:4747');

    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeBackend()).resolves.toBe(true);
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;

    await vi.advanceTimersByTimeAsync(2_000);
    expect(signal?.aborted).toBe(false);
    vi.useRealTimers();
  });

  it('cleans up no-content mutation timeouts after ok status checks', async () => {
    vi.useFakeTimers();
    setBackendUrl('http://localhost:4747');

    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await cancelAnalyze('job-1');
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(false);
    vi.useRealTimers();
  });

  it('cancels oversized NDJSON graph streams', async () => {
    setBackendUrl('http://localhost:4747');

    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('x'.repeat(5 * 1024 * 1024 + 1)));
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
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    await expect(fetchGraph('big-repo')).rejects.toMatchObject({
      name: 'BackendError',
      message: 'Graph stream line too large',
    });
    expect(cancelled).toBe(true);
  });
});

describe('streamSSE', () => {
  it('adds bearer auth to protected SSE fetches', async () => {
    setBackendAuthToken('stream-token');

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 401,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    streamSSE('http://localhost:4747/api/analyze/job-1/progress', {});

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer stream-token');
  });

  it('preserves terminal event type when an SSE event is split across chunks', async () => {
    const encoder = new TextEncoder();
    const onComplete = vi.fn();
    const onMessage = vi.fn();
    let cancelled = false;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: complete\n'));
            controller.enqueue(encoder.encode('data: {"repoName":"repo-1"}\n\n'));
          },
          cancel() {
            cancelled = true;
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      }),
    );

    streamSSE('http://localhost:4747/sse', { onComplete, onMessage });

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ repoName: 'repo-1' }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });

  it('reports an error for oversized partial SSE lines', async () => {
    const encoder = new TextEncoder();
    const onError = vi.fn();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${'x'.repeat(1024 * 1024 + 1)}`));
            controller.close();
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      }),
    );

    streamSSE('http://localhost:4747/sse', { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('SSE')));
  });
});

describe('connectToServer', () => {
  it('requests summary mode when repo has >5000 nodes', async () => {
    setBackendUrl('http://localhost:4747');

    const repoInfoMock = {
      name: 'large-repo',
      path: '/repos/large-repo',
      indexedAt: '2024-01-01',
      stats: { nodes: 6000 },
    };

    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo') && url.includes('repo=large-repo'))
        return Promise.resolve(new Response(JSON.stringify(repoInfoMock)));
      if (url.includes('/api/graph'))
        return Promise.resolve(new Response(JSON.stringify({ nodes: [], relationships: [] })));
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await connectToServer(
      'http://localhost:4747',
      undefined,
      undefined,
      'large-repo',
    );

    expect(result.isSummary).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('summary=true'),
      expect.any(Object),
    );
  });

  it('requests full mode when repo has <=5000 nodes', async () => {
    setBackendUrl('http://localhost:4747');

    const repoInfoMock = {
      name: 'small-repo',
      path: '/repos/small-repo',
      indexedAt: '2024-01-01',
      stats: { nodes: 100 },
    };

    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/repo') && url.includes('repo=small-repo'))
        return Promise.resolve(new Response(JSON.stringify(repoInfoMock)));
      if (url.includes('/api/graph'))
        return Promise.resolve(new Response(JSON.stringify({ nodes: [], relationships: [] })));
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await connectToServer(
      'http://localhost:4747',
      undefined,
      undefined,
      'small-repo',
    );

    expect(result.isSummary).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('summary=true'),
      expect.any(Object),
    );
  });
});

describe('response shape validation', () => {
  it('parses MCP diagnostics responses and strips unsafe fields', async () => {
    setBackendUrl('http://localhost:4747');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            activeSessions: [
              {
                sessionIdHash: '0123456789abcdef',
                ageMs: 65_000,
                lastActivityAt: 1_700_000_045_000,
                requestCount: 12,
                errorCount: 2,
                sessionId: 'session-secret-123',
                prompt: 'should never render',
                payload: { unsafe: true },
                recentTools: ['search'],
              },
            ],
            activeSessionCount: 1,
            totalSessionsCreated: 3,
            totalIdleEvictions: 1,
            totalCapEvictions: 2,
            capturedAt: 1_700_000_050_000,
            freshness: 'fresh',
            degraded: false,
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await fetchMcpDiagnostics();

    expect(result).toEqual({
      activeSessions: [
        {
          sessionIdHash: '0123456789abcdef',
          ageMs: 65_000,
          lastActivityAt: 1_700_000_045_000,
          requestCount: 12,
          errorCount: 2,
        },
      ],
      activeSessionCount: 1,
      totalSessionsCreated: 3,
      totalIdleEvictions: 1,
      totalCapEvictions: 2,
      capturedAt: 1_700_000_050_000,
      freshness: 'fresh',
      degraded: false,
    });

    expect(result.activeSessions[0]).not.toHaveProperty('sessionId');
    expect(result.activeSessions[0]).not.toHaveProperty('prompt');
    expect(result.activeSessions[0]).not.toHaveProperty('payload');
    expect(result.activeSessions[0]).not.toHaveProperty('recentTools');
  });

  it('fetchMcpDiagnostics parses evidenceReadLedger field when present', async () => {
    setBackendUrl('http://localhost:4747');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            activeSessions: [],
            activeSessionCount: 0,
            totalSessionsCreated: 0,
            totalIdleEvictions: 0,
            totalCapEvictions: 0,
            capturedAt: 1_700_000_050_000,
            evidenceReadLedger: {
              total: 10,
              byClass: { graph_evidence: 5, docs_evidence: 5 },
              bySurface: { mcp: 10 },
              byRepo: { test: 10 },
              droppedOverCap: 0,
              recorderErrors: 0,
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await fetchMcpDiagnostics();
    expect(result.evidenceReadLedger).toEqual({
      total: 10,
      byClass: { graph_evidence: 5, docs_evidence: 5 },
      bySurface: { mcp: 10 },
      byRepo: { test: 10 },
      droppedOverCap: 0,
      recorderErrors: 0,
    });
  });

  it('preserves BackendError behavior for MCP diagnostics auth failures', async () => {
    setBackendUrl('http://localhost:4747');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          statusText: 'Unauthorized',
        }),
      ),
    );

    await expect(fetchMcpDiagnostics()).rejects.toMatchObject({
      name: 'BackendError',
      message: 'Unauthorized',
      status: 401,
      code: 'client',
    });
  });

  it('throws BackendError when fetchRepos returns unexpected shape', async () => {
    setBackendUrl('http://localhost:4747');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(fetchRepos()).rejects.toMatchObject({
      name: 'BackendError',
      message: 'Unexpected server response shape',
    });
  });

  it('returns repos when fetchRepos receives a valid array', async () => {
    setBackendUrl('http://localhost:4747');
    const repos = [{ name: 'my-repo', path: '/repos/my-repo', indexedAt: '2024-01-01' }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(repos), { status: 200 })),
    );
    const result = await fetchRepos();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-repo');
  });
});
