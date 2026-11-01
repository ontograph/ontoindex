import fs from 'fs/promises';
import path from 'path';
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
const TEXT_SEARCH_EXTENSIONS = 'ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift';

async function findTextSearchFiles(repoPath: string, excluded: Set<string>): Promise<string[]> {
  const extensions = new Set(TEXT_SEARCH_EXTENSIONS.split(',').map((ext) => `.${ext}`));
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(path.join(repoPath, directory), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length > MAX_TEXT_SEARCH_FILES) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink())
        continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(relative);
      } else if (
        entry.isFile() &&
        extensions.has(path.extname(entry.name)) &&
        !excluded.has(relative)
      ) {
        files.push(relative);
      }
    }
  }
  await walk('');
  return files;
}

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
  const allIncoming = [
    ...((lookupResult as RenameLookupResolved).incoming.calls || []),
    ...((lookupResult as RenameLookupResolved).incoming.imports || []),
    ...((lookupResult as RenameLookupResolved).incoming.extends || []),
    ...((lookupResult as RenameLookupResolved).incoming.implements || []),
  ];

  const warnings: string[] = [];
  const normalizeFile = (file: string): string => path.posix.normalize(file.replace(/\\/g, '/'));
  const graphFiles = new Set(
    [sym.filePath, ...allIncoming.map((ref) => ref.filePath)]
      .filter((file): file is string => Boolean(file))
      .map(normalizeFile),
  );
  const scannedFiles = new Set<string>();
  const escapedName = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = new RegExp(`(?<![\\p{ID_Continue}$])${escapedName}(?![\\p{ID_Continue}$])`, 'gu');
  const scanFiles = async (files: string[], confidence: RenameEditConfidence): Promise<number> => {
    const candidates = [...new Set(files.map(normalizeFile))].filter(
      (file) => !scannedFiles.has(file),
    );
    const label =
      confidence === 'graph' ? 'Graph rename candidates' : 'Text-search rename fallback';
    if (candidates.length > MAX_TEXT_SEARCH_FILES) {
      warnings.push(`${label} capped at ${MAX_TEXT_SEARCH_FILES} files`);
    }
    let edits = 0;
    for (const file of candidates.slice(0, MAX_TEXT_SEARCH_FILES)) {
      if (edits >= MAX_TEXT_SEARCH_EDITS) break;
      scannedFiles.add(file);
      try {
        const fullPath = await assertSafePath(file);
        if ((await fs.stat(fullPath)).size > MAX_TEXT_SEARCH_FILE_BYTES) {
          warnings.push(`Skipped oversized rename candidate: ${file}`);
          continue;
        }
        const content = await fs.readFile(fullPath, 'utf-8');
        if (content.includes('\0')) {
          warnings.push(`Skipped binary rename candidate: ${file}`);
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          token.lastIndex = 0;
          if (!token.test(lines[i])) continue;
          token.lastIndex = 0;
          if (!changes.has(file)) changes.set(file, { file_path: file, edits: [] });
          changes.get(file)!.edits.push({
            line: i + 1,
            old_text: lines[i].trim(),
            new_text: lines[i].replace(token, () => new_name).trim(),
            confidence,
          });
          if (++edits >= MAX_TEXT_SEARCH_EDITS) {
            warnings.push(`${label} capped at ${MAX_TEXT_SEARCH_EDITS} edits`);
            break;
          }
        }
      } catch (error) {
        logQueryError('rename:read-candidate', error);
        warnings.push(`Could not read rename candidate: ${file}`);
      }
    }
    return edits;
  };

  const graphEdits = await scanFiles([...graphFiles], 'graph');
  let astSearchEdits = 0;

  try {
    const rgArgs = [
      '-l',
      '-0',
      '-F',
      '--type-add',
      `code:*.{${TEXT_SEARCH_EXTENSIONS}}`,
      '-t',
      'code',
      '--',
      oldName,
      '.',
    ];
    let files: string[];
    try {
      const output = await execFileCapture('rg', rgArgs, repo.repoPath);
      files = output.split('\0').filter((f) => f.length > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files = await findTextSearchFiles(repo.repoPath, graphFiles);
      warnings.push('ripgrep unavailable; used built-in text search');
    }
    astSearchEdits = await scanFiles(
      files.filter((file) => !graphFiles.has(normalizeFile(file))),
      'text_search',
    );
  } catch (e) {
    logQueryError('rename:ripgrep', e);
    warnings.push('Supplemental rename search failed; candidates may be incomplete');
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
