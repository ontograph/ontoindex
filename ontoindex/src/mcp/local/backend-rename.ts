import fs from 'fs/promises';
import { execFile, type ExecFileException } from 'child_process';
import { resolveContainedRealPath } from './path-util.js';

interface RenameRepoHandle {
  repoPath: string;
}

interface RenameSymbolParams {
  symbol_name?: string;
  symbol_uid?: string;
  new_name: string;
  file_path?: string;
  dry_run?: boolean;
  confirm?: boolean;
}

/**
 * Write authorization for applying a rename. Applying requires an explicit
 * per-call confirmation and a caller with writes enabled, matching the
 * replace_symbol gate.
 */
export interface RenameWriteAuthorization {
  confirmWrites: boolean;
}

interface RenameLookupRef {
  filePath?: string;
}

interface RenameLookupSymbol {
  name: string;
  filePath?: string;
  startLine?: number;
}

interface RenameLookupIncoming {
  calls?: RenameLookupRef[];
  imports?: RenameLookupRef[];
  extends?: RenameLookupRef[];
  implements?: RenameLookupRef[];
}

interface RenameLookupResolved {
  symbol: RenameLookupSymbol;
  incoming: RenameLookupIncoming;
}

interface RenameLookupError {
  error: unknown;
}

interface RenameLookupAmbiguous {
  status: 'ambiguous';
  candidates?: unknown;
}

type RenameLookupResult = RenameLookupResolved | RenameLookupError | RenameLookupAmbiguous;

type RenameLookupSymbolFn = (
  name?: string,
  uid?: string,
  filePath?: string,
) => Promise<RenameLookupResult>;

type RenameEditConfidence = 'graph' | 'text_search';

interface RenameEdit {
  line: number;
  old_text: string;
  new_text: string;
  confidence: RenameEditConfidence;
}

interface RenameChange {
  file_path: string;
  edits: RenameEdit[];
}

interface RenameApplyFailure {
  file_path: string;
  error: string;
}

interface RenameSuccessResult {
  status: 'success' | 'partial' | 'failed';
  old_name: string;
  new_name: string;
  files_affected: number;
  total_edits: number;
  graph_edits: number;
  text_search_edits: number;
  changes: RenameChange[];
  applied: boolean;
  applied_files?: string[];
  failed_files?: RenameApplyFailure[];
  warnings?: string[];
}

type RenameSymbolResult = RenameLookupError | RenameLookupAmbiguous | RenameSuccessResult;

function isAmbiguousLookup(result: RenameLookupResult): result is RenameLookupAmbiguous {
  return 'status' in result && result.status === 'ambiguous';
}

function isTruthyErrorLookup(result: RenameLookupResult): result is RenameLookupError {
  return 'error' in result && Boolean(result.error);
}

function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`OntoIndex [${context}]: ${msg}`);
}

const RENAME_RG_TIMEOUT_MS = 5000;
const RENAME_RG_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_TEXT_SEARCH_FILES = 200;
const MAX_TEXT_SEARCH_EDITS = 1000;
const MAX_TEXT_SEARCH_FILE_BYTES = 1024 * 1024;

