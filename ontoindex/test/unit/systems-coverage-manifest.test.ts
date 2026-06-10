import { describe, expect, it } from 'vitest';

import {
  buildSystemsAuditCoverageManifest,
  createSystemsAuditRecord,
  type SystemsAuditCoverageAnalyzerDeclaration,
  type SystemsAuditCurrentSnapshot,
} from '../../src/core/systems-audit/index.js';

const SNAPSHOT: SystemsAuditCurrentSnapshot = {
  sourceIndexId: 'index-current',
  sourceCommitHash: 'commit-current',
  graphSchemaVersion: 7,
};

const DECLARATIONS: readonly SystemsAuditCoverageAnalyzerDeclaration[] = [
  { analyzerId: 'gn_audit_logic', requiredGates: ['capability'], completedGates: ['capability'] },
  { analyzerId: 'gn_trace_boundary' },
  { analyzerId: 'gn_abi_diff' },
  { analyzerId: 'gn_blocked', requiredGates: ['ready'], completedGates: [] },
  { analyzerId: 'gn_unavailable', available: false },
];

const COVERED_RECORD = createSystemsAuditRecord({
  sourceIndexId: SNAPSHOT.sourceIndexId,
  sourceCommitHash: SNAPSHOT.sourceCommitHash,
  analyzerId: 'gn_audit_logic',
  analyzerVersion: '1.0.0',
  filePath: 'src/audit.ts',
  fileHash: 'file-a',
  graphSchemaVersion: SNAPSHOT.graphSchemaVersion,
  status: 'complete',
  findings: [
    {
      id: 'finding-1',
      category: 'resource',
      severity: 'low',
      confidence: 1,
      message: 'resource handle remains open',
      evidence: [],
      status: 'open',
    },
  ],
  records: [
    {
      kind: 'systems-audit-resource-instance',
      resourceInstanceId: 'res-1',
      resourceKind: 'file',
      processIdentity: 'pid-1',
      filePath: 'src/audit.ts',
      lineSpan: { startLine: 1, endLine: 1 },
      mechanism: 'open',
      unresolved: [],
      confidence: 1,
      evidence: [],
    },
  ],
});

const FAILED_RECORD = createSystemsAuditRecord({
  sourceIndexId: SNAPSHOT.sourceIndexId,
  sourceCommitHash: SNAPSHOT.sourceCommitHash,
  analyzerId: 'gn_trace_boundary',
  analyzerVersion: '1.0.0',
  filePath: 'src/boundary.ts',
  fileHash: 'file-b',
  graphSchemaVersion: SNAPSHOT.graphSchemaVersion,
  status: 'failed',
  findings: [],
  records: [],
});

const STALE_RECORD = createSystemsAuditRecord({
  sourceIndexId: SNAPSHOT.sourceIndexId,
  sourceCommitHash: 'old-commit',
  analyzerId: 'gn_abi_diff',
  analyzerVersion: '1.0.0',
  filePath: 'src/api.rs',
  fileHash: 'file-rs',
  graphSchemaVersion: SNAPSHOT.graphSchemaVersion,
  status: 'complete',
  findings: [],
  records: [],
});

const UNSUPPORTED_RECORD = createSystemsAuditRecord({
  sourceIndexId: SNAPSHOT.sourceIndexId,
  sourceCommitHash: SNAPSHOT.sourceCommitHash,
  analyzerId: 'gn_trace_boundary',
  analyzerVersion: '1.0.0',
  filePath: 'src/boundary.ts',
  fileHash: 'file-b',
  graphSchemaVersion: SNAPSHOT.graphSchemaVersion,
  status: 'unsupported',
  findings: [],
  records: [],
});

const UNRESOLVED_RECORD = createSystemsAuditRecord({
  sourceIndexId: SNAPSHOT.sourceIndexId,
  sourceCommitHash: SNAPSHOT.sourceCommitHash,
  analyzerId: 'gn_trace_boundary',
  analyzerVersion: '1.0.0',
  filePath: 'src/boundary.ts',
  fileHash: 'file-b',
  graphSchemaVersion: SNAPSHOT.graphSchemaVersion,
  status: 'unresolved',
  findings: [],
  records: [],
});

const SYMBOL_METADATA_RECORD = {
  ...createSystemsAuditRecord({
    sourceIndexId: SNAPSHOT.sourceIndexId,
    sourceCommitHash: SNAPSHOT.sourceCommitHash,
    analyzerId: 'gn_audit_logic',
    analyzerVersion: '1.0.0',
    filePath: 'src/symbol-metadata.ts',
    fileHash: 'file-symbol',
    graphSchemaVersion: SNAPSHOT.graphSchemaVersion,
    status: 'complete',
    findings: [
      {
        id: 'finding-symbol',
        category: 'resource',
        severity: 'low',
        confidence: 1,
        message: 'resource handle remains open',
        evidence: [],
        status: 'open',
      },
    ],
    records: [],
  }),
  symbolName: 'metadataSymbol',
};

