import { describe, expect, it } from 'vitest';
import {
  buildOntologyValidationReport,
  mapOntologyConstraintSeverityToAuditSeverity,
  type OntologyConstraintFindingInput,
} from '../../src/core/ontology/validation-report.js';

function finding(overrides: Partial<OntologyConstraintFindingInput> = {}): OntologyConstraintFindingInput {
  return {
    focusNode: 'node',
    sourceShape: 'shape',
    message: 'default message',
    ...overrides,
  };
}

describe('ontology validation report builder', () => {
  it('returns a conforming empty report when no findings are supplied', () => {
    const report = buildOntologyValidationReport();

    expect(report.conforms).toBe(true);
    expect(report.counts).toEqual({
      total: 0,
      violation: 0,
      warning: 0,
      info: 0,
    });
    expect(report.results).toHaveLength(0);
    expect(report.truncation.resultsOmitted).toBe(0);
  });

  it('maps ontology severities to audit severities deterministically', () => {
    expect(mapOntologyConstraintSeverityToAuditSeverity('violation')).toBe('HIGH');
    expect(mapOntologyConstraintSeverityToAuditSeverity('warning')).toBe('MEDIUM');
    expect(mapOntologyConstraintSeverityToAuditSeverity('info')).toBe('LOW');
  });

  it('defaults missing severity to violation and rejects unknown severities', () => {
    const defaulted = buildOntologyValidationReport({
      findings: [
        finding({
          focusNode: '  node-1  ',
          sourceShape: '  shape-1  ',
          message: '  message-1  ',
        }),
      ],
    });

    expect(defaulted.results[0]).toMatchObject({
      focusNode: 'node-1',
      sourceShape: 'shape-1',
      message: 'message-1',
      severity: 'violation',
      auditSeverity: 'HIGH',
    });

    expect(() =>
      buildOntologyValidationReport({
        findings: [finding({ severity: 'critical' })],
      }),
    ).toThrow('Unknown ontology constraint severity: critical');
  });

  it('sorts findings deterministically by severity, focus node, source shape, result path, and message', () => {
    const report = buildOntologyValidationReport({
      findings: [
        finding({
          focusNode: 'node-A',
          sourceShape: 'shape-2',
          resultPath: 'r2',
          message: 'zeta',
          severity: 'warning',
        }),
        finding({
          focusNode: 'node-1',
          sourceShape: 'shape-1',
          resultPath: 'b',
          message: 'beta',
          severity: 'violation',
        }),
        finding({
          focusNode: 'node-1',
          sourceShape: 'shape-1',
          resultPath: 'a',
          message: 'gamma',
          severity: 'violation',
        }),
        finding({
          focusNode: 'node-1',
          sourceShape: 'shape-1',
          resultPath: 'a',
          message: 'alpha',
          severity: 'violation',
        }),
        finding({
          focusNode: 'node-1',
          sourceShape: 'shape-1',
          resultPath: undefined,
          message: 'no-path',
          severity: 'violation',
        }),
      ],
    });

    expect(report.results.map((result) => result.message)).toEqual([
      'no-path',
      'alpha',
      'gamma',
      'beta',
      'zeta',
    ]);
  });

  it('truncates to maxResults after sorting while keeping counts and conforms from all findings', () => {
    const report = buildOntologyValidationReport({
      findings: [
        finding({
          focusNode: 'node-1',
          sourceShape: 'shape-1',
          severity: 'warning',
          message: 'warn-1',
        }),
        finding({
          focusNode: 'node-2',
          sourceShape: 'shape-2',
          severity: 'violation',
          message: 'violation-1',
        }),
        finding({
          focusNode: 'node-3',
          sourceShape: 'shape-3',
          severity: 'info',
          message: 'info-1',
        }),
      ],
      maxResults: 1,
    });

    expect(report.results).toHaveLength(1);
    expect(report.results[0].message).toBe('violation-1');
    expect(report.counts).toEqual({
      total: 3,
      violation: 1,
      warning: 1,
      info: 1,
    });
    expect(report.conforms).toBe(false);
    expect(report.truncation.resultsOmitted).toBe(2);
  });

  it('truncates only rendered text for maxRenderedBytes and keeps structured results intact', () => {
    const report = buildOntologyValidationReport({
      findings: [
        finding({
          focusNode: 'node-1',
          sourceShape: 'shape-1',
          message: 'This is a relatively long message 1',
          severity: 'warning',
        }),
        finding({
          focusNode: 'node-2',
          sourceShape: 'shape-2',
          message: 'Another long message 2',
          severity: 'warning',
        }),
      ],
      maxRenderedBytes: 20,
    });

    expect(report.results).toHaveLength(2);
    expect(report.renderedText).not.toBeUndefined();
    expect(Buffer.byteLength(report.renderedText ?? '', 'utf8')).toBeLessThanOrEqual(20);
    expect(report.truncation.renderedTextTruncated).toBe(true);
  });

  it('keeps UTF-8 rendered text truncation byte-safe and does not emit replacement glyphs', () => {
    const findingWithEmoji = finding({
      message: 'emoji end 😀',
      severity: 'warning',
      focusNode: 'node-u',
      sourceShape: 'shape-u',
    });
    const fullReport = buildOntologyValidationReport({ findings: [findingWithEmoji] });
    const fullBytes = Buffer.byteLength(fullReport.renderedText ?? '', 'utf8');

    const report = buildOntologyValidationReport({
      findings: [findingWithEmoji],
      maxRenderedBytes: fullBytes - 1,
    });

    expect(Buffer.byteLength(report.renderedText ?? '', 'utf8')).toBeLessThanOrEqual(fullBytes - 1);
    expect(report.renderedText).not.toContain('\uFFFD');
  });

  it('returns conforms false whenever at least one accepted violation exists', () => {
    const report = buildOntologyValidationReport({
      findings: [
        finding({ severity: 'warning', message: 'warning-1' }),
        finding({
          focusNode: 'node-violation',
          sourceShape: 'shape-1',
          message: 'violation-1',
          severity: 'violation',
        }),
      ],
    });

    expect(report.conforms).toBe(false);
  });
});
