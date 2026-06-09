import {
  traceBoundary,
  type BoundaryMechanism,
  type BoundaryTraceFact,
  type BoundaryTraceReport,
} from '../../core/systems-audit/boundary-trace.js';
import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';
import { resolveTargetContext } from '../shared/target-context.js';

export interface TraceBoundaryParams {
  resource?: string;
  start?: string | number;
  end?: string | number;
  kind?: BoundaryMechanism;
  facts?: BoundaryTraceFact[];
  maxSegments?: number;
  legacyResponse?: boolean;
}

export async function gnTraceBoundary(
  repoId: string,
  params: TraceBoundaryParams,
): Promise<BoundaryTraceReport | Record<string, unknown>> {
  const report = traceBoundary(params);
  if (params.legacyResponse !== false) {
    return report;
  }

  const targetContext = await resolveTargetContext({ repo: repoId });
  return createEnvelopeFromLegacy({
    legacy: report as unknown as Record<string, unknown>,
    tool: 'gn_trace_boundary',
    status: report.status ?? 'ok',
    targetContext,
    capabilitiesUsed: ['boundary-trace'],
    nextTools: ['gn_resource_trace', 'gn_path_verify'],
    evidence: report.segments ?? [],
  });
}
