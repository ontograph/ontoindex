import { describe, expect, it } from 'vitest';

import { runPressureImpact } from '../../src/core/systems-audit/pressure-impact.js';

describe('systems pressure impact', () => {
  it('reports global resource constraints as ALL/global impact warnings', () => {
    const report = runPressureImpact({
      filePath: 'src/pool.ts',
      symbol: 'startJob',
      source: `
let activeCount = 0;
const maxConcurrent = 4;
let workerQuota = 10;
export function startJob() {
  if (activeCount >= maxConcurrent) return false;
  activeCount++;
  workerQuota -= 1;
}
`,
    });

    expect(report.version).toBe(1);
    expect(report.tool).toBe('gn_pressure_impact');
    expect(report.sidecarRecordKind).toBe('systems.pressure_impact');
    expect(report.provenance).toMatchObject({
      analyzerId: 'gn_pressure_impact',
      sidecarRecordKind: 'systems.pressure_impact',
      source: 'bounded-static-heuristic',
    });
    expect(report.impactScope).toBe('ALL/global');
    expect(report.constraints.map((constraint) => constraint.name)).toEqual([
      'activeCount',
      'maxConcurrent',
      'workerQuota',
    ]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'ALL/global',
          reasonCode: 'global-impact-warning',
        }),
      ]),
    );
    expect(report.warnings.every((warning) => warning.falsePositiveNote)).toBe(true);
  });

  it('detects fetch_add and fetch_sub pressure operations', () => {
    const report = runPressureImpact({
      filePath: 'src/quota.cc',
      source: `
std::atomic<int> activeCount;
int maxConcurrent = 8;
void acquire() {
  if (activeCount >= maxConcurrent) return;
  activeCount.fetch_add(1);
}
void release() {
  activeCount.fetch_sub(1);
}
`,
    });

    expect(report.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variableName: 'activeCount', operation: 'increment' }),
        expect.objectContaining({ variableName: 'activeCount', operation: 'decrement' }),
        expect.objectContaining({ variableName: 'activeCount', operation: 'limit-check' }),
      ]),
    );
    expect(report.systemsEvidence.every((item) => item.reasonCode)).toBe(true);
  });

  it('bounds warnings and evidence', () => {
    const report = runPressureImpact({
      filePath: 'src/bounded.ts',
      maxWarnings: 1,
      maxEvidence: 2,
      source: `
let activeCount = 0;
let queueDepth = 0;
function add() {
  activeCount++;
  queueDepth++;
}
`,
    });

    expect(report.status).toBe('partial');
    expect(report.warnings).toHaveLength(1);
    expect(report.systemsEvidence.length).toBeLessThanOrEqual(2);
    expect(report.limits).toMatchObject({
      maxWarnings: 1,
      maxEvidence: 2,
      truncated: true,
    });
  });
});
