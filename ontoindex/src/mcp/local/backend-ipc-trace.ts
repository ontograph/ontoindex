/**
 * IPC Trace MCP Tool
 *
 * Thin adapter over src/audit/ipc-trace.ts:traceIPCBridges. Traces
 * execution flows across the JS-to-C++ (Native) bridge for a given
 * symbol: finds JS definitions, identifies bridge files that load
 * .node modules, and locates N-API registrations + C++ implementations.
 */
import { traceIPCBridges } from '../../audit/ipc-trace.js';
// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath: string };
import type { AuditFlowStep } from 'ontoindex-shared';

interface IpcTraceResult {
  status: 'success' | 'error';
  tool: 'ipc_trace';
  repo: string;
  symbol_name: string;
  summary: string;
  flow: AuditFlowStep[];
  flow_count: number;
  error?: string;
}

const caughtErrorDetail = (err: unknown): string => {
  const message =
    err === null || err === undefined
      ? undefined
      : (Object(err) as { readonly message?: unknown }).message;
  return `${message ?? String(err)}`;
};

export async function runIpcTrace(
  repo: RepoHandle,
  params: { symbol_name?: string },
): Promise<IpcTraceResult> {
  const symbolName = typeof params?.symbol_name === 'string' ? params.symbol_name.trim() : '';
  if (symbolName.length === 0) {
    return {
      status: 'error',
      tool: 'ipc_trace',
      repo: repo.name,
      symbol_name: '',
      summary: '',
      flow: [],
      flow_count: 0,
      error: '`symbol_name` is required and must be a non-empty string.',
    };
  }

  try {
    const response = await traceIPCBridges({
      repoId: repo.id,
      repoPath: repo.repoPath,
      symbolName,
    });
    const flow = response.flow ?? [];
    return {
      status: 'success',
      tool: 'ipc_trace',
      repo: repo.name,
      symbol_name: symbolName,
      summary: response.summary,
      flow,
      flow_count: flow.length,
    };
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'ipc_trace',
      repo: repo.name,
      symbol_name: symbolName,
      summary: '',
      flow: [],
      flow_count: 0,
      error: `IPC trace failed: ${caughtErrorDetail(err)}`,
    };
  }
}
