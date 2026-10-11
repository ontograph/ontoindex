import { resolveSymbolCandidates } from './backend-symbol-resolution.js';
import { extractFunction } from './backend-extract-function.js';
import { guardMutationRange, moveSymbol } from './backend-move-symbol.js';
import { resolveContainedRealPath } from './path-util.js';

interface MutationRepoHandle {
  id: string;
  repoPath: string;
  storagePath?: string;
}

interface ResolvedSymbolInfo {
  id: string;
  name: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content?: string;
}

type SymbolInfoResult = ResolvedSymbolInfo | { error: 'not found' };

type UpdateSymbolBodyResult =
  | { success: true; dry_run: true; uid: string; warnings?: string[] }
  | { success: true; uid: string; filePath: string; startLine: number; endLine: number };

type ExtractFunctionResult = Awaited<ReturnType<typeof extractFunction>>;
type MoveSymbolResult = Awaited<ReturnType<typeof moveSymbol>>;

/**
 * Sandbox tool — stage/apply mutations inside a write transaction.
 *
 * Staging is idempotent and gate-free. Applying staged edits is unavailable
 * until this server has a real write path.
 */
export async function sandbox(
  _repo: MutationRepoHandle,
  params: { action?: string; confirm?: boolean; payload?: unknown },
): Promise<{ success: true; action: string; payload?: unknown }> {
  const action = params?.action ?? 'stage';
  if (action === 'apply' && params?.confirm !== true) {
    throw new Error(
      'Explicit confirmation required: call sandbox with { action: "apply", confirm: true } to proceed.',
    );
  }
  if (action === 'apply') {
    throw new Error(
      'Sandbox apply is unavailable: staged edits are not applied by this server. Edit files directly, then verify.',
    );
  }
  return { success: true, action, payload: params?.payload };
}

/**
 * Replace-symbol tool — structured rewrite of a symbol's body.
 *
 * Two-layer gate:
 *   1. `dry_run: true` (default-off in the test) short-circuits to a
 *      no-op success — callers planning a change can preview without
 *      confirmation.
 *   2. Otherwise the write path requires BOTH `confirm: true` on the
 *      call AND `confirmWrites: true` on the backend. A missing call
 *      confirm throws "Explicit confirmation required"; a backend
 *      with writes disabled throws "Write operations are disabled"
 *      even when the caller confirmed.
 *
 * The actual rewrite is deferred — this is the gate today, same
 * pattern as sandbox(). Future wiring inherits the safety contract.
 */
export async function replaceSymbol(
  repo: MutationRepoHandle,
  params: { uid?: string; new_body?: string; dry_run?: boolean; confirm?: boolean },
  confirmWrites: boolean,
): Promise<{ success: true; dry_run: boolean; uid?: string; warnings?: string[] }> {
  const dryRun = params?.dry_run === true;
  if (!dryRun) {
    if (params?.confirm !== true) {
      throw new Error(
        'Explicit confirmation required: call replace_symbol with { dry_run: false, confirm: true } to proceed.',
      );
    }
    if (!confirmWrites) {
      throw new Error(
        'Write operations are disabled on this backend — restart with --confirm-writes to enable.',
      );
    }
  }
  let warnings: string[] | undefined;
  if (params?.uid && repo.repoPath && repo.storagePath) {
    const outcome = await resolveSymbolCandidates(repo, { uid: params.uid }, {});
    if (outcome.kind === 'ok') {
      warnings = await guardMutationRange(repo, outcome.symbol, dryRun);
    }
  }
  return { success: true, dry_run: dryRun, uid: params?.uid, ...(warnings ? { warnings } : {}) };
}

export async function getSymbolInfo(
  repo: MutationRepoHandle,
  params: { uid: string },
  ensureInitialized: (repoId: string) => Promise<void>,
): Promise<SymbolInfoResult> {
  await ensureInitialized(repo.id);
  const outcome = await resolveSymbolCandidates(
    repo,
    { uid: params.uid, include_content: true },
    {},
  );
  if (outcome.kind === 'ok') {
    return outcome.symbol;
  }
  return { error: 'not found' };
}

export async function updateSymbolBody(
  repo: MutationRepoHandle,
  params: { uid: string; new_body: string; dry_run?: boolean; confirm?: boolean },
  confirmWrites: boolean,
  ensureInitialized: (repoId: string) => Promise<void>,
): Promise<UpdateSymbolBodyResult> {
  await ensureInitialized(repo.id);

  if (params.dry_run !== false) {
    let warnings: string[] | undefined;
    if (repo.repoPath && repo.storagePath) {
      const outcome = await resolveSymbolCandidates(repo, { uid: params.uid }, {});
      if (outcome.kind === 'ok') {
        warnings = await guardMutationRange(repo, outcome.symbol, true);
      }
    }
    return { success: true, dry_run: true, uid: params.uid, ...(warnings ? { warnings } : {}) };
  }

  if (!confirmWrites) {
    throw new Error('Write operations are disabled (start server with --confirm-writes)');
  }

  if (params.confirm !== true) {
    throw new Error('Explicit confirmation required (set confirm: true)');
  }

  const outcome = await resolveSymbolCandidates(
    repo,
    { uid: params.uid, include_content: true },
    {},
  );
  if (outcome.kind !== 'ok') {
    throw new Error(`Symbol not found: ${params.uid}`);
  }

  const { filePath, startLine, endLine } = outcome.symbol;
  await guardMutationRange(repo, outcome.symbol, false);
  const fs = await import('fs/promises');
  const sourcePath = await resolveContainedRealPath(repo.repoPath, filePath);
  const source = await fs.readFile(sourcePath, 'utf-8');
  const lines = source.split('\n');
  // startLine and endLine are 1-indexed inclusive
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const newSource = [...before, params.new_body, ...after].join('\n');
  await fs.writeFile(sourcePath, newSource, 'utf-8');

  return {
    success: true,
    uid: params.uid,
    filePath: filePath.replaceAll('\\', '/'),
    startLine,
    endLine,
  };
}

export async function extractFunctionByUid(
  repo: MutationRepoHandle,
  params: {
    uid: string;
    new_name: string;
    target_file?: string;
    dry_run?: boolean;
    confirm?: boolean;
  },
  confirmWrites: boolean,
  ensureInitialized: (repoId: string) => Promise<void>,
): Promise<ExtractFunctionResult> {
  await ensureInitialized(repo.id);

  if (params.dry_run !== false) {
    return extractFunction(repo, { ...params, dry_run: true });
  }

  if (!confirmWrites) {
    throw new Error('Write operations are disabled (start server with --confirm-writes)');
  }

  return extractFunction(repo, params);
}

export async function moveSymbolByUid(
  repo: MutationRepoHandle,
  params: {
    uid: string;
    target_file: string;
    dry_run?: boolean;
    confirm?: boolean;
  },
  confirmWrites: boolean,
  ensureInitialized: (repoId: string) => Promise<void>,
): Promise<MoveSymbolResult> {
  await ensureInitialized(repo.id);

  if (params.dry_run !== false) {
    return moveSymbol(repo, { ...params, dry_run: true });
  }

  if (!confirmWrites) {
    throw new Error('Write operations are disabled (start server with --confirm-writes)');
  }

  return moveSymbol(repo, params);
}
