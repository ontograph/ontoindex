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
    expect(report.status).toBe('ok');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].reasonCodes).toEqual(['UINT64_PRECISION_LOSS']);
    expect(
      report.systemsEvidence
        .filter((field) => field.name === 'name')
        .map((field) => field.normalizedType),
    ).toEqual(['string', 'string']);
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

  it.each(['const char* name;', 'char *name;', 'char*name;', 'char const * name;'])(
    'recognizes compact qualified pointer fields: %s',
    (declaration) => {
      const report = diffAbi({
        sourceLanguage: 'cpp',
        sourceStruct: `struct Wire { unsigned long long id; ${declaration} bool enabled; };`,
        targetInterface: 'interface Wire { id: number; name: string; enabled: boolean; }',
      });
      expect(report.status).toBe('ok');
      expect(report.systemsEvidence.map((field) => field.name)).toEqual([
        'id',
        'name',
        'enabled',
        'id',
        'name',
        'enabled',
      ]);
      expect(report.findings.map((finding) => finding.reasonCodes)).toEqual([
        ['UINT64_PRECISION_LOSS'],
      ]);
    },
  );

  it('recognizes compact Rust fields and Option nullability', () => {
    const report = diffAbi({
      sourceLanguage: 'rust',
      sourceStruct: 'pub struct Wire { pub id: u64, name: Option<String>, enabled: bool }',
      targetInterface: 'export type Wire = { id: bigint; name?: string; enabled: boolean };',
    });
    expect(report.status).toBe('ok');
    expect(report.findings).toEqual([]);
    expect(
      report.systemsEvidence
        .filter((field) => field.name === 'name')
        .map((field) => field.nullable),
    ).toEqual([true, true]);
  });

  it.each(['u128', 'i128'])(
    'flags %s to JavaScript number as a high-severity precision loss',
    (sourceType) => {
      const numberReport = diffAbi({
        sourceLanguage: 'rust',
        sourceStruct: `pub struct Wire { pub id: ${sourceType} }`,
        targetInterface: 'interface Wire { id: number; }',
      });
      expect(numberReport.findings).toEqual([
        expect.objectContaining({
          field: 'id',
          severity: 'high',
          message: expect.stringContaining("exceeds JavaScript number's exact integer range"),
          reasonCodes: ['BIGINT_NUMBER_MISMATCH'],
        }),
      ]);

      const bigintReport = diffAbi({
        sourceLanguage: 'rust',
        sourceStruct: `pub struct Wire { pub id: ${sourceType} }`,
        targetInterface: 'interface Wire { id: bigint; }',
      });
      expect(bigintReport.findings).toEqual([]);
      expect(
        bigintReport.systemsEvidence.find((field) => field.origin === 'source')?.normalizedType,
      ).toBe('bigint');
    },
  );

  it('preserves one-based source lines across comments and multiline fields', () => {
    const report = diffAbi({
      sourceStruct:
        '// header\nstruct Wire {\n/* documentation\ncontinues */ const char* name;\nuint64_t\n id;\n};',
      targetInterface:
        '// header\ninterface Wire {\n/* documentation */ name: string;\nid: number;\n}',
    });
    expect(report.status).toBe('ok');
    expect(
      report.systemsEvidence.map(({ name, line, origin }) => ({ name, line, origin })),
    ).toEqual([
      { name: 'name', line: 4, origin: 'source' },
      { name: 'id', line: 5, origin: 'source' },
      { name: 'name', line: 3, origin: 'target' },
      { name: 'id', line: 4, origin: 'target' },
    ]);
  });

  it('stops at nested target declarations and compares recognized common fields', () => {
    const report = diffAbi({
      sourceStruct: 'struct Wire { uint64_t id; bool hidden; };',
      targetInterface: 'interface Wire { id: number; extra: string; nested: { hidden: boolean }; }',
    });
    expect(report.status).toBe('partial');
    expect(report.limits.truncated).toBe(false);
    expect(report.findings.map((finding) => [finding.field, finding.reasonCodes])).toEqual([
      ['id', ['UINT64_PRECISION_LOSS']],
      ['extra', ['FIELD_MISSING_IN_SOURCE']],
    ]);
    expect(
      report.systemsEvidence
        .filter((field) => field.origin === 'target')
        .map((field) => field.name),
    ).toEqual(['id', 'extra']);
    expect(report.warnings).toEqual([expect.stringMatching(/target parsing incomplete/)]);
  });

  it('suppresses missing-source findings only when the source is incomplete', () => {
    const report = diffAbi({
      sourceStruct: 'struct Wire { int count; bool extra; struct Nested { bool hidden; }; };',
      targetInterface: 'interface Wire { count: string; hidden: boolean; }',
    });
    expect(report.status).toBe('partial');
    expect(report.findings.map((finding) => [finding.field, finding.reasonCodes])).toEqual([
      ['count', ['FIELD_TYPE_MISMATCH']],
      ['extra', ['FIELD_MISSING_IN_TARGET']],
    ]);
    expect(
      report.systemsEvidence
        .filter((field) => field.origin === 'source')
        .map((field) => field.name),
    ).toEqual(['count', 'extra']);
  });

  it.each([
    '',
    'struct Wire { int value;',
    'struct Wire { Unknown value; };',
    'struct Wire { char** name; };',
    'struct Wire { int value; int value; };',
  ])('reports incomplete source without unproven absence: %s', (sourceStruct) => {
    const report = diffAbi({
      sourceStruct,
      sourceLanguage: 'cpp',
      targetInterface: 'value: number; name: string;',
    });
    expect(report.status).toBe('partial');
    expect(report.limits.truncated).toBe(false);
    expect(
      report.findings.some((finding) => finding.reasonCodes.includes('FIELD_MISSING_IN_SOURCE')),
    ).toBe(false);
    expect(report.warnings).toEqual([expect.stringMatching(/source parsing incomplete/)]);
  });

  it.each([
    '',
    'interface Wire { value: number;',
    'interface Wire { value(): number; }',
    'interface Wire { value: Unknown; }',
  ])('reports incomplete target without unproven absence: %s', (targetInterface) => {
    const report = diffAbi({ sourceStruct: 'int value; bool hidden;', targetInterface });
    expect(report.status).toBe('partial');
    expect(
      report.findings.some((finding) => finding.reasonCodes.includes('FIELD_MISSING_IN_TARGET')),
    ).toBe(false);
    expect(report.warnings).toEqual([expect.stringMatching(/target parsing incomplete/)]);
  });

  it('preserves genuine missing findings against complete empty declarations', () => {
    const report = diffAbi({ sourceStruct: 'int value;', targetInterface: 'interface Empty {}' });
    expect(report.status).toBe('partial');
    expect(report.skipReasons).toEqual(['source or target snippet yielded no comparable fields']);
    expect(report.findings.map((finding) => finding.reasonCodes)).toEqual([
      ['FIELD_MISSING_IN_TARGET'],
    ]);
    expect(report.warnings).toEqual([]);
  });

  it('honors explicit languages instead of inferring another syntax', () => {
    const report = diffAbi({
      sourceLanguage: 'cpp',
      sourceStruct: '{"value": 1}',
      targetLanguage: 'typescript',
      targetInterface: '{"value": 1}',
    });
    expect(report.status).toBe('partial');
    expect(report.systemsEvidence).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.warnings.some((warning) => warning.includes('inferred from JSON'))).toBe(false);
    expect(
      diffAbi({
        sourceLanguage: 'rust',
        sourceStruct: 'int value;',
        targetInterface: 'value: number;',
      }).systemsEvidence,
    ).toHaveLength(1);
  });

  it.each(['{"value":', '[]', 'null', '{"value": 1, "value": 2}'])(
    'marks invalid or ambiguous JSON source incomplete: %s',
    (sourceStruct) => {
      const report = diffAbi({
        sourceLanguage: 'json',
        sourceStruct,
        targetInterface: 'value: number;',
      });
      expect(report.status).toBe('partial');
      expect(report.findings).toEqual([]);
      expect(report.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/source parsing incomplete/)]),
      );
    },
  );

  it('preserves JSON strings and key lines without treating them as comments', () => {
    const report = diffAbi({
      sourceLanguage: 'json',
      sourceStruct: '{\n "name": "https://example.test/*literal*/",\n "nested": {"value": 1}\n}',
      targetInterface: 'name: string; nested: object;',
    });
    expect(report.status).toBe('ok');
    expect(report.findings).toEqual([]);
    expect(
      report.systemsEvidence
        .filter((field) => field.origin === 'source')
        .map(({ name, line }) => ({ name, line })),
    ).toEqual([
      { name: 'name', line: 2 },
      { name: 'nested', line: 3 },
    ]);
  });

  it('keeps empty-input skip reasons and partial status independent of finding limits', () => {
    const report = diffAbi({ sourceStruct: '', targetInterface: '', maxFindings: 1 });
    expect(report.status).toBe('partial');
    expect(report.skipReasons).toEqual(['source or target snippet yielded no comparable fields']);
    expect(report.limits).toEqual({ truncated: false, maxFindings: 1, emitted: 0, total: 0 });
  });
});
