export type SystemsAdditionalAnalyzerId =
  | 'gn_extract_fsm'
  | 'gn_error_topology'
  | 'gn_concurrency_audit'
  | 'gn_pressure_impact'
  | 'gn_taint_trace'
  | 'gn_abi_diff'
  | 'gn_simulate_fault';

export type SystemsAnalyzerGate =
  | 'sidecar-record-kind'
  | 'fixture-set'
  | 'mcp-envelope-test'
  | 'false-positive-review'
  | 'response-limit-test'
  | 'provenance-backed-verifier-adapter';

export interface SystemsAdditionalAnalyzerContract {
  analyzerId: SystemsAdditionalAnalyzerId;
  sidecarRecordKind: string;
  promotedToPrimaryGraph: false;
  implementationStatus: 'contract-only';
  requiredGates: SystemsAnalyzerGate[];
  verifierAdapter: 'requires-provenance' | 'not-applicable';
}

export interface AnalyzerGateEvaluation {
  analyzerId: SystemsAdditionalAnalyzerId;
  ready: boolean;
  missingGates: SystemsAnalyzerGate[];
}

const REQUIRED_GATES: SystemsAnalyzerGate[] = [
  'sidecar-record-kind',
  'fixture-set',
  'mcp-envelope-test',
  'false-positive-review',
  'response-limit-test',
];

export const SYSTEMS_ADDITIONAL_ANALYZERS: readonly SystemsAdditionalAnalyzerContract[] = [
  analyzer('gn_extract_fsm', 'systems.fsm'),
  analyzer('gn_error_topology', 'systems.error_topology'),
  analyzer('gn_concurrency_audit', 'systems.concurrency'),
  analyzer('gn_pressure_impact', 'systems.pressure_impact'),
  analyzer('gn_taint_trace', 'systems.taint_trace', 'requires-provenance'),
  analyzer('gn_abi_diff', 'systems.abi_diff'),
  analyzer('gn_simulate_fault', 'systems.fault_simulation', 'requires-provenance'),
];

export function getSystemsAdditionalAnalyzer(
  analyzerId: SystemsAdditionalAnalyzerId,
): SystemsAdditionalAnalyzerContract {
  const analyzerContract = SYSTEMS_ADDITIONAL_ANALYZERS.find(
    (candidate) => candidate.analyzerId === analyzerId,
  );
  if (!analyzerContract) {
    throw new Error(`Unknown systems analyzer: ${analyzerId}`);
  }
  return analyzerContract;
}

export function evaluateAnalyzerGates(input: {
  analyzerId: SystemsAdditionalAnalyzerId;
  completedGates: readonly SystemsAnalyzerGate[];
}): AnalyzerGateEvaluation {
  const analyzerContract = getSystemsAdditionalAnalyzer(input.analyzerId);
  const completed = new Set(input.completedGates);
  const missingGates = analyzerContract.requiredGates.filter((gate) => !completed.has(gate));
  return {
    analyzerId: input.analyzerId,
    ready: missingGates.length === 0,
    missingGates,
  };
}

function analyzer(
  analyzerId: SystemsAdditionalAnalyzerId,
  sidecarRecordKind: string,
  verifierAdapter: SystemsAdditionalAnalyzerContract['verifierAdapter'] = 'not-applicable',
): SystemsAdditionalAnalyzerContract {
  return {
    analyzerId,
    sidecarRecordKind,
    promotedToPrimaryGraph: false,
    implementationStatus: 'contract-only',
    requiredGates:
      verifierAdapter === 'requires-provenance'
        ? [...REQUIRED_GATES, 'provenance-backed-verifier-adapter']
        : REQUIRED_GATES,
    verifierAdapter,
  };
}
