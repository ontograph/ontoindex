import { describe, expect, it } from 'vitest';
import {
  buildHypothesisGroundingReport,
  type GroundingCitation,
  type GroundingRelationKind,
  type HypothesisGroundingInput,
} from '../../src/core/reasoning/hypothesis-grounding.js';
import { evaluateSemanticContracts } from '../../src/core/runtime/semantic-contracts.js';

const VALID_GAP_KINDS = [
  'missing-required-premise',
  'refuted-premise',
  'ambiguous-premise',
  'uncited-evidence',
  'truncated-evidence',
] as const;

const VALID_DIAGNOSTIC_KINDS = [
  'ambiguous',
  'degraded',
  'extracted',
  'inferred',
  'stale',
  'truncated',
] as const;

const REPORT_VERDICT_STATUSES = [
  'supported',
  'refuted',
  'ambiguous',
  'missing',
] as const;
const AUDIT_LIFECYCLE_STATUSES = ['OPEN', 'FIXED', 'VERIFIED', 'NEEDS-VERIFY', 'HOLD'] as const;

const hypothesis = {
  id: 'h1',
  statement: 'Service startup should initialize safely.',
};

const premise = (id: string, statement: string, required = true) => ({
  id,
  statement,
  required,
});

const evidence = (
  id: string,
  premiseId: string,
  relation: GroundingRelationKind,
  citation: GroundingCitation,
) => ({ id, premiseId, relation, citation });

const fileCitation = (filePath: string): GroundingCitation => ({
  filePath,
});

const docsCitation = (docPath: string): GroundingCitation => ({
  docPath,
});

