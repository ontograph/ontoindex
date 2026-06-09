import fs from 'fs/promises';
import path from 'path';
import { resolveSymbolCandidates } from './backend-symbol-resolution.js';

interface ExtractFunctionRepoHandle {
  id: string;
  repoPath: string;
}

interface ExtractFunctionDryRunResult {
  success: true;
  dry_run: true;
  uid: string;
  new_name: string;
  preview: string;
  filePath?: undefined;
}

interface ExtractFunctionApplyResult {
  success: true;
  uid: string;
  new_name: string;
  preview?: undefined;
  filePath: string;
  insertedAt: number;
}

type ExtractFunctionResult = ExtractFunctionDryRunResult | ExtractFunctionApplyResult;

export async function extractFunction(
  repo: ExtractFunctionRepoHandle,
  params: {
    uid: string;
    new_name: string;
    target_file?: string;
    dry_run?: boolean;
    confirm?: boolean;
  },
): Promise<ExtractFunctionResult> {
  const { uid, new_name } = params;
  const dry_run = params.dry_run !== false;

  const outcome = await resolveSymbolCandidates(repo, { uid, include_content: true }, {});
  if (outcome.kind !== 'ok') {
    throw new Error(`Symbol not found: ${uid}`);
  }

  const { name, filePath, startLine, endLine } = outcome.symbol;
  const targetFile = params.target_file ?? filePath;

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      uid,
      new_name,
      preview: `Would extract ${name} as ${new_name} to ${targetFile}`,
    };
  }

  if (!params.confirm) {
    throw new Error('Explicit confirmation required (set confirm: true)');
  }

  const assertSafePath = (p: string): string => {
    const full = path.resolve(repo.repoPath, p);
    if (!full.startsWith(repo.repoPath + path.sep) && full !== repo.repoPath) {
      throw new Error(`Path traversal blocked: ${p}`);
    }
    return full;
  };

  const sourceAbsolute = assertSafePath(filePath);
  const source = await fs.readFile(sourceAbsolute, 'utf-8');
  const lines = source.split('\n');

  // Extract function body lines (1-indexed inclusive)
  const bodyLines = lines.slice(startLine - 1, endLine);
  const bodyText = bodyLines.join('\n');

  // Build the extracted helper: replace the original name with new_name
  const helperText = bodyText.replace(
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    new_name,
  );

  // Build a delegation body: keep the original signature, delegate to new_name
  const sigLine = bodyLines[0].replace(
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    name,
  );
  const closeLine = lines[endLine - 1];
  const delegationBody = [sigLine, `  return ${new_name}(...arguments);`, closeLine].join('\n');

  // Insert helper BEFORE the original function in the source file
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const newSource = [...before, helperText, '', delegationBody, ...after].join('\n');
  await fs.writeFile(sourceAbsolute, newSource, 'utf-8');

  const insertedAt = startLine;
  return {
    success: true,
    uid,
    new_name,
    filePath,
    insertedAt,
  };
}
