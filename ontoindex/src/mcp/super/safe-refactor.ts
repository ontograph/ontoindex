/**
 * gn_safe_refactor — single WRITE dispatcher for atomic refactor tools (Phase 3 W3a).
 *
 * Wraps 4 atomic operations (rename, modify-body, extract, move) with:
 *   1. Symbol resolution (fuzzy → canonical via graph, same pattern as safe-edit-check.ts)
 *   2. Pre-check via gnSafeEditCheck (unless preChecks === false)
 *   3. Dry-run preview (default dryRun: true — WRITE super-functions MUST NOT auto-apply)
 *   4. Apply path (only when dryRun: false)
 *   5. Post-write detect_changes to catch unexpected scope (rule §8 #11)
 *
 * Pure facade — no caching, no DB writes beyond the delegated atomic tool.
 *
 * NOTE: WRITE super-functions default to dryRun: true per plan §8 rule #10.
 *       Callers MUST explicitly pass dryRun: false to apply changes.
 */

import fs from 'fs/promises';

import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { resolveSymbolCandidates } from '../local/backend-symbol-resolution.js';
import { renameSymbol } from '../local/backend-rename.js';
import { extractFunction } from '../local/backend-extract-function.js';
import { moveSymbol } from '../local/backend-move-symbol.js';
import { detectChanges } from '../local/backend-detect-changes.js';
import { gnSafeEditCheck, type EditCheckReport } from './safe-edit-check.js';

// ---------------------------------------------------------------------------
// Public API (per plan §3)
// ---------------------------------------------------------------------------

export interface ResolvedSymbol {
  nodeId: string;
  name: string;
  filePath: string;
  kind: string;
}

export interface SafeRefactorParams {
  intent: 'rename' | 'modify-body' | 'extract' | 'move' | 'split-function' | 'convert-to-method';
  symbol?: string; // canonical nodeId or fuzzy name
  target?: string; // deprecated alias for symbol
  params: {
    newName?: string;
    newBody?: string;
    sourceLineRange?: [number, number];
    targetFile?: string;
  };
  dryRun?: boolean; // default: true (MUST default to true — plan §8 rule #10)
  force?: boolean;
  preChecks?: boolean; // default: true
}

