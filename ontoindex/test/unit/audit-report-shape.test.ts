/**
 * Structural assertion test for AuditReportResult.
 *
 * Replaces the v3 plan's "golden tests on a fixture repo" requirement with
 * a lighter-weight schema-drift gate: every fan-out backend is mocked with
 * realistic fixture rows, runAuditReport is invoked, and the resulting
 * shape is asserted field-by-field. This catches:
 *  - Field renames in the AuditReportResult interface
 *  - Builder code that stops populating a field
 *  - Type changes (string → number, etc.)
 *
 * It deliberately does NOT pin exact values for ranking-derived fields
 * (riskSurface order) because those depend on stable sort tiebreakers
 * the test shouldn't redundantly encode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock LLM so annotate path is skipped (no API key returned).
vi.mock('../../src/core/wiki/llm-client.js', () => ({
  resolveLLMConfig: vi.fn().mockResolvedValue({
    apiKey: '',
    baseUrl: '',
    model: '',
    maxTokens: 0,
    temperature: 0,
  }),
  callLLM: vi.fn(),
}));

vi.mock('../../src/mcp/local/backend-dead-code.js', () => ({
  runDeadCode: vi.fn().mockResolvedValue({
    entries: [
      { name: 'unusedHelper', filePath: 'src/legacy.ts' },
      { name: 'oldFn', filePath: 'src/old.ts' },
    ],
  }),
}));

vi.mock('../../src/mcp/local/backend-cycle-detect.js', () => ({
  runCycleDetect: vi.fn().mockResolvedValue({
    cycles: [
      {
        members: [
          { name: 'A', filePath: 'src/a.ts' },
          { name: 'B', filePath: 'src/b.ts' },
        ],
      },
    ],
  }),
}));

vi.mock('../../src/mcp/local/backend-coupling-matrix.js', () => ({
  runCouplingMatrix: vi.fn().mockResolvedValue({
    rows: [
      { community: 'Auth', ca: 2, ce: 12, instability: 0.86 },
      { community: 'DB', ca: 1, ce: 5, instability: 0.83 },
      { community: 'Stable', ca: 5, ce: 1, instability: 0.17 },
    ],
  }),
}));

vi.mock('../../src/mcp/local/backend-tech-debt.js', () => ({
  runTechDebt: vi.fn().mockResolvedValue({
    symbols: [
      { name: 'processPayment', filePath: 'src/pay.ts', score: 9.5, callerCount: 3 },
      { name: 'validateCard', filePath: 'src/val.ts', score: 4.2, callerCount: 1 },
    ],
  }),
}));

vi.mock('../../src/mcp/local/backend-hotspot-analysis.js', () => ({
  runHotspotAnalysis: vi.fn().mockResolvedValue({
    hotspots: [{ file: 'src/pay.ts', commits: 12 }],
  }),
}));

vi.mock('../../src/mcp/local/backend-boundary-violations.js', () => ({
  runBoundaryViolations: vi.fn().mockResolvedValue({
    violations: [
      { source_file: 'src/api.ts', target_file: 'src/db.ts', rule_label: 'layer violation' },
    ],
  }),
}));

vi.mock('../../src/mcp/local/backend-verification-gap.js', () => ({
  runVerificationGap: vi.fn().mockResolvedValue({
    coverage: [
      { filePath: 'src/pay.ts', status: 'uncovered' },
      { filePath: 'src/val.ts', status: 'covered' },
    ],
  }),
}));

vi.mock('../../src/mcp/local/backend-graph-diff.js', () => ({
  runGraphDiff: vi.fn().mockResolvedValue({
    added: [{ source_name: 'newFn', target_name: 'helper' }],
    removed: [{ source_file: 'old.ts', target_file: 'gone.ts' }],
  }),
}));

import {
  runAuditReport,
  type AuditReportResult,
} from '../../src/mcp/local/backend-audit-report.js';
import { runDeadCode } from '../../src/mcp/local/backend-dead-code.js';
import { runCycleDetect } from '../../src/mcp/local/backend-cycle-detect.js';
import { runCouplingMatrix } from '../../src/mcp/local/backend-coupling-matrix.js';
import { runTechDebt } from '../../src/mcp/local/backend-tech-debt.js';
import { runHotspotAnalysis } from '../../src/mcp/local/backend-hotspot-analysis.js';
import { runBoundaryViolations } from '../../src/mcp/local/backend-boundary-violations.js';
import { runVerificationGap } from '../../src/mcp/local/backend-verification-gap.js';
import { runGraphDiff } from '../../src/mcp/local/backend-graph-diff.js';

const repo = {
  id: 'fixture',
  name: 'fixture-repo',
  repoPath: '/tmp/fixture',
  storagePath: '/tmp/fixture/.ontoindex',
  lastCommit: 'deadbeef',
};

describe('AuditReportResult shape — structural drift gate', () => {
  let result: AuditReportResult;

  beforeEach(async () => {
    result = await runAuditReport(repo, {});
  });

  it('has all required scalar fields', () => {
    expect(typeof result.generatedAt).toBe('string');
    expect(typeof result.repo).toBe('string');
    expect(typeof result.commitId).toBe('string');
    expect(result.repo).toBe('fixture-repo');
    expect(result.commitId).toBe('deadbeef');
  });

  it('generatedAt is a valid ISO 8601 timestamp', () => {
    expect(() => new Date(result.generatedAt).toISOString()).not.toThrow();
    // Loose ISO check — zone may be Z or +00:00.
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('riskSurface is an array of {symbol, file, riskScore, callerCount, churn}', () => {
    expect(Array.isArray(result.riskSurface)).toBe(true);
    expect(result.riskSurface.length).toBeGreaterThan(0);
    for (const item of result.riskSurface) {
      expect(typeof item.symbol).toBe('string');
      expect(typeof item.file).toBe('string');
      expect(typeof item.riskScore).toBe('number');
      expect(typeof item.callerCount).toBe('number');
      expect(typeof item.churn).toBe('number');
    }
  });

  it('openCycles is an array of cycle-member arrays', () => {
    expect(Array.isArray(result.openCycles)).toBe(true);
    for (const cycle of result.openCycles) {
      expect(Array.isArray(cycle)).toBe(true);
      for (const member of cycle) {
        expect(typeof member.name).toBe('string');
        expect(typeof member.filePath).toBe('string');
      }
    }
  });

  it('couplingViolations contains only instability > 0.8 entries', () => {
    expect(Array.isArray(result.couplingViolations)).toBe(true);
    for (const cv of result.couplingViolations) {
      expect(typeof cv.module).toBe('string');
      expect(typeof cv.ca).toBe('number');
      expect(typeof cv.ce).toBe('number');
      expect(typeof cv.instability).toBe('number');
      expect(cv.instability).toBeGreaterThan(0.8);
    }
    // Stable module (instability 0.17) must have been filtered out.
    expect(result.couplingViolations.find((c) => c.module === 'Stable')).toBeUndefined();
  });

  it('boundaryViolations is an array of strings', () => {
    expect(Array.isArray(result.boundaryViolations)).toBe(true);
    for (const v of result.boundaryViolations) {
      expect(typeof v).toBe('string');
    }
  });

  it('verificationGaps contains only uncovered file paths', () => {
    expect(Array.isArray(result.verificationGaps)).toBe(true);
    for (const g of result.verificationGaps) {
      expect(typeof g).toBe('string');
    }
    // Covered file ('src/val.ts') must have been filtered out.
    expect(result.verificationGaps).toContain('src/pay.ts');
    expect(result.verificationGaps).not.toContain('src/val.ts');
  });

  it('deadCandidates is an array of strings', () => {
    expect(Array.isArray(result.deadCandidates)).toBe(true);
    for (const d of result.deadCandidates) {
      expect(typeof d).toBe('string');
    }
  });

  it('recentDrift entries have type/source/target shape', () => {
    expect(Array.isArray(result.recentDrift)).toBe(true);
    for (const d of result.recentDrift) {
      expect(typeof d.type).toBe('string');
      expect(['added', 'removed']).toContain(d.type);
      expect(typeof d.source).toBe('string');
      expect(typeof d.target).toBe('string');
    }
  });

  it('warnings is an array of strings (empty when all backends succeed)', () => {
    expect(Array.isArray(result.warnings)).toBe(true);
    for (const w of result.warnings) {
      expect(typeof w).toBe('string');
    }
  });

  it('annotation is undefined when annotate is not requested', () => {
    expect(result.annotation).toBeUndefined();
  });

  it('result has no unexpected top-level keys (interface-drift gate)', () => {
    const expected = new Set([
      'generatedAt',
      'repo',
      'commitId',
      'riskSurface',
      'openCycles',
      'couplingViolations',
      'boundaryViolations',
      'verificationGaps',
      'deadCandidates',
      'recentDrift',
      'warnings',
      'annotation',
    ]);
    for (const key of Object.keys(result)) {
      expect(expected.has(key)).toBe(true);
    }
  });

  it('bounds audit backend fan-out concurrency', async () => {
    vi.clearAllMocks();
    let inFlight = 0;
    let maxInFlight = 0;
    const delayed = <T>(value: T) =>
      vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return value;
      });

    vi.mocked(runDeadCode).mockImplementation(delayed({ entries: [] }));
    vi.mocked(runCycleDetect).mockImplementation(delayed({ cycles: [] }));
    vi.mocked(runCouplingMatrix).mockImplementation(delayed({ rows: [] }));
    vi.mocked(runTechDebt).mockImplementation(delayed({ symbols: [] }));
    vi.mocked(runHotspotAnalysis).mockImplementation(delayed({ hotspots: [] }));
    vi.mocked(runBoundaryViolations).mockImplementation(delayed({ violations: [] }));
    vi.mocked(runVerificationGap).mockImplementation(delayed({ coverage: [] }));
    vi.mocked(runGraphDiff).mockImplementation(delayed({ added: [], removed: [] }));

    await runAuditReport(repo, {});

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
