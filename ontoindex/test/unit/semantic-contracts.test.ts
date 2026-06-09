import { describe, expect, it } from 'vitest';
import {
  evaluateSemanticContracts,
  summarizeSemanticContractResult,
  type SemanticContractInput,
} from '../../src/core/runtime/semantic-contracts.js';

function input(
  diagnostics: SemanticContractInput['diagnostics'],
  overrides: Omit<Partial<SemanticContractInput>, 'diagnostics'> = {},
): SemanticContractInput {
  return {
    diagnostics,
    ...overrides,
  };
}

function diagnostic(
  overrides: Partial<SemanticContractInput['diagnostics'][number]> = {},
): SemanticContractInput['diagnostics'][number] {
  return {
    category: 'code-graph',
    kind: 'extracted',
    source: 'graph',
    authority: 'authoritative',
    subject: 'changed symbols',
    reason: 'resolved from graph index',
    advisory: false,
    ...overrides,
  };
}

describe('semantic contract evaluator', () => {
  it('passes cited diagnostics that satisfy semantic contracts', () => {
    const result = evaluateSemanticContracts(
      input([
        diagnostic(),
        diagnostic({
          category: 'docs',
          source: 'docs-sidecar',
          subject: 'ADR-0033',
          reason: 'linked to evaluator source',
          linkedFiles: ['ontoindex/src/core/runtime/semantic-contracts.ts'],
        }),
        diagnostic({
          category: 'runtime',
          kind: 'truncated',
          source: 'review-bundle',
          authority: 'advisory',
          subject: 'omitted diagnostics',
          reason: 'output omitted after limit',
          advisory: true,
          truncated: true,
        }),
      ]),
    );

    expect(result.passed).toBe(true);
    expect(result.summary.total).toBe(0);
    expect(summarizeSemanticContractResult(result)).toBe(
      'Semantic contracts passed (0 violations).',
    );
  });

  it('reports quality state placement violations for category and kind misuse', () => {
    const result = evaluateSemanticContracts(
      input([
        diagnostic({
          category: 'stale',
          kind: 'ranked-discovery',
          subject: 'stale category',
        }),
      ]),
    );

    expect(result.passed).toBe(false);
    expect(result.summary.byContract['quality-state-placement']).toBe(2);
    expect(result.violations.map((violation) => violation.reason)).toEqual([
      'Evidence diagnostic category "stale" is a quality state; use kind instead.',
      'Evidence diagnostic kind "ranked-discovery" is not a supported quality state.',
    ]);
  });

  it('reports authoritative advisory diagnostics as authority consistency violations', () => {
    const result = evaluateSemanticContracts(
      input([diagnostic({ advisory: true, subject: 'mixed authority' })]),
    );

    expect(result.summary.byContract['authority-consistency']).toBe(1);
    expect(result.violations[0]).toMatchObject({
      contract: 'authority-consistency',
      subject: 'mixed authority',
      source: 'graph',
    });
  });

  it('reports graph-derived authoritative claims when graph freshness is stale', () => {
    const result = evaluateSemanticContracts(
      input([diagnostic({ subject: 'impacted flows' })], { graphFreshness: 'stale' }),
    );

    expect(result.summary.byContract['freshness-consistency']).toBe(1);
    expect(result.violations[0]).toMatchObject({
      contract: 'freshness-consistency',
      subject: 'impacted flows',
    });
  });

  it('allows stale graph-derived claims that are downgraded to advisory', () => {
    const result = evaluateSemanticContracts(
      input(
        [
          diagnostic({
            authority: 'advisory',
            subject: 'impacted flows',
            advisory: true,
          }),
        ],
        { graphFreshness: 'degraded' },
      ),
    );

    expect(result.passed).toBe(true);
  });

  it('reports authoritative docs evidence without code or graph linkage', () => {
    const result = evaluateSemanticContracts(
      input([
        diagnostic({
          category: 'docs',
          source: 'adr',
          subject: 'ADR-0033',
          reason: 'docs-only claim',
        }),
      ]),
    );

    expect(result.summary.byContract['docs-authority-boundary']).toBe(1);
    expect(result.violations[0]).toMatchObject({
      contract: 'docs-authority-boundary',
      source: 'adr',
      subject: 'ADR-0033',
    });
  });

  it('allows authoritative docs evidence with linked code evidence', () => {
    const result = evaluateSemanticContracts(
      input(
        [
          diagnostic({
            category: 'docs',
            source: 'adr',
            subject: 'ADR-0033',
            reason: 'linked to changed symbol',
          }),
        ],
        {
          evidenceLinks: [
            {
              subject: 'ADR-0033',
              symbol: 'evaluateSemanticContracts',
            },
          ],
        },
      ),
    );

    expect(result.passed).toBe(true);
  });

  it('reports omitted evidence without a truncation diagnostic', () => {
    const result = evaluateSemanticContracts(
      input([diagnostic()], {
        boundedOutput: {
          omittedEvidenceCount: 2,
        },
      }),
    );

    expect(result.summary.byContract['truncation-visibility']).toBe(1);
    expect(result.violations[0]).toMatchObject({
      contract: 'truncation-visibility',
      subject: 'bounded output',
      source: 'semantic-contract-input',
    });
  });

  it('reports uncited user-facing diagnostics', () => {
    const result = evaluateSemanticContracts(
      input([
        diagnostic({
          source: '',
          subject: '',
          reason: '',
        }),
      ]),
    );

    expect(result.summary.byContract['citation-requirement']).toBe(1);
    expect(result.violations[0]).toMatchObject({
      contract: 'citation-requirement',
      subject: 'uncited diagnostic',
      source: 'semantic-contract-input',
      reason: 'user-facing diagnostics must cite subject, evidence, source',
    });
  });

  it('summarizes failed contract results by violation class', () => {
    const result = evaluateSemanticContracts(
      input([
        diagnostic({ advisory: true }),
        diagnostic({
          category: 'docs',
          source: 'docs-sidecar',
          subject: 'docs-only authority',
        }),
      ]),
    );

    expect(summarizeSemanticContractResult(result)).toBe(
      'Semantic contracts failed (2 violations): authority-consistency: 1, docs-authority-boundary: 1.',
    );
  });
});