export interface RefactorReport {
  version: 1;
  intent: string;
  symbol: ResolvedSymbol;
  preCheckReport?: EditCheckReport;
  preview: {
    affectedFiles: string[];
    diffSummary: string;
    estimatedLinesChanged: number;
  };
  applied: boolean;
  postCheckSummary?: { changedSymbols: string[]; unexpected: string[] };
  rollbackInstructions?: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Canonical nodeId pattern (same as find-related.ts and safe-edit-check.ts)
// ---------------------------------------------------------------------------

const CANONICAL_NODE_ID_RE = /^[A-Z]\w+:/;

type GraphRow = Record<string, unknown> | readonly unknown[];

interface LookupSymbolSymbol {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  kind: string;
}

type LookupSymbolResult =
  | {
      error: string;
    }
  | {
      status: 'ambiguous';
      candidates: Array<{
        id: unknown;
        name: unknown;
        filePath: unknown;
      }>;
    }
  | {
      symbol: LookupSymbolSymbol;
      incoming: { calls: []; imports: []; extends: []; implements: [] };
    };

type LookupSymbol = (name?: string, uid?: string, filePath?: string) => Promise<LookupSymbolResult>;

interface RenameChange {
  file_path?: unknown;
}

interface RenameResult {
  error?: unknown;
  total_edits?: unknown;
  changes?: unknown;
}

interface ChangedSymbol {
  id?: unknown;
  name?: unknown;
}

function rowValue(row: GraphRow, key: string, index: number): unknown {
  const record = row as Record<string, unknown>;
  return record[key] ?? record[String(index)] ?? (Array.isArray(row) ? row[index] : undefined);
}

function rowString(row: GraphRow, key: string, index: number): string {
  return (rowValue(row, key, index) ?? '') as string;
}

function rowNumber(row: GraphRow, key: string, index: number): number {
  return Number(rowValue(row, key, index) ?? 0);
}

function renameAffectedFiles(result: RenameResult): string[] {
  return Array.isArray(result.changes)
    ? result.changes.map((change) => (change as RenameChange).file_path as string)
    : [];
}

// ---------------------------------------------------------------------------
// Symbol resolution (same Cypher pattern as safe-edit-check.ts)
// ---------------------------------------------------------------------------

async function resolveSymbol(repoId: string, symbol: string): Promise<ResolvedSymbol | null> {
  if (CANONICAL_NODE_ID_RE.test(symbol)) {
    try {
      const rows = await executeParameterized(
        repoId,
        `MATCH (s) WHERE s.id = $id
         RETURN s.id AS nodeId, s.name AS name, s.filePath AS filePath, labels(s)[0] AS kind
         LIMIT 1`,
        { id: symbol },
      );
      if (rows.length === 0) return null;
      const row = rows[0] as GraphRow;
      return {
        nodeId: rowString(row, 'nodeId', 0),
        name: rowString(row, 'name', 1),
        filePath: rowString(row, 'filePath', 2),
        kind: rowString(row, 'kind', 3),
      };
    } catch {
      return null;
    }
  }

  try {
    const candidates = await executeParameterized(
      repoId,
      `MATCH (s) WHERE s.name = $name
       OPTIONAL MATCH (caller)-[r:CodeRelation]->(s) WHERE r.type = 'CALLS'
       RETURN s.id AS nodeId, s.name AS name, s.filePath AS filePath, labels(s)[0] AS kind,
              COUNT(caller) AS callerCount
       ORDER BY callerCount DESC
       LIMIT 5`,
      { name: symbol },
    );
    if (candidates.length === 0) return null;
    const row = candidates[0] as GraphRow;
    return {
      nodeId: rowString(row, 'nodeId', 0),
      name: rowString(row, 'name', 1),
      filePath: rowString(row, 'filePath', 2),
      kind: rowString(row, 'kind', 3),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Atomic tool wrappers — dry-run and apply paths
// ---------------------------------------------------------------------------

/**
 * Stub lookupSymbol for renameSymbol — uses executeParameterized to resolve by name/uid.
 * This replicates the pattern from local-backend.ts context() without pulling in the
 * full LocalBackend class (which requires server-side initialization).
 */
async function makeLookupSymbol(repoId: string): Promise<LookupSymbol> {
  return async (name?: string, uid?: string, _filePath?: string) => {
    const identifier = uid ?? name;
    if (!identifier) {
      return { error: 'Either symbol_name or symbol_uid is required.' };
    }

    const isUid = uid !== undefined && CANONICAL_NODE_ID_RE.test(uid);

    try {
      let rows: GraphRow[];
      if (isUid) {
        rows = (await executeParameterized(
          repoId,
          `MATCH (s) WHERE s.id = $id
           OPTIONAL MATCH (caller)-[r:CodeRelation]->(s) WHERE r.type IN ['CALLS', 'REFERENCES', 'IMPORTS']
           OPTIONAL MATCH (s)-[ri:CodeRelation]->(callee) WHERE ri.type IN ['CALLS', 'REFERENCES', 'IMPORTS']
           RETURN s.id AS id, s.name AS name, s.filePath AS filePath,
                  s.startLine AS startLine, labels(s)[0] AS kind,
                  COLLECT(DISTINCT {filePath: caller.filePath, type: ri.type}) AS incoming
           LIMIT 1`,
          { id: uid },
        )) as GraphRow[];
      } else {
        rows = (await executeParameterized(
          repoId,
          `MATCH (s) WHERE s.name = $name
           OPTIONAL MATCH (caller)-[r:CodeRelation]->(s) WHERE r.type IN ['CALLS', 'REFERENCES', 'IMPORTS']
           RETURN s.id AS id, s.name AS name, s.filePath AS filePath,
                  s.startLine AS startLine, labels(s)[0] AS kind,
                  COUNT(caller) AS callerCount
           ORDER BY callerCount DESC
           LIMIT 5`,
          { name: identifier },
        )) as GraphRow[];
      }

      if (rows.length === 0) {
        return { error: `Symbol not found: ${identifier}` };
      }

      if (!isUid && rows.length > 1) {
        return {
          status: 'ambiguous',
          candidates: rows.map((row) => ({
            id: rowValue(row, 'id', 0),
            name: rowValue(row, 'name', 1),
            filePath: rowValue(row, 'filePath', 2),
          })),
        };
      }

      const row = rows[0];
      return {
        symbol: {
          id: rowString(row, 'id', 0),
          name: rowString(row, 'name', 1),
          filePath: rowString(row, 'filePath', 2),
          startLine: rowNumber(row, 'startLine', 3),
          kind: rowString(row, 'kind', 4),
        },
        incoming: { calls: [], imports: [], extends: [], implements: [] },
      };
    } catch (err) {
      return { error: String(err) };
    }
  };
}

/** Dispatch dry-run preview for the given intent. */
async function dispatchDryRun(
  repoId: string,
  resolved: ResolvedSymbol,
  params: SafeRefactorParams,
  warnings: string[],
): Promise<{ affectedFiles: string[]; diffSummary: string; estimatedLinesChanged: number }> {
  const { intent } = params;
  const repoHandle = { id: repoId, repoPath: process.cwd() };

  if (intent === 'rename') {
    const newName = params.params.newName;
    if (!newName) {
      warnings.push('intent:rename requires params.newName');
      return { affectedFiles: [], diffSummary: 'missing newName', estimatedLinesChanged: 0 };
    }
    const lookupSymbol = await makeLookupSymbol(repoId);
    const result = (await renameSymbol(
      repoHandle,
      { symbol_name: resolved.name, new_name: newName, dry_run: true },
      lookupSymbol,
    )) as RenameResult;
    const affectedFiles = renameAffectedFiles(result);
    return {
      affectedFiles,
      diffSummary: `rename ${resolved.name} → ${newName} (${result.total_edits ?? 0} edits across ${affectedFiles.length} files)`,
      estimatedLinesChanged: Number(result.total_edits ?? 0),
    };
  }

  if (intent === 'modify-body') {
    const newBody = params.params.newBody;
    if (!newBody) {
      warnings.push('intent:modify-body requires params.newBody');
      return { affectedFiles: [], diffSummary: 'missing newBody', estimatedLinesChanged: 0 };
    }
    // updateSymbolBody dry-run: resolve symbol to get line range, compute line delta
    const outcome = await resolveSymbolCandidates(
      { id: repoId },
      { uid: resolved.nodeId, include_content: false },
      {},
    );
    if (outcome.kind !== 'ok') {
      warnings.push(
        `modify-body: could not resolve symbol uid ${resolved.nodeId} via resolveSymbolCandidates`,
      );
      return {
        affectedFiles: [resolved.filePath],
        diffSummary: `modify body of ${resolved.name}`,
        estimatedLinesChanged: newBody.split('\n').length,
      };
    }
    const { startLine, endLine, filePath } = outcome.symbol;
    const originalLines = endLine - startLine + 1;
    const newLines = newBody.split('\n').length;
    return {
      affectedFiles: [filePath],
      diffSummary: `modify body of ${resolved.name} at ${filePath}:${startLine}-${endLine}`,
      estimatedLinesChanged: Math.abs(newLines - originalLines) + originalLines,
    };
  }

  if (intent === 'extract') {
    const newName = params.params.newName;
    if (!newName) {
      warnings.push('intent:extract requires params.newName');
      return { affectedFiles: [], diffSummary: 'missing newName', estimatedLinesChanged: 0 };
    }
    const result = await extractFunction(repoHandle, {
      uid: resolved.nodeId,
      new_name: newName,
      target_file: params.params.targetFile,
      dry_run: true,
    });
    return {
      affectedFiles: resolved.filePath ? [resolved.filePath] : [],
      diffSummary: result.preview ?? `extract ${resolved.name} as ${newName}`,
      estimatedLinesChanged: 0,
    };
  }

  if (intent === 'move') {
    const targetFile = params.params.targetFile;
    if (!targetFile) {
      warnings.push('intent:move requires params.targetFile');
      return { affectedFiles: [], diffSummary: 'missing targetFile', estimatedLinesChanged: 0 };
    }
    const result = await moveSymbol(repoHandle, {
      uid: resolved.nodeId,
      target_file: targetFile,
      dry_run: true,
    });
    return {
      affectedFiles: [resolved.filePath, targetFile].filter(Boolean),
      diffSummary: `move ${resolved.name} from ${result.from} to ${result.to}`,
      estimatedLinesChanged: 0,
    };
  }

  // Should not reach here — unsupported intents are caught before calling dispatchDryRun.
  return {
    affectedFiles: [],
    diffSummary: `unsupported intent: ${intent}`,
    estimatedLinesChanged: 0,
  };
}

/** Apply the refactor (dry_run: false). Returns list of affected files. */
async function dispatchApply(
  repoId: string,
  resolved: ResolvedSymbol,
  params: SafeRefactorParams,
  warnings: string[],
): Promise<string[]> {
  const { intent } = params;
  const repoHandle = { id: repoId, repoPath: process.cwd() };

  if (intent === 'rename') {
    const newName = params.params.newName!;
    const lookupSymbol = await makeLookupSymbol(repoId);
    const result = (await renameSymbol(
      repoHandle,
      { symbol_name: resolved.name, new_name: newName, dry_run: false },
      lookupSymbol,
    )) as RenameResult;
    if (result.error) {
      warnings.push(`rename apply error: ${result.error}`);
      return [];
    }
    return renameAffectedFiles(result);
  }

  if (intent === 'modify-body') {
    const newBody = params.params.newBody!;
    const outcome = await resolveSymbolCandidates(
      { id: repoId },
      { uid: resolved.nodeId, include_content: false },
      {},
    );
    if (outcome.kind !== 'ok') {
      warnings.push(`modify-body apply: could not resolve symbol uid ${resolved.nodeId}`);
      return [];
    }
    const { filePath, startLine, endLine } = outcome.symbol;
    const source = await fs.readFile(filePath, 'utf-8');
    const lines = source.split('\n');
    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);
    const newSource = [...before, newBody, ...after].join('\n');
    await fs.writeFile(filePath, newSource, 'utf-8');
    return [filePath];
  }

  if (intent === 'extract') {
    const newName = params.params.newName!;
    const result = await extractFunction(repoHandle, {
      uid: resolved.nodeId,
      new_name: newName,
      target_file: params.params.targetFile,
      dry_run: false,
      confirm: true,
    });
    return result.filePath ? [result.filePath] : [];
  }

  if (intent === 'move') {
    const targetFile = params.params.targetFile!;
    const result = await moveSymbol(repoHandle, {
      uid: resolved.nodeId,
      target_file: targetFile,
      dry_run: false,
      confirm: true,
    });
    return [result.from, result.to].filter(Boolean);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function gnSafeRefactor(
  repoId: string,
  params: SafeRefactorParams,
): Promise<RefactorReport> {
  const warnings: string[] = [];
  // WRITE super-functions MUST default to dryRun: true (plan §8 rule #10)
  const dryRun = params.dryRun !== false;
  const force = params.force ?? false;
  const requestedSymbol = params.symbol ?? params.target ?? '';
  if (!params.symbol && params.target) {
    warnings.push('`target` is a deprecated alias for `symbol`; use `symbol` in new calls.');
  }

  // Empty preview used as zero-value before resolution
  const emptyPreview = { affectedFiles: [], diffSummary: '', estimatedLinesChanged: 0 };

  if (!requestedSymbol) {
    warnings.push('Either `symbol` or deprecated alias `target` is required.');
    return {
      version: 1,
      intent: params.intent,
      symbol: { nodeId: '', name: '', filePath: '', kind: '' },
      preview: emptyPreview,
      applied: false,
      warnings,
    };
  }

  // --- 1. Unsupported intents (short-circuit before IO) ---------------------
  if (params.intent === 'split-function' || params.intent === 'convert-to-method') {
    return {
      version: 1,
      intent: params.intent,
      symbol: { nodeId: '', name: requestedSymbol, filePath: '', kind: '' },
      preview: emptyPreview,
      applied: false,
      warnings: [`intent '${params.intent}' not yet supported in Phase 3 dispatcher`],
    };
  }

  // --- 2. Resolve symbol ----------------------------------------------------
  const resolved = await resolveSymbol(repoId, requestedSymbol);
  if (!resolved || !resolved.nodeId) {
    warnings.push('symbol not found in index');
    return {
      version: 1,
      intent: params.intent,
      symbol: { nodeId: '', name: requestedSymbol, filePath: '', kind: '' },
      preview: emptyPreview,
      applied: false,
      warnings,
    };
  }

  // --- 3. Pre-check ---------------------------------------------------------
  let preCheckReport: EditCheckReport | undefined;
  if (params.preChecks !== false) {
    preCheckReport = await gnSafeEditCheck(repoId, {
      symbol: requestedSymbol,
      intent:
        params.intent === 'modify-body'
          ? 'modify-body'
          : params.intent === 'rename'
            ? 'rename'
            : 'general',
      force,
    });

    if (
      (preCheckReport.verdict === 'BLOCKED' || preCheckReport.verdict === 'DANGEROUS') &&
      !force
    ) {
      return {
        version: 1,
        intent: params.intent,
        symbol: resolved,
        preCheckReport,
        preview: emptyPreview,
        applied: false,
        warnings: [
          `pre-check verdict ${preCheckReport.verdict}: ${preCheckReport.reasoning}`,
          'Pass force:true to override.',
        ],
      };
    }

    if (preCheckReport.verdict === 'BLOCKED' || preCheckReport.verdict === 'DANGEROUS') {
      warnings.push(
        `pre-check verdict ${preCheckReport.verdict} overridden by force:true — proceed with caution`,
      );
    }
  }

  // --- 4. Dry-run preview ---------------------------------------------------
  const preview = await dispatchDryRun(repoId, resolved, params, warnings);

  // --- 5. Return preview-only when dryRun (default) -------------------------
  if (dryRun) {
    return {
      version: 1,
      intent: params.intent,
      symbol: resolved,
      ...(preCheckReport !== undefined ? { preCheckReport } : {}),
      preview,
      applied: false,
      warnings,
    };
  }

  // --- 6. Apply -------------------------------------------------------------
  const appliedFiles = await dispatchApply(repoId, resolved, params, warnings);

  // --- 7. Post-write verify (plan §8 rule #11) ------------------------------
  let postCheckSummary: RefactorReport['postCheckSummary'] | undefined;
  let rollbackInstructions: string | undefined;

  try {
    const detectResult = await detectChanges(
      { id: repoId, repoPath: process.cwd() },
      { scope: 'unstaged' },
    );

    const changedSymbols: string[] = Array.isArray(detectResult.changed_symbols)
      ? detectResult.changed_symbols.map(
          (symbol) =>
            ((symbol as ChangedSymbol).name ?? (symbol as ChangedSymbol).id ?? '') as string,
        )
      : [];

    const unexpected = changedSymbols.filter((s) => s !== resolved.name && s !== '');

    postCheckSummary = { changedSymbols, unexpected };

    if (unexpected.length > 0) {
      warnings.push(`post-write detect_changes found unexpected scope: ${unexpected.join(', ')}`);
      rollbackInstructions = `git restore ${appliedFiles.join(' ')}`;
    }
  } catch (err) {
    warnings.push(`post-write detect_changes failed: ${String(err)}`);
  }

  return {
    version: 1,
    intent: params.intent,
    symbol: resolved,
    ...(preCheckReport !== undefined ? { preCheckReport } : {}),
    preview,
    applied: true,
    ...(postCheckSummary !== undefined ? { postCheckSummary } : {}),
    ...(rollbackInstructions !== undefined ? { rollbackInstructions } : {}),
    warnings,
  };
}
