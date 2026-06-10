import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildSchemaGuidedExtractionReport,
  type ExtractionBundleInput,
  type ExtractionCandidate,
  type ExtractionSchemaDocument,
  type ExtractionValidationIssue,
} from '../../src/core/extraction/schema-guided-extraction.js';

function extractionSchema(overrides: Partial<ExtractionSchemaDocument>): ExtractionSchemaDocument {
  return {
    id: 'test-schema',
    version: '1.0',
    rootClass: 'Root',
    classes: [
      {
        name: 'Root',
        slots: [{ name: 'name', range: 'string' }],
      },
      {
        name: 'Address',
        slots: [{ name: 'street', range: 'string', required: true }],
      },
      {
        name: 'Profile',
        slots: [
          { name: 'emails', range: 'Email', repeated: true },
        ],
      },
      {
        name: 'Email',
        slots: [{ name: 'value', range: 'string', required: true }],
      },
      {
        name: 'Person',
        slots: [
          { name: 'password', range: 'string', sensitive: true },
          { name: 'address', range: 'Address' },
          { name: 'profile', range: 'Profile' },
          { name: 'role', range: 'string', enum: ['admin', 'user', 'guest'] },
        ],
      },
      {
        name: 'Alpha',
        slots: [{ name: 'value', range: 'string', required: false }],
      },
      {
        name: 'Zeta',
        slots: [{ name: 'count', range: 'number', required: false }],
      },
    ],
    ...overrides,
  };
}

function buildReport(input: Partial<ExtractionBundleInput>): ReturnType<
  typeof buildSchemaGuidedExtractionReport
> {
  return buildSchemaGuidedExtractionReport({
    schema: extractionSchema({}),
    candidates: [],
    ...input,
  } as ExtractionBundleInput);
}

