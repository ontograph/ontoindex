import { describe, expect, it } from 'vitest';
import {
  validateVirtualSourceMapping,
  type VirtualSourceDefinition,
  type VirtualSourceValidationDiagnostic,
} from '../../src/core/search/virtual-source-mapping.js';

function diagnosticsByCode(reportDiagnostics: readonly VirtualSourceValidationDiagnostic[]): string[] {
  return reportDiagnostics.map((diagnostic) => diagnostic.code);
}

describe('virtual source mapping validation', () => {
  it('normalizes valid definitions and returns deterministic summaries', () => {
    const report = validateVirtualSourceMapping({
      sourceDefinitions: [
        { name: '  csv-source ', kind: ' csv ' },
        { name: 'sqlite-db', kind: 'sqlite' },
      ],
      virtualNodeProjections: [
        {
          sourceName: 'sqlite-db',
          graphLabel: '  User ',
          primaryKey: ' id ',
          fieldMappings: [
            { sourceField: 'uid', graphField: 'id' },
            { sourceField: 'name', graphField: 'name' },
          ],
        },
      ],
      virtualRelationshipProjections: [
        {
          sourceName: 'sqlite-db',
          sourceNode: 'User',
          targetNode: 'User',
          relationshipType: 'FOLLOWS',
          joinFields: [' user_id ', ' follows_id '],
        },
      ],
    });

    expect(report.mapping.sources).toEqual([
      { name: 'csv-source', kind: 'csv' },
      { name: 'sqlite-db', kind: 'sqlite' },
    ]);
    expect(report.mapping.nodes).toEqual([
      {
        projectionKind: 'node',
        sourceName: 'sqlite-db',
        graphLabel: 'User',
        primaryKey: 'id',
        projectionId: 'sqlite-db||node||User||id',
        fieldMappings: [
          { sourceField: 'uid', graphField: 'id' },
          { sourceField: 'name', graphField: 'name' },
        ],
      },
    ]);
    expect(report.mapping.relationships).toEqual([
      {
        projectionKind: 'relationship',
        sourceName: 'sqlite-db',
        sourceNode: 'User',
        targetNode: 'User',
        relationshipType: 'FOLLOWS',
        joinFields: ['follows_id', 'user_id'],
        projectionId: 'sqlite-db||relationship||FOLLOWS||follows_id,user_id',
      },
    ]);
    expect(report.summaries.bySourceKind).toEqual({ csv: 1, sqlite: 1 });
    expect(report.summaries.byNodeLabel).toEqual({ User: 1 });
    expect(report.summaries.byRelationshipType).toEqual({ FOLLOWS: 1 });
    expect(report.summaries.byDiagnosticSeverity).toEqual({
      error: 0,
      warning: 0,
      info: 0,
    });
    expect(report.diagnostics).toEqual([]);
  });

  it('reports duplicate node and relationship projections', () => {
    const report = validateVirtualSourceMapping({
      sourceDefinitions: [{ name: 'src', kind: 'duckdb' }],
      virtualNodeProjections: [
        {
          sourceName: 'src',
          graphLabel: 'Repo',
          primaryKey: 'id',
          fieldMappings: [{ sourceField: 'id', graphField: 'id' }],
        },
        {
          sourceName: 'src',
          graphLabel: 'Repo',
          primaryKey: 'id',
          fieldMappings: [{ sourceField: 'id', graphField: 'id' }],
        },
      ],
      virtualRelationshipProjections: [
        {
          sourceName: 'src',
          sourceNode: 'Repo',
          targetNode: 'Repo',
          relationshipType: 'USES',
          joinFields: ['id'],
        },
        {
          sourceName: 'src',
          sourceNode: 'Repo',
          targetNode: 'Repo',
          relationshipType: 'USES',
          joinFields: ['id'],
        },
      ],
    });

    expect(diagnosticsByCode(report.diagnostics)).toEqual(
      expect.arrayContaining(['duplicate-projection', 'duplicate-projection']),
    );
    expect(report.diagnostics.filter((diagnostic) => diagnostic.code === 'duplicate-projection')).toHaveLength(2);
  });

  it('reports dangling relationship endpoints', () => {
    const report = validateVirtualSourceMapping({
      sourceDefinitions: [{ name: 'src', kind: 'jsonl' }],
      virtualRelationshipProjections: [
        {
          sourceName: 'src',
          sourceNode: 'Repo',
          targetNode: 'Missing',
          relationshipType: 'OWNS',
          joinFields: ['id'],
        },
      ],
      virtualNodeProjections: [
        {
          sourceName: 'src',
          graphLabel: 'Repo',
          primaryKey: 'id',
          fieldMappings: [{ sourceField: 'id', graphField: 'id' }],
        },
      ],
    });

    const dangling = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'dangling-relationship-endpoint',
    );
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.message).toContain('dangling targetNode Missing');
  });

  it('reports unsupported source kinds and missing source/primary key', () => {
    const report = validateVirtualSourceMapping({
      sourceDefinitions: [{ name: 'src', kind: 'postgres' }],
      virtualNodeProjections: [
        {
          sourceName: 'missing-source',
          graphLabel: 'Repo',
          primaryKey: '',
          fieldMappings: [{ sourceField: 'id', graphField: 'id' }],
        },
      ],
    });

    expect(report.summaries.bySourceKind).toEqual({ postgres: 1 });
    expect(diagnosticsByCode(report.diagnostics)).toEqual(
      expect.arrayContaining(['unsupported-source-kind', 'missing-source-reference', 'missing-primary-key']),
    );
  });

  it('reports invalid labels', () => {
    const report = validateVirtualSourceMapping({
      sourceDefinitions: [{ name: 'src', kind: 'csv' }],
      virtualNodeProjections: [
        {
          sourceName: 'src',
          graphLabel: 'bad label',
          primaryKey: 'id',
          fieldMappings: [{ sourceField: 'id', graphField: 'id' }],
        },
      ],
      virtualRelationshipProjections: [
        {
          sourceName: 'src',
          sourceNode: 'Repo',
          targetNode: 'Repo',
          relationshipType: 'bad rel',
          joinFields: ['id'],
        },
      ],
    });

    expect(report.mapping.nodes[0]!.graphLabel).toBe('bad label');
    expect(diagnosticsByCode(report.diagnostics)).toEqual(
      expect.arrayContaining(['invalid-label', 'invalid-label']),
    );
  });

  it('returns deterministic ordering independent of input order', () => {
    const baseInput = {
      sourceDefinitions: [
        { name: 'zeta', kind: 'custom' },
        { name: 'alpha', kind: 'sqlite' },
      ],
      virtualNodeProjections: [
        {
          sourceName: 'zeta',
          graphLabel: 'ZNode',
          primaryKey: 'id',
          fieldMappings: [{ sourceField: 'z', graphField: 'z' }],
        },
      ],
      virtualRelationshipProjections: [
        {
          sourceName: 'zeta',
          sourceNode: 'ZNode',
          targetNode: 'Missing',
          relationshipType: 'LINKS',
          joinFields: ['id'],
        },
      ],
    };

    const report1 = validateVirtualSourceMapping(baseInput);
    const report2 = validateVirtualSourceMapping({
      sourceDefinitions: [...baseInput.sourceDefinitions].reverse(),
      virtualNodeProjections: [...baseInput.virtualNodeProjections].reverse(),
      virtualRelationshipProjections: [...baseInput.virtualRelationshipProjections].reverse(),
    });

    expect(report1.mapping.sources).toEqual(report2.mapping.sources);
    expect(report1.mapping.nodes).toEqual(report2.mapping.nodes);
    expect(report1.mapping.relationships).toEqual(report2.mapping.relationships);
    expect(report1.summaries).toEqual(report2.summaries);
    expect(report1.diagnostics).toEqual(report2.diagnostics);
  });

  it('does not mutate caller arrays', () => {
    const input = {
      sourceDefinitions: [
        { name: 'src', kind: 'duckdb' },
      ] satisfies VirtualSourceDefinition[],
      virtualNodeProjections: [
        {
          sourceName: 'src',
          graphLabel: 'Repo',
          primaryKey: 'id',
          fieldMappings: [{ sourceField: 'id', graphField: 'id' }],
        },
      ],
      virtualRelationshipProjections: [
        {
          sourceName: 'src',
          sourceNode: 'Repo',
          targetNode: 'Repo',
          relationshipType: 'OWN',
          joinFields: ['id'],
        },
      ],
    };
    const cloned = structuredClone(input);

    validateVirtualSourceMapping(input);

    expect(input).toEqual(cloned);
  });
});
