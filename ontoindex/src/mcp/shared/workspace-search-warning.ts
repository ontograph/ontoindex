import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  dirtyWorkspaceSearchWarning,
  getUntrackedWorkspacePaths,
  resolveTargetContext,
} from './target-context.js';
import { summarizeGitPorcelainStatus } from '../../core/audit-lifecycle/freshness.js';

async function untrackedQueryMatches(
  context: Awaited<ReturnType<typeof resolveTargetContext>>,
  query: string,
) {
  const tokens = [
    ...new Set(query.split(/[\s`'"(),:]+/).filter((token) => /^[A-Za-z_$][\w$]{2,}$/.test(token))),
  ].slice(0, 5);
  if (!context.repoPath || !context.dirtyWorkspace?.untrackedSourceFileCount || !tokens.length)
    return [];
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  let root: string;
  try {
    root = await realpath(context.repoPath);
  } catch {
    return [];
  }
  const matches: { filePath: string; tokens: string[] }[] = [];
  const candidates = getUntrackedWorkspacePaths(context.dirtyWorkspace)
    .filter((filePath) => summarizeGitPorcelainStatus(`?? ${filePath}`).sourceFileCount > 0)
    .slice(0, 50);
  for (const filePath of candidates) {
    const resolved = path.resolve(root, filePath);
    if (!inside(root, resolved)) continue;
    try {
      const canonical = await realpath(resolved);
      if (!inside(root, canonical)) continue;
      const file = await open(canonical, 'r');
      try {
        const stat = await file.stat();
        const maxBytes = 256 * 1024;
        if (!stat.isFile() || stat.size > maxBytes) continue;
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maxBytes) continue;
        const source = buffer.toString('utf8', 0, bytesRead);
        const found = tokens.filter((token) =>
          new RegExp(`(^|[^\\w$])${token.replace(/\$/g, '\\$')}($|[^\\w$])`).test(source),
        );
        if (found.length) matches.push({ filePath, tokens: found });
      } finally {
        await file.close();
      }
    } catch {
      // A warning must not fail the search when files disappear or cannot be read.
    }
  }
  return matches;
}

/** Append the dirty-workspace search warning unless a workspace graph answered. */
export async function attachWorkspaceSearchWarning(
  result: unknown,
  args: Record<string, unknown>,
  repoId: string,
): Promise<unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  let context: Awaited<ReturnType<typeof resolveTargetContext>>;
  try {
    context = await resolveTargetContext({ repo: repoId });
  } catch {
    return result;
  }
  if (
    context.graphAuthority?.capability === 'workspace-graph' &&
    context.graphAuthority.state === 'authoritative'
  )
    return result;
  const query = String(args.query ?? args.symbol ?? args.target ?? '');
  const matches = await untrackedQueryMatches(context, query);
  let warning = dirtyWorkspaceSearchWarning(
    context.dirtyWorkspace,
    query,
    matches.map((match) => match.filePath),
  );
  if (!warning) return result;
  if (matches.length) {
    const symbols = [...new Set(matches.flatMap((match) => match.tokens))];
    warning += `; query symbol(s) ${symbols.join(', ')} appear in untracked file(s): ${matches
      .slice(0, 3)
      .map((match) => match.filePath)
      .join(', ')}`;
  }
  const record = result as Record<string, unknown>;
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  return { ...record, warnings: [...new Set([...warnings, warning])] };
}
