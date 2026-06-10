import { describe, expect, it } from 'vitest';
import {
  evaluateEvidenceDiagnosticProfile,
  type EvidenceDiagnosticSurfaceProfile,
} from '../../src/core/runtime/evidence-diagnostic-profiles.js';
import type { EvidenceDiagnosticRecord } from '../../src/core/runtime/evidence-diagnostics.js';

function record(overrides: Partial<EvidenceDiagnosticRecord> = {}): EvidenceDiagnosticRecord {
  return {
    category: 'core',
    kind: 'extracted',
    source: 'graph',
    authority: 'authoritative',
    subject: 'subject',
    reason: 'resolved from graph',
    advisory: false,
    ...overrides,
  };
}

function evaluate(profile: EvidenceDiagnosticSurfaceProfile, diagnostics: EvidenceDiagnosticRecord[]) {
  return evaluateEvidenceDiagnosticProfile({ profile, diagnostics });
}

describe('evidence diagnostic profile evaluator', () => {
  it('passes valid diagnostics through the profile checks', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      allowedCategories: ['core'],
      allowedSources: ['graph'],
      allowedAuthorities: ['authoritative', 'advisory'],
      allowedKinds: ['extracted'],
    };

    const diagnostics = [record()];
    const report = evaluate(profile, diagnostics);

    expect(report.summary.total).toBe(0);
    expect(report.violations).toEqual([]);
  });

  it('allows unknown category and source when allowlists are not configured', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
    };

    const report = evaluate(profile, [record({ category: 'runtime', source: 'custom' })]);

    expect(report.violations).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it('flags disallowed categories', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      allowedCategories: ['docs'],
    };

    const report = evaluate(profile, [record({ category: 'runtime' })]);

    expect(report.violations.map((item) => item.kind)).toEqual(['category-not-allowed']);
  });

  it('flags disallowed sources', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      allowedSources: ['docs'],
    };

    const report = evaluate(profile, [record({ source: 'graph' })]);

    expect(report.violations.map((item) => item.kind)).toEqual(['source-not-allowed']);
  });

  it('flags authority values outside both runtime validity and profile allowlist', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      allowedAuthorities: ['advisory'],
    };

    const badAuthority = record({ authority: 'trusted' as never });
    const report = evaluate(profile, [badAuthority]);

    expect(report.violations.map((item) => item.kind)).toEqual(['authority-not-allowed']);
  });

  it('flags disallowed quality kinds', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      allowedKinds: ['extracted'],
    };

    const report = evaluate(profile, [record({ kind: 'degraded' })]);

    expect(report.violations.map((item) => item.kind)).toEqual(['kind-not-allowed']);
  });

  it('flags quality state values that are placed in category', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
    };

    const report = evaluate(profile, [record({ category: 'ambiguous' })]);

    expect(report.violations.map((item) => item.kind)).toEqual(['kind-not-allowed']);
  });

  it('accepts bounded truncation diagnostics when truncation is required', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      requireTruncationDiagnosticWhenBounded: true,
    };

    const report = evaluateEvidenceDiagnosticProfile({
      profile,
      diagnostics: [record({ kind: 'truncated', truncated: true })],
      boundedOutput: {
        omittedEvidenceCount: 3,
      },
    });

    expect(report.violations.map((item) => item.kind)).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it('flags missing reason when required', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      requireReason: true,
    };

    const report = evaluate(profile, [record({ reason: '   ' })]);

    expect(report.violations.map((item) => item.kind)).toEqual(['missing-reason']);
  });

  it('flags missing freshness for authoritative diagnostics when required', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      requireFreshnessForAuthoritative: true,
    };

    const report = evaluate(profile, [record()]);

    expect(report.violations.map((item) => item.kind)).toEqual(['missing-authoritative-freshness']);
  });

  it('flags missing truncation marker when bounded output omits evidence', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      requireTruncationDiagnosticWhenBounded: true,
    };

    const report = evaluateEvidenceDiagnosticProfile({
      profile,
      diagnostics: [record({ kind: 'stale', truncated: false })],
      boundedOutput: {
        evidenceOmitted: true,
      },
    });

    expect(report.violations.map((item) => item.kind)).toEqual(['missing-truncation-diagnostic']);
  });

  it('flags omitted evidence count as bounded truncation even without evidenceOmitted', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      requireTruncationDiagnosticWhenBounded: true,
    };

    const report = evaluateEvidenceDiagnosticProfile({
      profile,
      diagnostics: [record()],
      boundedOutput: {
        omittedEvidenceCount: 3,
      },
    });

    expect(report.violations).toEqual([
      expect.objectContaining({
        kind: 'missing-truncation-diagnostic',
      }),
    ]);
  });

  it('is deterministic by diagnostic order and violation kind', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      allowedCategories: ['core'],
      allowedSources: ['graph'],
      allowedAuthorities: ['authoritative', 'advisory'],
      allowedKinds: ['extracted'],
      requireReason: true,
      requireFreshnessForAuthoritative: true,
    };

    const report = evaluate(profile, [
      record({
        subject: 'second',
        category: 'forbidden',
        source: 'runtime',
        authority: 'advisory',
        kind: 'degraded',
        reason: '   ',
      }),
      record({
        subject: 'first',
        category: 'core',
        source: 'graph',
        authority: 'authoritative',
        kind: 'stale',
        reason: '',
        freshness: '',
      }),
    ]);

    expect(report.violations.map((item) => item.kind)).toEqual([
      'category-not-allowed',
      'source-not-allowed',
      'kind-not-allowed',
      'missing-reason',
      'kind-not-allowed',
      'missing-reason',
      'missing-authoritative-freshness',
    ]);
    expect(report.violations.map((item) => item.subject)).toEqual([
      'second',
      'second',
      'second',
      'second',
      'first',
      'first',
      'first',
    ]);
  });

  it('aggregates summary.byKind counts across multiple violation kinds', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      allowedCategories: ['core'],
      allowedSources: ['graph'],
      allowedKinds: ['extracted'],
      requireReason: true,
      requireTruncationDiagnosticWhenBounded: true,
    };

    const report = evaluateEvidenceDiagnosticProfile({
      profile,
      diagnostics: [
        record({ category: 'runtime' }),
        record({ source: 'runtime' }),
        record({ reason: '   ' }),
        record({ kind: 'degraded' }),
      ],
      boundedOutput: {
        omittedEvidenceCount: 2,
      },
    });

    expect(report.summary).toEqual({
      total: 5,
      byKind: {
        'category-not-allowed': 1,
        'source-not-allowed': 1,
        'authority-not-allowed': 0,
        'kind-not-allowed': 1,
        'missing-reason': 1,
        'missing-authoritative-freshness': 0,
        'missing-truncation-diagnostic': 1,
      },
    });
  });

  it('does not mutate profile or diagnostics inputs', () => {
    const profile: EvidenceDiagnosticSurfaceProfile = {
      id: 'review-surface',
      allowedCategories: ['core'],
      allowedSources: ['graph'],
      allowedAuthorities: ['authoritative'],
      allowedKinds: ['extracted'],
      requireReason: true,
      requireTruncationDiagnosticWhenBounded: true,
    };
    const diagnostics = [
      record({ category: 'runtime', source: 'runtime', kind: 'degraded', reason: '   ' }),
    ];
    const profileBefore = structuredClone(profile);
    const diagnosticsBefore = structuredClone(diagnostics);

    evaluateEvidenceDiagnosticProfile({
      profile,
      diagnostics,
      boundedOutput: {
        omittedEvidenceCount: 1,
      },
    });

    expect(profile).toEqual(profileBefore);
    expect(diagnostics).toEqual(diagnosticsBefore);
  });

  it('does not emit recommendation or audit lifecycle fields', () => {
    const report = evaluateEvidenceDiagnosticProfile({
      profile: {
        id: 'review-surface',
        requireTruncationDiagnosticWhenBounded: true,
      },
      diagnostics: [record()],
      boundedOutput: {
        omittedEvidenceCount: 2,
      },
    });

    expect('recommendation' in report).toBe(false);
    expect('recommendations' in report).toBe(false);
    expect('auditLifecycle' in report).toBe(false);
    expect('lifecycle' in report).toBe(false);
    expect('auditLifeCycle' in report).toBe(false);
    expect('recommendationIds' in report).toBe(false);
  });
});
