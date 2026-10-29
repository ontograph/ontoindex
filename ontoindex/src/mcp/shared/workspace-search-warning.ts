import { dirtyWorkspaceSearchWarning, resolveTargetContext } from './target-context.js';

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
  const warning = dirtyWorkspaceSearchWarning(
    context.dirtyWorkspace,
    String(args.query ?? args.symbol ?? args.target ?? ''),
  );
  if (!warning) return result;
  const record = result as Record<string, unknown>;
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  return { ...record, warnings: [...new Set([...warnings, warning])] };
}
