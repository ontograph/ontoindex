import { describe, it, expect } from 'vitest';
import {
  formatAuditReport,
  type AuditReportResult,
} from '../../src/mcp/local/backend-audit-report.js';

const fixture: AuditReportResult = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  repo: 'test-repo',
  commitId: 'abc1234',
  riskSurface: [
    {
      symbol: 'processPayment',
      file: 'src/payments.ts',
      riskScore: 9.5,
      callerCount: 3,
      churn: 12,
    },
    { symbol: 'validateCard', file: 'src/validator.ts', riskScore: 4.2, callerCount: 1, churn: 5 },
  ],
  openCycles: [
    [
      { name: 'A', filePath: 'a.ts' },
      { name: 'B', filePath: 'b.ts' },
    ],
  ],
  couplingViolations: [
    { module: 'Auth', ca: 2, ce: 10, instability: 0.83 },
    { module: 'DB', ca: 1, ce: 8, instability: 0.89 },
  ],
  boundaryViolations: ['src/api.ts → src/db.ts (layer violation)'],
  verificationGaps: ['src/payments.ts'],
  deadCandidates: ['legacyHelper (src/legacy.ts)'],
  recentDrift: [{ type: 'added', source: 'newFn', target: 'otherFn' }],
};

describe('formatAuditReport', () => {
  it('contains the report header with repo name', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('# Audit Report — test-repo');
  });

  it('contains the Risk Surface section heading', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('## Risk Surface');
  });

  it('contains the highest-risk symbol in the Risk Surface table', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('processPayment');
  });

  it('contains the Architectural Issues section heading', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('## Architectural Issues');
  });

  it('reports the correct import cycle count in the heading', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('Import Cycles (1 detected)');
  });

  it('contains the Coupling Outliers subsection heading', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('Coupling Outliers');
  });

  it('contains the Verification Gaps section heading', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('## Verification Gaps');
  });

  it('lists the verification gap file', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('src/payments.ts');
  });

  it('contains the Dead Code Candidates section heading', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('## Dead Code Candidates');
  });

  it('lists the dead code candidate', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('legacyHelper (src/legacy.ts)');
  });

  it('contains the Recent Drift section heading', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('## Recent Drift');
  });

  it('lists the drift entry with type and symbol names', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('[added]');
    expect(output).toContain('newFn');
    expect(output).toContain('otherFn');
  });

  it('includes a mermaid block for risk surface when riskSurface.length > 1', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('```mermaid');
  });

  it('includes a second mermaid block (coupling diagram) when couplingViolations.length > 1', () => {
    const output = formatAuditReport(fixture);
    // Two mermaid fences: risk dependency graph + coupling dependency graph
    const mermaidBlocks = output.match(/```mermaid/g);
    expect(mermaidBlocks).not.toBeNull();
    expect(mermaidBlocks!.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT include a mermaid block when riskSurface has exactly 1 entry', () => {
    const singleRisk: AuditReportResult = {
      ...fixture,
      riskSurface: [fixture.riskSurface[0]],
      couplingViolations: [fixture.couplingViolations[0]],
    };
    const output = formatAuditReport(singleRisk);
    expect(output).not.toContain('```mermaid');
  });

  it('includes annotation block when annotation is set', () => {
    const annotated: AuditReportResult = {
      ...fixture,
      annotation: 'Risk surface = tech-debt score × log(1 + churn).',
    };
    const output = formatAuditReport(annotated);
    expect(output).toContain('---');
    expect(output).toContain('Risk surface = tech-debt score');
  });

  it('does NOT include the annotation block when annotation is absent', () => {
    const output = formatAuditReport(fixture);
    expect(output).not.toContain('> Risk surface');
  });

  it('renders an empty Risk Surface table with placeholder when riskSurface is empty', () => {
    const empty: AuditReportResult = { ...fixture, riskSurface: [] };
    const output = formatAuditReport(empty);
    expect(output).toContain('| — |');
  });

  it('includes the date extracted from generatedAt in the header', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('2026-01-01');
  });

  it('includes the commitId in the header', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('abc1234');
  });

  it('lists the boundary violation entry', () => {
    const output = formatAuditReport(fixture);
    expect(output).toContain('src/api.ts → src/db.ts (layer violation)');
  });

  it('shows "No cycles detected." when openCycles is empty', () => {
    const noCycles: AuditReportResult = { ...fixture, openCycles: [] };
    const output = formatAuditReport(noCycles);
    expect(output).toContain('No cycles detected.');
  });

  it('shows "No uncovered files detected." when verificationGaps is empty', () => {
    const noGaps: AuditReportResult = { ...fixture, verificationGaps: [] };
    const output = formatAuditReport(noGaps);
    expect(output).toContain('No uncovered files detected.');
  });

  it('shows "No dead code candidates." when deadCandidates is empty', () => {
    const noDead: AuditReportResult = { ...fixture, deadCandidates: [] };
    const output = formatAuditReport(noDead);
    expect(output).toContain('No dead code candidates.');
  });

  it('shows "No recent structural drift." when recentDrift is empty', () => {
    const noDrift: AuditReportResult = { ...fixture, recentDrift: [] };
    const output = formatAuditReport(noDrift);
    expect(output).toContain('No recent structural drift.');
  });
});