function execFileCapture(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        encoding: 'utf-8',
        timeout: RENAME_RG_TIMEOUT_MS,
        maxBuffer: RENAME_RG_MAX_BUFFER,
        windowsHide: true,
      },
      (err: ExecFileException | null, stdout) => {
        if (err?.code === 1) {
          resolve(stdout);
          return;
        }
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function renameSymbol(
  repo: RenameRepoHandle,
  params: RenameSymbolParams,
  lookupSymbol: RenameLookupSymbolFn,
  authorization: RenameWriteAuthorization,
): Promise<RenameSymbolResult> {
  const { new_name, file_path } = params;
  const dry_run = params.dry_run ?? true;

  if (!params.symbol_name && !params.symbol_uid) {
    return { error: 'Either symbol_name or symbol_uid is required.' };
  }

  if (!dry_run) {
    if (params.confirm !== true) {
      throw new Error(
        'Explicit confirmation required: call rename with { dry_run: false, confirm: true } to proceed.',
      );
    }
    if (!authorization.confirmWrites) {
      throw new Error(
        'Write operations are disabled on this backend — restart with --confirm-writes to enable.',
      );
    }
  }

  const assertSafePath = (filePath: string): Promise<string> =>
    resolveContainedRealPath(repo.repoPath, filePath);

  const lookupResult = await lookupSymbol(params.symbol_name, params.symbol_uid, file_path);

  if (isAmbiguousLookup(lookupResult)) {
    return lookupResult;
  }
  if (isTruthyErrorLookup(lookupResult)) {
    return lookupResult;
  }

  const sym = (lookupResult as RenameLookupResolved).symbol;
  const oldName = sym.name;

  if (oldName === new_name) {
    return { error: 'New name is the same as the current name.' };
  }

  if (!dry_run) {
    return {
      error:
        'Rename apply is unavailable: graph and text-search candidates do not provide a precise semantic rename edit plan. Use dry_run: true to review candidates.',
    };
  }

  const changes = new Map<string, RenameChange>();

  const addEdit = (
    filePath: string,
    line: number,
    oldText: string,
    newText: string,
    confidence: RenameEditConfidence,
  ) => {
    if (!changes.has(filePath)) {
      changes.set(filePath, { file_path: filePath, edits: [] });
    }
    changes.get(filePath)!.edits.push({ line, old_text: oldText, new_text: newText, confidence });
  };

  if (sym.filePath && sym.startLine) {
    try {
      const content = await fs.readFile(await assertSafePath(sym.filePath), 'utf-8');
      const lines = content.split('\n');
      const lineIdx = sym.startLine - 1;
      if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(oldName)) {
        const defRegex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        addEdit(
          sym.filePath,
          sym.startLine,
          lines[lineIdx].trim(),
          lines[lineIdx].replace(defRegex, new_name).trim(),
          'graph',
        );
      }
    } catch (e) {
      logQueryError('rename:read-definition', e);
    }
  }

  const allIncoming = [
    ...((lookupResult as RenameLookupResolved).incoming.calls || []),
    ...((lookupResult as RenameLookupResolved).incoming.imports || []),
    ...((lookupResult as RenameLookupResolved).incoming.extends || []),
    ...((lookupResult as RenameLookupResolved).incoming.implements || []),
  ];

  let graphEdits = changes.size > 0 ? 1 : 0;

  for (const ref of allIncoming) {
    if (!ref.filePath) continue;
    try {
      const content = await fs.readFile(await assertSafePath(ref.filePath), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(oldName)) {
          addEdit(
            ref.filePath,
            i + 1,
            lines[i].trim(),
            lines[i]
              .replace(
                new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
                new_name,
              )
              .trim(),
            'graph',
          );
          graphEdits++;
          break;
        }
      }
    } catch (e) {
      logQueryError('rename:read-ref', e);
    }
  }

  let astSearchEdits = 0;
  const warnings: string[] = [];
  const graphFiles = new Set([sym.filePath, ...allIncoming.map((r) => r.filePath)].filter(Boolean));

  try {
    const rgArgs = [
      '-l',
      '--type-add',
      'code:*.{ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift}',
      '-t',
      'code',
      `\\b${oldName}\\b`,
      '.',
    ];
    const output = await execFileCapture('rg', rgArgs, repo.repoPath);
    const files = output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
    if (files.length > MAX_TEXT_SEARCH_FILES) {
      warnings.push(`Text-search rename fallback capped at ${MAX_TEXT_SEARCH_FILES} files`);
    }

    for (const file of files.slice(0, MAX_TEXT_SEARCH_FILES)) {
      if (astSearchEdits >= MAX_TEXT_SEARCH_EDITS) {
        warnings.push(`Text-search rename fallback capped at ${MAX_TEXT_SEARCH_EDITS} edits`);
        break;
      }
      const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
      if (graphFiles.has(normalizedFile)) continue;

      try {
        const fullPath = await assertSafePath(normalizedFile);
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_TEXT_SEARCH_FILE_BYTES) continue;
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            regex.lastIndex = 0;
            addEdit(
              normalizedFile,
              i + 1,
              lines[i].trim(),
              lines[i].replace(regex, new_name).trim(),
              'text_search',
            );
            astSearchEdits++;
            if (astSearchEdits >= MAX_TEXT_SEARCH_EDITS) break;
          }
        }
      } catch (e) {
        logQueryError('rename:text-search-read', e);
      }
    }
  } catch (e) {
    logQueryError('rename:ripgrep', e);
  }

  const allChanges = Array.from(changes.values());
  const totalEdits = allChanges.reduce((sum, c) => sum + c.edits.length, 0);

  return {
    status: 'success',
    old_name: oldName,
    new_name,
    files_affected: allChanges.length,
    total_edits: totalEdits,
    graph_edits: graphEdits,
    text_search_edits: astSearchEdits,
    changes: allChanges,
    applied: false,
    ...(warnings.length > 0 && { warnings }),
  };
}
