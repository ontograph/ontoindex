import { describe, expect, it } from 'vitest';

import { simulateFault } from '../../src/core/systems-audit/fault-simulation.js';

describe('systems fault simulation', () => {
  it('statically replays a target return value through matching branches', () => {
    const report = simulateFault({
      filePath: 'worker.cc',
      targetCall: 'connect',
      returnValue: -1,
      triggerPath: ['STATE_FAILED'],
      sourceText: `
int run() {
  int rc = connect(sock, addr);
  if (rc < 0) {
    status = STATE_FAILED;
    return -1;
  }
  status = STATE_READY;
  return 0;
}
`,
    });

    expect(report).toMatchObject({
      kind: 'systems-audit-fault-simulation',
      sidecarRecordKind: 'systems.fault_simulation',
      analyzerId: 'gn_simulate_fault',
      analyzerVersion: '0.1.0',
      provenance: {
        source: 'caller-supplied-source',
        staticOnly: true,
        runtimeMutation: false,
      },
      targetResultSymbols: ['rc'],
      confidence: 0.78,
    });
    expect(report.branches).toHaveLength(1);
    expect(report.branches[0]).toMatchObject({
      condition: 'rc < 0',
      likelyTaken: true,
      reasonCodes: ['target-result-bound', 'comparison-evaluated', 'branch-block-sliced'],
    });
    expect(report.likelyTakenPath).toHaveLength(1);
    expect(report.stateAssignments).toEqual([
      expect.objectContaining({
        variable: 'status',
        value: 'STATE_FAILED',
        path: 'likely-taken',
        reasonCodes: ['state-assignment-detected'],
      }),
    ]);
    expect(report.earlyReturns).toEqual([
      expect.objectContaining({
        expression: '-1',
        path: 'likely-taken',
        reasonCodes: ['early-return-detected'],
      }),
    ]);
    expect(report.bypassWarnings).toEqual([]);
    expect(report.falsePositiveNotes.join(' ')).toContain('bounded static source scan');
  });

  it('reports bypass warnings when the target result is not checked before state changes', () => {
    const report = simulateFault({
      targetCall: 'open',
      returnValue: -1,
      triggerPath: ['missing-helper'],
      sourceText: `
int run() {
  int fd = open(path, O_RDONLY);
  state = OPENED;
  return fd;
}
`,
    });

    expect(report.branches).toEqual([]);
    expect(report.confidence).toBe(0.35);
    expect(report.bypassWarnings).toEqual([
      'target result is not compared in the bounded source text',
      'state appears to be updated before the target result is checked',
      'an early return appears before the target result is checked',
      'trigger path was not observed in the supplied source text',
    ]);
    expect(report.reasonCodes).toEqual(
      expect.arrayContaining([
        'target-call-found',
        'target-result-bound',
        'target-result-not-compared',
        'state-updated-before-check',
        'early-return-before-check',
        'trigger-path-not-observed',
      ]),
    );
  });

  it('applies response limits and marks truncated output', () => {
    const report = simulateFault({
      targetCall: 'poll_once',
      returnValue: 0,
      maxBranches: 1,
      maxAssignments: 1,
      maxEarlyReturns: 1,
      sourceText: `
int run() {
  int rc = poll_once();
  if (rc == 0) {
    state = IDLE;
    return 0;
  }
  if (rc != 0) {
    status = BUSY;
    return 1;
  }
}
`,
    });

    expect(report.limits).toMatchObject({
      maxBranches: 1,
      branchesReturned: 1,
      totalBranches: 2,
      maxAssignments: 1,
      assignmentsReturned: 1,
      maxEarlyReturns: 1,
      earlyReturnsReturned: 1,
      truncated: true,
    });
    expect(report.reasonCodes).toContain('response-truncated');
  });
});
