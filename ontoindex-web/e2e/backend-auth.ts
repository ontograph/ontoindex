/** Authenticate only requests to the configured E2E backend. */
export async function backendFetch(url: string, init?: RequestInit): Promise<Response> {
  const backend = process.env.BACKEND_URL ?? 'http://localhost:4747';
  if (new URL(url).origin !== new URL(backend).origin) {
    throw new Error('E2E backend request targets an unexpected origin');
  }
  const token = process.env.ONTOINDEX_HTTP_TOKEN?.trim();
  if (process.env.E2E && !token) throw new Error('E2E requires ONTOINDEX_HTTP_TOKEN');
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers, redirect: 'error' });
  if (!response.ok) throw new Error(`E2E backend returned HTTP ${response.status}`);
  return response;
}
