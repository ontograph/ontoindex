import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendFetch } from '../../e2e/backend-auth';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('E2E backend authentication', () => {
  it('uses the configured token only for the backend and refuses redirects', async () => {
    vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'test-only-token');
    vi.stubEnv('BACKEND_URL', 'http://localhost:4747');
    const fetch = vi.fn().mockResolvedValue(new Response('[]'));
    vi.stubGlobal('fetch', fetch);
    await backendFetch('http://localhost:4747/api/repos', {
      headers: { Accept: 'application/json' },
    });
    const init = fetch.mock.calls[0][1];
    expect(init.headers.get('Authorization')).toBe('Bearer test-only-token');
    expect(init.headers.get('Accept')).toBe('application/json');
    expect(init.redirect).toBe('error');
    await expect(backendFetch('http://other.test/api/repos')).rejects.toThrow('unexpected origin');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails forced E2E before sending a request when credentials are absent', async () => {
    vi.stubEnv('E2E', '1');
    vi.stubEnv('ONTOINDEX_HTTP_TOKEN', '');
    vi.stubEnv('BACKEND_URL', 'http://localhost:4747');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(backendFetch('http://localhost:4747/api/repos')).rejects.toThrow(
      'E2E requires ONTOINDEX_HTTP_TOKEN',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unauthorized responses instead of parsing them as empty repositories', async () => {
    vi.stubEnv('E2E', '1');
    vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'wrong-test-token');
    vi.stubEnv('BACKEND_URL', 'http://localhost:4747');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(backendFetch('http://localhost:4747/api/repos')).rejects.toThrow('HTTP 401');
  });
});
