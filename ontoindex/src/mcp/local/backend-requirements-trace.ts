/**
 * Requirements Trace MCP Tool
 *
 * Thin adapter over src/audit/requirements-trace.ts:auditRequirementsTrace.
 * Maps requirement IDs (e.g. "REQ-001") to their implementation and test
 * evidence in the codebase. If `ids` is omitted, discovers IDs matching
 * `id_pattern` (default "[A-Z]{2,}-\\d+"). Each item is classified as
 * implemented / partial / missing based on whether it appears in a
 * structural code node and whether test evidence exists.
 */
import { auditRequirementsTrace } from '../../audit/requirements-trace.js';
// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath: string };
import type { AuditRequirementItem } from 'ontoindex-shared';

interface RequirementsTraceResult {
  status: 'success' | 'error';
  tool: 'requirements_trace';
  repo: string;
  id_pattern: string;
  ids_requested: string[] | null;
  summary: string;
  items: AuditRequirementItem[];
  item_count: number;
  error?: string;
}

const DEFAULT_PATTERN = '[A-Z]{2,}-\\d+';

function caughtErrorMessage(err: unknown): unknown {
  return (err as { readonly message?: unknown } | null | undefined)?.message ?? String(err);
}

export async function runRequirementsTrace(
  repo: RepoHandle,
  params: { ids?: string[]; id_pattern?: string },
): Promise<RequirementsTraceResult> {
  const idsRequested = Array.isArray(params?.ids)
    ? params!.ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : null;
  const idPattern =
    typeof params?.id_pattern === 'string' && params.id_pattern.trim().length > 0
      ? params.id_pattern
      : DEFAULT_PATTERN;

  try {
    const response = await auditRequirementsTrace({
      repoId: repo.id,
      repoPath: repo.repoPath,
      ids: idsRequested && idsRequested.length > 0 ? idsRequested : undefined,
      idPattern,
    });
    const items = response.items ?? [];
    return {
      status: 'success',
      tool: 'requirements_trace',
      repo: repo.name,
      id_pattern: idPattern,
      ids_requested: idsRequested && idsRequested.length > 0 ? idsRequested : null,
      summary: response.summary,
      items,
      item_count: items.length,
    };
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'requirements_trace',
      repo: repo.name,
      id_pattern: idPattern,
      ids_requested: idsRequested && idsRequested.length > 0 ? idsRequested : null,
      summary: '',
      items: [],
      item_count: 0,
      error: `Requirements trace failed: ${caughtErrorMessage(err)}`,
    };
  }
}