describe('schema-guided extraction report', () => {
  it('validates schema document shape and required fields', () => {
    const schema = extractionSchema({
      id: '',
      rootClass: 'Missing',
    } as ExtractionSchemaDocument);

    expect(() =>
      buildSchemaGuidedExtractionReport({
        schema: schema as ExtractionSchemaDocument,
        candidates: [],
      }),
    ).toThrow('schema.id must be a non-empty string');

    const classNameMissing = {
      id: 'x',
      version: '1',
      rootClass: 'Missing',
      classes: [{ name: 'Root', slots: [] }],
    };
    expect(() =>
      buildSchemaGuidedExtractionReport({
        schema: classNameMissing as ExtractionSchemaDocument,
        candidates: [],
      }),
    ).toThrow('schema root class Missing must exist in classes');

    const unknownRange = extractionSchema({
      classes: [
        {
          name: 'Root',
          slots: [{ name: 'bad', range: 'UnknownClass' }],
        },
      ],
      rootClass: 'Root',
    } as ExtractionSchemaDocument);
    expect(() =>
      buildSchemaGuidedExtractionReport({
        schema: unknownRange,
        candidates: [],
      }),
    ).toThrow('schema slot Root.bad has unknown range: UnknownClass');
  });

  it('trims candidate ids and class names and defaults missing flags to false', () => {
    const report = buildReport({
      schema: extractionSchema({
        classes: [
          {
            name: 'Root',
            slots: [{ name: 'title', range: 'string' }],
          },
          ...extractionSchema({}).classes.filter((slotClass) => slotClass.name !== 'Root'),
        ],
      }),
      candidates: [
        {
          id: '  lead-1  ',
          className: '  Root ',
          fields: {
            title: 'hello',
            repeatedNotSet: 'single-value',
          },
          sourceSpan: { start: 1 },
          metadata: { source: 'unit' },
        } as ExtractionCandidate,
      ],
    });

    expect(report.normalizedCandidates).toHaveLength(1);
    expect(report.normalizedCandidates[0]!.id).toBe('lead-1');
    expect(report.normalizedCandidates[0]!.className).toBe('Root');
    expect(report.normalizedCandidates[0]!.sourceSpan).toEqual({ start: 1 });
    expect(report.normalizedCandidates[0]!.metadata).toEqual({ source: 'unit' });
    expect(report.counts.errors).toBe(0);
  });

  it('validates nested object fields recursively', () => {
    const report = buildReport({
      schema: extractionSchema({
        classes: [
          {
            name: 'Root',
            slots: [{ name: 'address', range: 'Address', required: true }],
          },
          { name: 'Address', slots: [{ name: 'street', range: 'string', required: true }] },
        ],
      }),
      candidates: [
        {
          id: 'a-1',
          className: 'Root',
          fields: { address: { street: 'Main' } },
        },
        {
          id: 'a-2',
          className: 'Root',
          fields: { address: { name: 'bad' } },
        },
      ],
    });

    const nestedIssue = report.issues.find((issue: ExtractionValidationIssue) =>
      issue.code === 'field-required',
    );
    expect(nestedIssue?.path).toContain('address.street');
    expect(report.counts.errors).toBeGreaterThan(0);
  });

  it('validates repeated slots as arrays and validates each element', () => {
    const schema = extractionSchema({
      classes: [
        {
          name: 'Root',
          slots: [{ name: 'tags', range: 'string', required: false, repeated: true }],
        },
      ],
    });
    const report = buildReport({
      schema,
      candidates: [
        { id: 'r-1', className: 'Root', fields: { tags: 'not-an-array' } },
        { id: 'r-2', className: 'Root', fields: { tags: ['ok', 42] } },
      ],
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'field-repeated-non-array',
          candidateId: 'r-1',
          path: 'candidate[r-1].tags',
        }),
        expect.objectContaining({
          code: 'field-type-mismatch',
          candidateId: 'r-2',
          path: 'candidate[r-2].tags[1]',
        }),
      ]),
    );
  });

  it('reports required missing fields as errors', () => {
    const schema = extractionSchema({
      classes: [{ name: 'Root', slots: [{ name: 'name', range: 'string', required: true }] }],
    });
    const report = buildReport({
      schema,
      candidates: [{ id: 'm-1', className: 'Root', fields: {} }],
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'field-required',
          candidateId: 'm-1',
          path: 'candidate[m-1].name',
          severity: 'error',
        }),
      ]),
    );
    expect(report.counts.errors).toBe(1);
  });

  it('validates enum values for scalar slots', () => {
    const schema = extractionSchema({
      classes: [{ name: 'Root', slots: [{ name: 'level', range: 'string', enum: ['low', 'high'] }] }],
    });
    const report = buildReport({
      schema,
      candidates: [{ id: 'e-1', className: 'Root', fields: { level: 'medium' } }],
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'field-enum-mismatch',
          candidateId: 'e-1',
          path: 'candidate[e-1].level',
          severity: 'error',
        }),
      ]),
    );
  });

  it('warns on unknown candidate fields', () => {
    const schema = extractionSchema({
      classes: [{ name: 'Root', slots: [{ name: 'name', range: 'string' }] },
      { name: 'Address', slots: [{ name: 'street', range:'string' }] }],
      rootClass:'Root',
    });
    const report = buildReport({
      schema,
      candidates: [
        { id: 'u-1', className: 'Root', fields: { name: 'alice', stray: 'value', extra: 5 } },
      ],
    });

    const warningPaths = report.issues
      .filter((issue: ExtractionValidationIssue) => issue.code === 'field-unknown')
      .map((issue) => issue.path)
      .sort();
    expect(warningPaths).toEqual([
      'candidate[u-1].extra',
      'candidate[u-1].stray',
    ]);
  });

  it('sorts normalized candidates deterministically by class and id', () => {
    const schema = extractionSchema({
      rootClass: 'Alpha',
      classes: [
        { name: 'Alpha', slots: [{ name: 'value', range: 'string' }] },
        { name: 'Zeta', slots: [{ name: 'count', range: 'number' }] },
      ],
    });
    const report = buildReport({
      schema,
      candidates: [
        { id: 'b', className: 'Zeta', fields: { count: 1 } },
        { id: 'b', className: 'Alpha', fields: { value: 'two' } },
        { id: 'a', className: 'Alpha', fields: { value: 'one' } },
      ],
    });

    expect(report.normalizedCandidates.map((candidate) => `${candidate.className}:${candidate.id}`)).toEqual([
      'Alpha:a',
      'Alpha:b',
      'Zeta:b',
    ]);
  });

  it('limits emitted issues from full issue set and reports omission count', () => {
    const schema = extractionSchema({
      classes: [{ name: 'Root', slots: [{ name: 'name', range: 'string', required: true }] }],
    });
    const report = buildReport({
      schema,
      maxIssues: 1,
      candidates: [
        { id: 'i-1', className: 'Root', fields: {} },
        { id: 'i-2', className: 'Root', fields: {} },
      ],
    });

    expect(report.issues).toHaveLength(1);
    expect(report.counts.errors).toBe(2);
    expect(report.truncation.issuesOmitted).toBe(1);
  });

  it('limits emitted candidates and reports candidate omission count', () => {
    const schema = extractionSchema({
      classes: [{ name: 'Root', slots: [{ name: 'name', range: 'string' }] }],
    });
    const report = buildReport({
      schema,
      maxCandidates: 1,
      candidates: [
        { id: 'c-2', className: 'Root', fields: { name: 'two' } },
        { id: 'c-1', className: 'Root', fields: { name: 'one' } },
        { id: 'c-3', className: 'Root', fields: { name: 'three' } },
      ],
    });

    expect(report.normalizedCandidates).toHaveLength(1);
    expect(report.normalizedCandidates[0]?.id).toBe('c-1');
    expect(report.counts.candidatesInInput).toBe(3);
    expect(report.counts.normalizedCandidatesInInput).toBe(3);
    expect(report.truncation.candidatesOmitted).toBe(2);
  });

  it('reports unknown candidate classes as validation issues without throwing', () => {
    const schema = extractionSchema({
      rootClass: 'Known',
      classes: [{ name: 'Known', slots: [{ name: 'value', range: 'string' }] }],
    });
    const report = buildReport({
      schema,
      candidates: [
        {
          id: 'unknown-1',
          className: 'MissingClass',
          fields: { value: 'x' },
        },
      ],
    });

    expect(report.normalizedCandidates).toHaveLength(0);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'candidate-class-unknown',
          candidateId: 'unknown-1',
          path: '',
        }),
      ]),
    );
    expect(report.counts.errors).toBe(1);
    expect(report.counts.candidatesInInput).toBe(1);
  });

  it('builds deterministic redaction manifest paths without redacting values', () => {
    const schema = {
      id: 'redact-schema',
      version: '1',
      rootClass: 'Person',
      classes: [
        {
          name: 'Person',
          slots: [
            { name: 'password', range: 'string', sensitive: true },
            {
              name: 'profile',
              range: 'Profile',
            },
          ],
        },
        {
          name: 'Profile',
          slots: [
            { name: 'ssn', range: 'string', sensitive: true },
            { name: 'emails', range: 'Email', repeated: true },
          ],
        },
        {
          name: 'Email',
          slots: [
            { name: 'value', range: 'string' },
            { name: 'token', range: 'string', sensitive: true },
          ],
        },
      ],
    } satisfies ExtractionSchemaDocument;

    const report = buildSchemaGuidedExtractionReport({
      schema,
      candidates: [
        {
          id: 'person-1',
          className: 'Person',
          fields: {
            password: 'hunter2',
            profile: {
              ssn: '123-45-6789',
              emails: [
                { value: 'a@x.com', token: 'token-a' },
                { value: 'b@x.com', token: 'token-b' },
              ],
            },
          },
          metadata: { source: 'unit' },
        },
      ],
    });

    expect(report.normalizedCandidates).toHaveLength(1);
    expect(report.normalizedCandidates[0]!.fields.password).toBe('hunter2');
    expect(report.normalizedCandidates[0]!.fields.profile).toEqual({
      ssn: '123-45-6789',
      emails: [
        { value: 'a@x.com', token: 'token-a' },
        { value: 'b@x.com', token: 'token-b' },
      ],
    });
    expect(report.redactionManifest.sensitivePaths).toEqual([
      'candidate[person-1].password',
      'candidate[person-1].profile.emails[0].token',
      'candidate[person-1].profile.emails[1].token',
      'candidate[person-1].profile.ssn',
    ]);
  });

  it('has no forbidden imports', () => {
    const source = readFileSync(
      new URL('../../src/core/extraction/schema-guided-extraction.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('/src/mcp/');
    expect(source).not.toContain("from '../../mcp/");
    expect(source).not.toContain('from \"../../mcp/');
    expect(source).not.toContain('node:fs');
    expect(source).not.toContain('LinkML');
    expect(source).not.toContain('SPIRES');
  });
});
