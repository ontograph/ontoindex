import { describe, expect, it } from 'vitest';
import {
  buildArchitectureTour,
  formatArchitectureTourMarkdown,
  type ArchitectureTourEvidence,
  type ArchitectureTourEvidenceKind,
  type ArchitectureTourSubject,
} from '../../src/core/runtime/architecture-tour.js';
import { evaluateSemanticContracts } from '../../src/core/runtime/semantic-contracts.js';

const subject = (key: string, label: string, kind: ArchitectureTourEvidenceKind): ArchitectureTourSubject => ({
  key,
  label,
  kind,
});

const citation = (overrides: Record<string, string> = {}) => ({
  filePath: '/src/index.ts',
  ...overrides,
});

const evidence = (
  kind: ArchitectureTourEvidenceKind,
  subjectData: ArchitectureTourSubject,
  title: string,
  summary: string,
  citationValues: Record<string, string>[] = [],
) => ({
  kind,
  subject: subjectData,
  title,
  summary,
  citations: citationValues.length > 0 ? citationValues.map((value) => citation(value)) : [citation()],
} as ArchitectureTourEvidence);

describe('architecture tour builder', () => {
  it('creates a diagnostic when an evidence item has no usable citations', () => {
    const result = buildArchitectureTour({
      evidence: [
        evidence('symbol', subject('alpha', 'Alpha symbol', 'symbol'), 'Alpha', 'Symbol summary', [{}]),
        {
          kind: 'file',
          subject: subject('file', 'Orphan file', 'file'),
          title: 'Orphan file',
          summary: 'No citations',
          citations: [],
        },
      ],
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.title).toBe('Alpha symbol');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.kind).toBe('ambiguous');
    expect(result.diagnostics[0]?.subject).toBe('Orphan file');
  });

  it('orders steps deterministically across identical evidence sets', () => {
    const graph = evidence(
      'graph-node',
      subject('graph-core', 'Graph Node', 'graph-node'),
      'Graph node summary',
      'Graph summary',
      [{ filePath: '/src/graph.ts', symbolName: 'coreGraph' }],
    );
    const symbol = evidence(
      'symbol',
      subject('symbol-core', 'Auth symbol', 'symbol'),
      'Auth symbol summary',
      'Auth summary',
      [{ symbolName: 'AuthService' }],
    );
    const file = evidence(
      'file',
      subject('file-core', 'File core', 'file'),
      'File core',
      'File summary',
      [{ filePath: '/src/core.ts' }],
    );
    const process = evidence(
      'process',
      subject('process-core', 'Process core', 'process'),
      'Process core',
      'Process summary',
      [{ processId: 'process-1' }],
    );
    const diff = evidence(
      'diff-review',
      subject('diff-core', 'Diff core', 'diff-review'),
      'Diff core',
      'Diff summary',
      [{ filePath: '/src/core.ts', diagnosticId: 'dr-1' }],
    );

    const canonical = [
      buildArchitectureTour({ evidence: [graph, symbol, file, process, diff] }),
      buildArchitectureTour({ evidence: [diff, file, graph, process, symbol] }),
    ];

    expect(canonical[1]?.steps.map((step) => step.id)).toEqual([
      'step:graph-core',
      'step:symbol-core',
      'step:process-core',
      'step:file-core',
      'step:diff-core',
    ]);
    expect(canonical[1]?.steps.map((step) => step.id)).toEqual(canonical[0]?.steps.map((step) => step.id));
  });

  it('marks docs-sidecar evidence as advisory when unlinked', () => {
    const result = buildArchitectureTour({
      evidence: [
        evidence('docs-sidecar', subject('docs-core', 'Core ADR', 'docs-sidecar'), 'Docs note', 'Docs summary', [
          { filePath: '/docs/adr-0032.md' },
        ]),
      ],
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.evidenceKind).toBe('docs-sidecar');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.kind).toBe('degraded');
    expect(result.diagnostics[0]?.subject).toBe('Core ADR');
  });

  it('limits step count and citation count and emits truncation diagnostics', () => {
    const result = buildArchitectureTour({
      maxSteps: 2,
      maxCitationsPerStep: 1,
      evidence: [
        evidence('file', subject('file-one', 'File one', 'file'), 'File one', 'Summary', [
          { filePath: '/src/file-one.ts' },
          { filePath: '/src/file-one-other.ts' },
          { filePath: '/src/file-one-third.ts' },
        ]),
        evidence('file', subject('file-two', 'File two', 'file'), 'File two', 'Summary', [
          { filePath: '/src/file-two.ts' },
        ]),
        evidence('file', subject('file-three', 'File three', 'file'), 'File three', 'Summary', [
          { filePath: '/src/file-three.ts' },
        ]),
      ],
    });

    expect(result.steps).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'truncated')).toBe(true);
    const citationStep = result.steps[0];
    expect(citationStep?.citations).toHaveLength(1);
  });

  it('never emits a step for evidence without citations', () => {
    const result = buildArchitectureTour({
      evidence: [
        evidence('file', subject('valid', 'Valid file', 'file'), 'Valid', 'Valid summary', [
          { filePath: '/src/valid.ts' },
        ]),
        {
          kind: 'process',
          subject: subject('invalid', 'Invalid process', 'process'),
          title: 'No citation',
          summary: 'Missing',
          citations: [{}],
        },
      ],
    });

    expect(result.steps.map((step) => step.title)).toEqual(['Valid file']);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]?.subject).toBe('Invalid process');
    expect(result.diagnostics[0]?.kind).toBe('ambiguous');
  });

  it('renders markdown with explicit citation references for each step', () => {
    const markdown = formatArchitectureTourMarkdown(
      buildArchitectureTour({
        evidence: [
          evidence(
            'symbol',
            subject('auth', 'Authentication layer', 'symbol'),
            'Authentication layer',
            'Auth flow is routed through a dedicated boundary.',
            [
              { filePath: '/src/auth.ts', symbolName: 'AuthService' },
              { processId: 'auth-process', filePath: '/src/auth.ts' },
            ],
          ),
          evidence('graph-node', subject('route', 'Routing layer', 'graph-node'), 'Routing layer', 'Routes are clustered by boundary.', [
            { nodeId: 'route-node', filePath: '/src/router.ts' },
          ]),
        ],
        maxSteps: 2,
      }),
    );

    expect(markdown).toContain('# Architecture Tour');
    expect(markdown).toContain('### step:auth - Authentication layer');
    expect(markdown).toContain('(citations: [1] file');
    expect(markdown).toContain('- **Citations:**');
    expect(markdown).toContain('symbol AuthService');
  });

  it('renders diagnostics section when diagnostics are present', () => {
    const markdown = formatArchitectureTourMarkdown(
      buildArchitectureTour({
        maxSteps: 1,
        maxCitationsPerStep: 1,
        evidence: [
          evidence('docs-sidecar', subject('docs', 'Core ADR', 'docs-sidecar'), 'Core ADR', 'Core overview context.', [
            { filePath: '/docs/adr/0032.md' },
          ]),
          evidence('file', subject('file-a', 'Index file', 'file'), 'Index file', 'File-level summary.', [
            { filePath: '/src/index.ts' },
          ]),
          evidence('file', subject('file-b', 'Diff file', 'file'), 'Diff file', 'Diff summary.', [
            { filePath: '/src/diff.ts' },
          ]),
        ],
      }),
    );

    expect(markdown).toContain('## Diagnostics');
    expect(markdown).toContain('Records: **');
    expect(markdown).toContain('### Tour Diagnostics');
    expect(markdown).toContain('- [advisory/architecture-tour]');
  });

  it('never emits step prose without citation references', () => {
    const markdown = formatArchitectureTourMarkdown(
      buildArchitectureTour({
        evidence: [
          evidence(
            'file',
            subject('step', 'Referenced step', 'file'),
            'Referenced step',
            'Evidence-rich summary.',
            [{ filePath: '/src/referenced.ts' }],
          ),
        ],
      }),
    );

    const summaryLines = markdown
      .split('\n')
      .filter((line) => line.startsWith('- **Summary:**'));

    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toContain('(citations: [1]');
    expect(summaryLines[0]).not.toContain('(no citations provided)');
  });

  it('passes semantic contracts for rendered tour diagnostics', () => {
    const tour = buildArchitectureTour({
      maxSteps: 1,
      maxCitationsPerStep: 1,
      evidence: [
        evidence('file', subject('file', 'Indexed file', 'file'), 'Indexed file', 'Indexed file summary.', [
          { filePath: '/src/index.ts' },
          { filePath: '/src/index-extra.ts' },
          { filePath: '/src/index-more.ts' },
        ]),
        evidence('symbol', subject('sym', 'Symbol edge', 'symbol'), 'Symbol edge', 'Symbol edge summary.', [
          { filePath: '/src/symbol.ts', symbolName: 'SymbolEdge' },
        ]),
        evidence('docs-sidecar', subject('docs', 'Core ADR', 'docs-sidecar'), 'Core ADR', 'Docs-only context.', [
          { filePath: '/docs/adr-0032.md' },
        ]),
      ],
    });

    const contracts = evaluateSemanticContracts({
      diagnostics: [...tour.diagnostics, ...tour.steps.flatMap((step) => step.diagnostics)],
      boundedOutput: {
        omittedEvidenceCount: tour.truncated ? 1 : 0,
        evidenceOmitted: tour.truncated,
      },
    });

    expect(contracts.passed).toBe(true);
    expect(contracts.summary.total).toBe(0);

    const unexpectedKinds = tour.diagnostics
      .map((diagnostic) => diagnostic.kind)
      .filter((kind) => !['ambiguous', 'degraded', 'extracted', 'inferred', 'stale', 'truncated'].includes(kind));

    expect(unexpectedKinds).toHaveLength(0);
  });
});
