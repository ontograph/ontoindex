import { describe, expect, it } from 'vitest';

import { diffAbi } from '../../src/core/systems-audit/abi-diff.js';

describe('systems ABI diff analyzer', () => {
  it('flags uint64 precision loss when TypeScript uses number', () => {
    const report = diffAbi({
      sourcePath: 'wire.h',
      targetPath: 'wire.ts',
      sourceStruct: `
        struct Wire {
          uint64_t id;
          const char* name;
        };
      `,
      targetInterface: `
        interface Wire {
          id: number;
          name: string;
        }
      `,
    });

    expect(report.sidecarRecord).toMatchObject({
      kind: 'systems.abi_diff',
      analyzerId: 'gn_abi_diff',
      provenance: { sourcePath: 'wire.h', targetPath: 'wire.ts' },
    });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'id',
          severity: 'high',
          reasonCodes: expect.arrayContaining(['UINT64_PRECISION_LOSS']),
          falsePositiveNotes: expect.arrayContaining([
            'bounded ABI heuristic does not evaluate serializers, custom codecs, endian conversion, or generated bindings',
          ]),
        }),
      ]),
    );
  });

  it('flags missing fields and nullability mismatches', () => {
    const report = diffAbi({
      sourceLanguage: 'rust',
      sourceStruct: `
        pub id: u64,
        name: Option<String>,
        enabled: bool,
      `,
      targetInterface: `
        id: bigint;
        name: string;
        extra?: string;
      `,
    });

    expect(report.findings.map((finding) => finding.reasonCodes[0])).toEqual(
      expect.arrayContaining([
        'NULLABILITY_MISMATCH',
        'FIELD_MISSING_IN_TARGET',
        'FIELD_MISSING_IN_SOURCE',
      ]),
    );
    expect(report.systemsEvidence.map((field) => field.name)).toEqual(
      expect.arrayContaining(['id', 'name', 'enabled', 'extra']),
    );
  });

  it('compares JSON payload snippets and applies response limits', () => {
    const report = diffAbi({
      sourceLanguage: 'json',
      targetLanguage: 'typescript',
      sourceStruct: JSON.stringify({ a: 1, b: null, c: true }),
      targetInterface: `
        a: string;
        b: string;
        c: boolean;
      `,
      maxFindings: 1,
    });

    expect(report.status).toBe('partial');
    expect(report.limits).toMatchObject({ truncated: true, maxFindings: 1, emitted: 1 });
    expect(report.warnings).toContain('source fields inferred from JSON values');
    expect(report.findings[0].reasonCodes).toEqual(expect.arrayContaining(['FIELD_TYPE_MISMATCH']));
  });
});