const FREE_TEXT_RECORD = createSystemsAuditRecord({
  sourceIndexId: SNAPSHOT.sourceIndexId,
  sourceCommitHash: SNAPSHOT.sourceCommitHash,
  analyzerId: 'gn_audit_logic',
  analyzerVersion: '1.0.0',
  filePath: 'src/do_work.ts',
  fileHash: 'file-do-work',
  graphSchemaVersion: SNAPSHOT.graphSchemaVersion,
  status: 'complete',
  findings: [
    {
      id: 'finding-free-text',
      category: 'resource',
      severity: 'low',
      confidence: 1,
      message: 'function do_work is tracked for this resource',
      evidence: [],
      status: 'open',
    },
  ],
  records: [],
});

describe('systems-audit coverage manifest', () => {
  it('does not mutate caller-provided analyzer declarations', () => {
    const analyzerDeclarations: SystemsAuditCoverageAnalyzerDeclaration[] = [
      { analyzerId: 'gn_audit_logic', requiredGates: ['capability'], completedGates: ['capability'] },
      { analyzerId: 'gn_trace_boundary' },
    ];
    const declarationCopy = structuredClone(analyzerDeclarations);

    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations,
      scopes: [
        {
          id: 'scope-mutation',
          analyzerId: 'gn_trace_boundary',
          filePath: 'src/boundary.ts',
          required: true,
        },
      ],
      records: [FAILED_RECORD],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-mutation',
      analyzerId: 'gn_trace_boundary',
      status: 'partial',
      required: true,
    });
    expect(analyzerDeclarations).toEqual(declarationCopy);
  });

  it('reports covered scope status from matching fresh complete records', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-covered',
          analyzerId: 'gn_audit_logic',
          filePath: 'src/audit.ts',
          category: 'resource',
          resourceKind: 'file',
          required: true,
        },
      ],
      records: [COVERED_RECORD],
    });

    expect(manifest.scopes).toHaveLength(1);
    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-covered',
      analyzerId: 'gn_audit_logic',
      status: 'covered',
      required: true,
    });
    expect(manifest.gaps).toHaveLength(0);
    expect(manifest.summary.requiredCoverageComplete).toBe(true);
    expect(manifest.summary.coveredScopeCount).toBe(1);
  });

  it('reports missing required scope and gap for no matching record', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-missing',
          analyzerId: 'gn_audit_logic',
          filePath: 'src/missing.ts',
          required: true,
        },
      ],
      records: [COVERED_RECORD],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-missing',
      status: 'missing',
      required: true,
    });
    expect(manifest.gaps[0]).toMatchObject({
      scopeId: 'scope-missing',
      analyzerId: 'gn_audit_logic',
      kind: 'missing-required-scope',
    });
    expect(manifest.summary.requiredCoverageComplete).toBe(false);
    expect(manifest.summary.missingScopeCount).toBe(1);
  });

  it('reports stale when only stale matching records are present', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-stale',
          analyzerId: 'gn_abi_diff',
          filePath: 'src/api.rs',
          required: true,
        },
      ],
      records: [STALE_RECORD],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-stale',
      analyzerId: 'gn_abi_diff',
      status: 'stale',
      required: true,
    });
    expect(manifest.gaps[0]).toMatchObject({
      scopeId: 'scope-stale',
      analyzerId: 'gn_abi_diff',
      kind: 'stale-record',
    });
    expect(manifest.summary.requiredCoverageComplete).toBe(false);
  });

  it('reports partial for failed matching records', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-partial',
          analyzerId: 'gn_trace_boundary',
          filePath: 'src/boundary.ts',
          required: true,
        },
      ],
      records: [FAILED_RECORD],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-partial',
      analyzerId: 'gn_trace_boundary',
      status: 'partial',
      required: true,
    });
    expect(manifest.gaps[0]).toMatchObject({
      scopeId: 'scope-partial',
      analyzerId: 'gn_trace_boundary',
      kind: 'partial-record',
    });
    expect(manifest.summary.requiredCoverageComplete).toBe(false);
  });

  it('maps unresolved record status to partial-record coverage gap', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-unresolved',
          analyzerId: 'gn_trace_boundary',
          filePath: 'src/boundary.ts',
          required: true,
        },
      ],
      records: [UNRESOLVED_RECORD],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-unresolved',
      analyzerId: 'gn_trace_boundary',
      status: 'partial',
      required: true,
    });
    expect(manifest.gaps[0]).toMatchObject({
      scopeId: 'scope-unresolved',
      analyzerId: 'gn_trace_boundary',
      kind: 'partial-record',
    });
    expect(manifest.summary.requiredCoverageComplete).toBe(false);
  });

  it('maps unsupported record status to unsupported-analyzer gap', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-unsupported-record',
          analyzerId: 'gn_trace_boundary',
          filePath: 'src/boundary.ts',
          required: true,
        },
      ],
      records: [UNSUPPORTED_RECORD],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-unsupported-record',
      analyzerId: 'gn_trace_boundary',
      status: 'unsupported',
      required: true,
    });
    expect(manifest.gaps[0]).toMatchObject({
      scopeId: 'scope-unsupported-record',
      analyzerId: 'gn_trace_boundary',
      kind: 'unsupported-analyzer',
    });
    expect(manifest.summary.requiredCoverageComplete).toBe(false);
  });

  it('matches symbolName only from explicit payload metadata', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-symbol-meta',
          analyzerId: 'gn_audit_logic',
          filePath: 'src/symbol-metadata.ts',
          symbolName: 'metadataSymbol',
          required: true,
        },
      ],
      records: [SYMBOL_METADATA_RECORD],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-symbol-meta',
      analyzerId: 'gn_audit_logic',
      status: 'covered',
      required: true,
    });
    expect(manifest.gaps).toHaveLength(0);
  });

  it('does not match symbolName from file path or finding text alone', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-symbol-free-text',
          analyzerId: 'gn_audit_logic',
          filePath: 'src/do_work.ts',
          symbolName: 'do_work',
          required: true,
        },
      ],
      records: [FREE_TEXT_RECORD],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-symbol-free-text',
      analyzerId: 'gn_audit_logic',
      status: 'missing',
      required: true,
    });
    expect(manifest.summary.requiredCoverageComplete).toBe(false);
  });

  it('reports unsupported when analyzer is missing from declarations', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-unsupported',
          analyzerId: 'gn_unknown',
          filePath: 'src/unknown.ts',
          required: true,
        },
      ],
      records: [],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-unsupported',
      analyzerId: 'gn_unknown',
      status: 'unsupported',
      required: true,
    });
    expect(manifest.gaps[0]).toMatchObject({
      scopeId: 'scope-unsupported',
      analyzerId: 'gn_unknown',
      kind: 'unsupported-analyzer',
    });
    expect(manifest.summary.requiredCoverageComplete).toBe(false);
  });

  it('reports blocked when required analyzer gates are unmet', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-blocked',
          analyzerId: 'gn_blocked',
          required: true,
        },
      ],
      records: [],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-blocked',
      analyzerId: 'gn_blocked',
      status: 'blocked',
      required: true,
    });
    expect(manifest.gaps[0]).toMatchObject({
      scopeId: 'scope-blocked',
      analyzerId: 'gn_blocked',
      kind: 'blocked-analyzer-gate',
    });
    expect(manifest.summary.requiredCoverageComplete).toBe(false);
  });

  it('reports unsupported when analyzer declaration is unavailable', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-analyzer-unavailable',
          analyzerId: 'gn_unavailable',
          required: true,
        },
      ],
      records: [],
    });

    expect(manifest.scopes[0]).toMatchObject({
      scopeId: 'scope-analyzer-unavailable',
      analyzerId: 'gn_unavailable',
      status: 'unsupported',
      required: true,
    });
    expect(manifest.gaps[0]).toMatchObject({
      scopeId: 'scope-analyzer-unavailable',
      analyzerId: 'gn_unavailable',
      kind: 'unsupported-analyzer',
    });
  });

  it('reports optional missing scope but keeps required coverage complete', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        {
          id: 'scope-required-coverage',
          analyzerId: 'gn_audit_logic',
          filePath: 'src/audit.ts',
          required: true,
        },
        {
          id: 'scope-optional-missing',
          analyzerId: 'gn_audit_logic',
          filePath: 'src/optional.ts',
          required: false,
        },
      ],
      records: [COVERED_RECORD],
    });

    const optional = manifest.scopes.find((scope) => scope.scopeId === 'scope-optional-missing');
    expect(optional).toMatchObject({
      scopeId: 'scope-optional-missing',
      analyzerId: 'gn_audit_logic',
      status: 'missing',
      required: false,
    });
    expect(manifest.gaps.find((gap) => gap.scopeId === 'scope-optional-missing')).toBeUndefined();
    expect(manifest.summary.requiredCoverageComplete).toBe(true);
    expect(manifest.summary.requiredScopeCount).toBe(1);
    expect(manifest.summary.optionalScopeCount).toBe(1);
    expect(manifest.summary.missingScopeCount).toBe(1);
  });

  it('orders scope results deterministically by scope id and analyzer id', () => {
    const manifest = buildSystemsAuditCoverageManifest({
      snapshot: SNAPSHOT,
      analyzerDeclarations: DECLARATIONS,
      scopes: [
        { id: 'beta', analyzerId: 'gn_trace_boundary', filePath: 'src/boundary.ts', required: true },
        { id: 'alpha', analyzerId: 'gn_audit_logic', filePath: 'src/audit.ts', required: true },
        { id: 'alpha', analyzerId: 'gn_abi_diff', filePath: 'src/api.rs', required: true },
      ],
      records: [COVERED_RECORD, FAILED_RECORD, STALE_RECORD],
    });

    expect(manifest.scopes.map((item) => `${item.scopeId}:${item.analyzerId}`)).toEqual([
      'alpha:gn_abi_diff',
      'alpha:gn_audit_logic',
      'beta:gn_trace_boundary',
    ]);
  });
});
