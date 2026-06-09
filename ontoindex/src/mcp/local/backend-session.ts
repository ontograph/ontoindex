import { FileSessionStore } from '../../core/memory/session-store.js';

// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly id: string; readonly repoPath: string };

type SessionAction = 'get' | 'set' | 'list';

type SessionParams = {
  action: SessionAction | string;
  session_id: string;
  key?: string;
  value?: string;
};

type SessionResult =
  | { error: string | undefined }
  | { action: 'get'; session_id: string; key: string; value: string | undefined }
  | { action: 'set'; session_id: string; key: string; status: 'success' }
  | { action: 'list'; session_id: string; keys: string[] };

function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    return typeof message === 'string' ? message : undefined;
  }
  return undefined;
}

/**
 * Session MCP Tool
 *
 * Provides persistent key-value storage for agents across sessions.
 */
export async function manageSession(
  repo: RepoHandle,
  params: SessionParams,
): Promise<SessionResult> {
  const { action, session_id, key, value } = params;

  if (!session_id) {
    return { error: 'session_id is required' };
  }

  let store: FileSessionStore;
  try {
    store = new FileSessionStore(repo.repoPath, session_id);
  } catch (err: unknown) {
    return { error: errorMessage(err) };
  }

  try {
    switch (action) {
      case 'get':
        if (!key) return { error: 'key is required for get action' };
        const fetchedValue = await store.get(key);
        return { action, session_id, key, value: fetchedValue };
      case 'set':
        if (!key || value === undefined)
          return { error: 'key and value are required for set action' };
        await store.set(key, value);
        return { action, session_id, key, status: 'success' };
      case 'list':
        const keys = await store.list();
        return { action, session_id, keys };
      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err: unknown) {
    return { error: `Session store error: ${errorMessage(err)}` };
  }
}
