import { describe, expect, it } from 'vitest';

import {
  SYSTEMS_ADDITIONAL_ANALYZERS,
  evaluateAnalyzerGates,
  getSystemsAdditionalAnalyzer,
} from '../../src/core/systems-audit/additional-analyzers.js';

describe('systems additional analyzer contracts', () => {
  it('registers S6 analyzers as contract-only sidecar analyzers', () => {
    expect(SYSTEMS_ADDITIONAL_ANALYZERS.map((analyzer) => analyzer.analyzerId)).toEqual([
      'gn_extract_fsm',
      'gn_error_topology',
      'gn_concurrency_audit',
      'gn_pressure_impact',
      'gn_taint_trace',
      'gn_abi_diff',
      'gn_simulate_fault',
    ]);
    expect(SYSTEMS_ADDITIONAL_ANALYZERS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          analyzerId: 'gn_extract_fsm',
          promotedToPrimaryGraph: false,
          implementationStatus: 'contract-only',
          sidecarRecordKind: 'systems.fsm',
        }),
      ]),
    );
  });

  it('requires gate metadata and does not mark analyzers ready without all gates', () => {
    const evaluation = evaluateAnalyzerGates({
      analyzerId: 'gn_error_topology',
      completedGates: ['sidecar-record-kind', 'fixture-set'],
    });

    expect(evaluation.ready).toBe(false);
    expect(evaluation.missingGates).toEqual([
      'mcp-envelope-test',
      'false-positive-review',
      'response-limit-test',
    ]);
  });

  it('requires provenance-backed verifier adapter gate only for analyzers that claim one', () => {
    const taintTrace = getSystemsAdditionalAnalyzer('gn_taint_trace');
    const abiDiff = getSystemsAdditionalAnalyzer('gn_abi_diff');

    expect(taintTrace.requiredGates).toContain('provenance-backed-verifier-adapter');
    expect(abiDiff.requiredGates).not.toContain('provenance-backed-verifier-adapter');
    expect(taintTrace.promotedToPrimaryGraph).toBe(false);
  });
});