describe('hypothesis grounding report builder', () => {
  it('marks a premise as supported when cited support evidence exists', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [premise('p1', 'A startup hook exists.')],
      evidence: [evidence('e1', 'p1', 'supports', fileCitation('/src/startup.ts'))],
    } satisfies HypothesisGroundingInput);

    expect(report.premiseVerdicts).toHaveLength(1);
    expect(report.premiseVerdicts[0]?.status).toBe('supported');
    expect(report.premiseVerdicts[0]?.supportEvidenceIds).toEqual(['e1']);
    expect(report.gapManifest).toHaveLength(0);
    expect(report.diagnostics).toHaveLength(0);
  });

  it('marks a premise as refuted when refuting evidence exists', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [premise('p1', 'Startup hook is safe.')],
      evidence: [evidence('e2', 'p1', 'refutes', fileCitation('/src/startup.ts'))],
    } satisfies HypothesisGroundingInput);

    expect(report.premiseVerdicts[0]?.status).toBe('refuted');
    expect(report.gapManifest).toHaveLength(1);
    expect(report.gapManifest[0]).toMatchObject({
      kind: 'refuted-premise',
      premiseId: 'p1',
    });
  });

  it('adds a missing-required-premise gap when required evidence is absent', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [premise('p1', 'Startup initializes logging.')],
      evidence: [],
    } satisfies HypothesisGroundingInput);

    expect(report.premiseVerdicts[0]?.status).toBe('missing');
    expect(report.gapManifest).toHaveLength(1);
    expect(report.gapManifest[0]).toMatchObject({
      kind: 'missing-required-premise',
      premiseId: 'p1',
    });
  });

  it('marks mixed support and refute evidence as ambiguous', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [premise('p1', 'Startup must initialize logging.')],
      evidence: [
        evidence('e3', 'p1', 'supports', fileCitation('/src/startup.ts')),
        evidence('e4', 'p1', 'refutes', fileCitation('/src/startup.ts')),
      ],
    } satisfies HypothesisGroundingInput);

    expect(report.premiseVerdicts[0]?.status).toBe('ambiguous');
    expect(report.gapManifest).toHaveLength(1);
    expect(report.gapManifest[0]).toMatchObject({ kind: 'ambiguous-premise', premiseId: 'p1' });
  });

  it('ignores uncited evidence for premise decisions and reports uncited evidence gaps', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [premise('p1', 'Startup must initialize logging.')],
      evidence: [
        evidence('e5', 'p1', 'supports', {}),
        evidence('e6', 'p1', 'refutes', fileCitation('/src/startup.ts')),
      ],
    } satisfies HypothesisGroundingInput);

    expect(report.premiseVerdicts[0]?.status).toBe('refuted');
    expect(report.gapManifest.map((gap) => gap.kind)).toContain('uncited-evidence');
    expect(report.diagnostics.some((diagnostic) => diagnostic.kind === 'ambiguous')).toBe(true);
  });

  it('does not let docs-only evidence satisfy code premises', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [
        {
          ...premise('p1', 'Startup hook mutates process state.', true),
          evidenceKind: 'code',
        },
      ],
      evidence: [evidence('e7', 'p1', 'supports', docsCitation('/docs/startup.md'))],
    } satisfies HypothesisGroundingInput);

    expect(report.premiseVerdicts[0]?.status).toBe('missing');
    expect(report.gapManifest.map((gap) => gap.kind)).toContain('uncited-evidence');
  });

  it('allows docs-only evidence to satisfy docs premises', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [
        {
          ...premise('p1', 'Startup behavior is described in docs.'),
          evidenceKind: 'docs',
        },
      ],
      evidence: [evidence('e7', 'p1', 'supports', docsCitation('/docs/startup.md'))],
    } satisfies HypothesisGroundingInput);

    expect(report.premiseVerdicts[0]?.status).toBe('supported');
    expect(report.gapManifest).toHaveLength(0);
    expect(report.diagnostics).toHaveLength(0);
  });

  it('passes semantic-contract checks for generated diagnostic output', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [premise('p1', 'Startup is described in source and docs.')],
      evidence: [evidence('e8', 'p1', 'supports', {}), evidence('e9', 'p1', 'supports', fileCitation('/src/startup.ts'))],
    } satisfies HypothesisGroundingInput);

    const result = evaluateSemanticContracts({ diagnostics: report.diagnostics });

    expect(result.passed).toBe(true);
    expect(result.summary.total).toBe(0);
  });

  it('passes semantic-contract truncation visibility checks when truncation is declared', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [premise('p1', 'Startup sets defaults.')],
      evidence: [
        evidence('e10', 'p1', 'supports', fileCitation('/src/startup.ts')),
        evidence('e11', 'p1', 'supports', fileCitation('/src/startup.ts')),
        evidence('e12', 'p1', 'supports', fileCitation('/src/startup.ts')),
      ],
      maxEvidencePerPremise: 1,
    } satisfies HypothesisGroundingInput);

    const result = evaluateSemanticContracts({
      diagnostics: report.diagnostics,
      boundedOutput: {
        evidenceOmitted: report.summary.truncatedEvidenceCount > 0,
        omittedEvidenceCount: report.summary.truncatedEvidenceCount,
      },
    });

    expect(report.summary.truncatedEvidenceCount).toBeGreaterThan(0);
    expect(result.passed).toBe(true);
    expect(result.summary.total).toBe(0);
  });

  it('keeps gap output free of recommendation metadata and audit-life-cycle statuses', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [
        premise('p1', 'Missing gap should be missing.'),
        premise('p2', 'Code premise should be ambiguous.'),
      ],
      evidence: [
        evidence('e13', 'p2', 'supports', docsCitation('/docs/startup.md')),
        evidence('e14', 'p2', 'mentions', docsCitation('/docs/startup.md')),
      ],
    } satisfies HypothesisGroundingInput);

    for (const gap of report.gapManifest) {
      expect(VALID_GAP_KINDS).toContain(gap.kind);
      expect(gap).not.toHaveProperty('status');
      expect(gap).not.toHaveProperty('condition');
      expect(gap).not.toHaveProperty('name');
      expect(gap).not.toHaveProperty('tool');
      expect(gap).not.toHaveProperty('nextTools');
      expect(gap).not.toHaveProperty('nonToolActions');
    }

    for (const verdict of report.premiseVerdicts) {
      expect(REPORT_VERDICT_STATUSES).toContain(verdict.status);
      expect(AUDIT_LIFECYCLE_STATUSES).not.toContain(verdict.status);
    }

    for (const diagnostic of report.diagnostics) {
      expect(diagnostic).not.toHaveProperty('status');
      expect(VALID_DIAGNOSTIC_KINDS).toContain(diagnostic.kind);
    }
  });

  it('emits only known diagnostic quality kinds', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [
        premise('p1', 'Startup mutates process state.'),
        premise('p2', 'Startup must be audited.'),
      ],
      evidence: [
        evidence('e15', 'p1', 'supports', {}),
        evidence('e16', 'p1', 'supports', fileCitation('/src/startup.ts')),
        evidence('e17', 'p2', 'supports', fileCitation('/src/startup.ts')),
        evidence('e18', 'p2', 'supports', fileCitation('/src/startup.ts')),
        evidence('e19', 'p2', 'supports', fileCitation('/src/startup.ts')),
      ],
      maxEvidencePerPremise: 1,
    } satisfies HypothesisGroundingInput);

    const invalidDiagnosticKinds = report.diagnostics.filter(
      (diagnostic) => !VALID_DIAGNOSTIC_KINDS.includes(diagnostic.kind),
    );
    expect(invalidDiagnosticKinds).toHaveLength(0);
  });

  it('caps evidence per premise and emits truncation diagnostics', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [premise('p1', 'Startup sets defaults.')],
      evidence: [
        evidence('e8', 'p1', 'supports', fileCitation('/src/startup.ts')),
        evidence('e9', 'p1', 'supports', fileCitation('/src/startup.ts')),
        evidence('e10', 'p1', 'supports', fileCitation('/src/startup.ts')),
      ],
      maxEvidencePerPremise: 2,
    } satisfies HypothesisGroundingInput);

    expect(report.premiseVerdicts[0]?.supportEvidenceIds).toEqual(['e8', 'e9']);
    expect(report.gapManifest.some((gap) => gap.kind === 'truncated-evidence')).toBe(true);
    expect(report.diagnostics.some((diagnostic) => diagnostic.kind === 'truncated')).toBe(true);
  });

  it('caps gap count and emits truncation diagnostics for large gap manifests', () => {
    const report = buildHypothesisGroundingReport({
      hypothesis,
      premises: [
        premise('p1', 'Missing 1', true),
        premise('p2', 'Missing 2', true),
        premise('p3', 'Missing 3', true),
      ],
      evidence: [],
      maxGaps: 2,
    } satisfies HypothesisGroundingInput);

    expect(report.gapManifest).toHaveLength(2);
    expect(report.diagnostics.some((diagnostic) => diagnostic.kind === 'truncated')).toBe(true);
  });

  it('returns deterministic output for identical inputs', () => {
    const input = {
      hypothesis,
      premises: [premise('p1', 'Startup is initialized.'), premise('p2', 'Hooks are registered.')],
      evidence: [
        evidence('e11', 'p1', 'supports', fileCitation('/src/startup.ts')),
        evidence('e12', 'p2', 'refutes', fileCitation('/src/startup.ts')),
      ],
    } satisfies HypothesisGroundingInput;
    const first = buildHypothesisGroundingReport(input);
    const second = buildHypothesisGroundingReport(input);
    expect(second).toEqual(first);
  });
});
