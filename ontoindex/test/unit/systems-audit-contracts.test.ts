import { describe, expect, it } from 'vitest';

import {
  assertFreshSystemsAuditRecord,
  createSystemsAuditRecord,
  createSystemsAuditResponseEnvelope,
  decideSystemsAuditRecordFreshness,
  selectFreshSystemsAuditRecords,
  upsertSystemsAuditRecord,
  type ResourceHandle,
} from '../../src/core/systems-audit/index.js';
import {
  collectCapabilityDiagnostics,
  createEnvelopeFromLegacy,
} from '../../src/mcp/shared/response-envelope.js';
import type { TargetContext } from '../../src/mcp/shared/target-context.js';

const snapshot = {
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  graphSchemaVersion: 7,
};

describe('systems-audit contracts', () => {
  it('models fd numbers as process-local handles instead of resource identities', () => {
    const handle: ResourceHandle = {
      kind: 'systems-audit-resource-handle',
      handleId: 'process:a:handle:3',
      resourceInstanceId: 'resource:file:1',
      processIdentity: 'process:a',
      handleKind: 'fd',
      localName: '3',
      fdNumber: 3,
      ownership: 'owned',
      closeOnExec: 'unknown',
      filePath: 'main.c',
      lineSpan: { startLine: 1, endLine: 1 },
      unresolved: [],
      confidence: 0.9,
      evidence: [],
    };

    expect(handle.fdNumber).toBe(3);
    expect(handle.handleId).toContain('process:a');
    expect(handle.resourceInstanceId).not.toBe('3');
  });

  it('keeps wrapper-hidden ownership explicit as unresolved evidence', () => {
    const record = createSystemsAuditRecord({
      sourceIndexId: 'index-1',
      sourceCommitHash: 'commit-1',
      analyzerId: 'cpp-posix-resource-extractor',
      analyzerVersion: '0.1.0',
      filePath: 'main.cc',
      fileHash: 'hash-1',
      graphSchemaVersion: 7,
      status: 'partial',
      records: [
        {
          kind: 'systems-audit-resource-event',
          eventId: 'e1',
          eventKind: 'unresolved',
          mechanism: 'wrapper-hidden-ownership',
          processIdentity: 'process:a',
          handleIds: ['process:a:handle:fd'],
          filePath: 'main.cc',
          lineSpan: { startLine: 10, endLine: 10 },
          status: 'unresolved',
          unresolved: ['wrapper-hidden ownership unresolved'],
          confidence: 0.4,
          evidence: [],
        },
      ],
      skipReasons: ['wrapper-hidden ownership at main.cc:10'],
    });

    expect(record.records[0]).toMatchObject({
      eventKind: 'unresolved',
      unresolved: ['wrapper-hidden ownership unresolved'],
    });
    expect(record.skipReasons).toContain('wrapper-hidden ownership at main.cc:10');
  });

  it('rejects stale index ids, stale commit hashes, and schema mismatches', () => {
    const fresh = createSystemsAuditRecord({
      sourceIndexId: 'index-1',
      sourceCommitHash: 'commit-1',
      analyzerId: 'cpp-posix-resource-extractor',
      analyzerVersion: '0.1.0',
      filePath: 'main.cc',
      fileHash: 'hash-1',
      graphSchemaVersion: 7,
      status: 'complete',
    });

    expect(decideSystemsAuditRecordFreshness(fresh, snapshot)).toEqual({
      usable: true,
      reason: 'fresh',
    });
    expect(() =>
      assertFreshSystemsAuditRecord({ ...fresh, sourceIndexId: 'old-index' }, snapshot),
    ).toThrow('index-mismatch');
    expect(() =>
      assertFreshSystemsAuditRecord({ ...fresh, sourceCommitHash: 'old-commit' }, snapshot),
    ).toThrow('commit-mismatch');
    expect(() =>
      assertFreshSystemsAuditRecord({ ...fresh, graphSchemaVersion: 6 }, snapshot),
    ).toThrow('schema-mismatch');
  });

  it('upserts and filters only fresh systems-audit records', () => {
    const state = { records: [] };
    const fresh = upsertSystemsAuditRecord(state, {
      sourceIndexId: 'index-1',
      sourceCommitHash: 'commit-1',
      analyzerId: 'cpp-posix-resource-extractor',
      analyzerVersion: '0.1.0',
      filePath: 'main.cc',
      fileHash: 'hash-1',
      graphSchemaVersion: 7,
      status: 'complete',
    });
    const stale = createSystemsAuditRecord({ ...fresh, sourceCommitHash: 'old-commit' });

    expect(selectFreshSystemsAuditRecords([fresh, stale], snapshot)).toEqual([fresh]);
  });

  it('creates the systems-audit response envelope shape required by ADR 0016', () => {
    const response = createSystemsAuditResponseEnvelope({
      tool: 'gn_audit_logic',
      status: 'complete',
      freshness: {
        graphState: 'clean',
        sourceIndexId: 'index-1',
        sourceCommitHash: 'commit-1',
        checkedAt: '2026-05-17T00:00:00.000Z',
      },
      facts: [],
      findings: [],
      systemsEvidence: [],
      primaryGraphFacts: [],
      limits: { maxRecords: 10, recordsReturned: 0, truncated: false },
      nextTools: ['gn_trace_boundary'],
    });

    expect(response).toMatchObject({
      version: 1,
      tool: 'gn_audit_logic',
      primaryGraphFacts: [],
      systemsEvidence: [],
      findings: [],
      skipReasons: [],
      warnings: [],
      nextTools: ['gn_trace_boundary'],
    });
  });

  it('creates the shared capability-aware envelope shape required by ADR 0018', () => {
    const targetContext: TargetContext = {
      version: 1,
      status: 'ok',
      repoKey: 'fixture',
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      branch: 'main',
      targetRef: 'HEAD',
      targetHead: 'commit-1',
      currentHead: 'commit-1',
      indexedHead: 'commit-1',
      dirtyWorktree: false,
      dirtyFileCount: 0,
      dirtyWorkspace: {
        state: 'clean',
        fileCount: 0,
        sourceFileCount: 0,
        stagedSourceFileCount: 0,
        unstagedSourceFileCount: 0,
        untrackedSourceFileCount: 0,
        unknownGraphCoverageCount: 0,
      },
      changedSinceIndex: false,
      snapshotMode: 'committed-head',
      qualityMode: 'balanced',
      scopeConfidence: 'high',
      embeddings: { status: 'available', count: 2 },
      lsp: { status: 'available', servers: { typescript: true, python: false, rust: false } },
      sidecar: { status: 'available', reason: 'ok' },
      policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
      warnings: [],
    };

    const response = createEnvelopeFromLegacy({
      legacy: {
        version: 1,
        findings: [],
        warnings: [],
      },
      tool: 'gn_audit_verify',
      status: 'ok',
      targetContext,
      capabilitiesUsed: ['tool-registry'],
      nextTools: ['gn_help'],
    });

    expect(response).toMatchObject({
      envelopeVersion: '1',
      tool: 'gn_audit_verify',
      version: 1,
      status: 'ok',
      targetContext: {
        status: 'ok',
        repoKey: 'fixture',
        repoLabel: 'fixture',
        repoPath: '/repo/fixture',
      },
      capabilitiesUsed: ['tool-registry'],
      capabilitiesMissing: [],
      warnings: [],
      limits: {
        truncated: false,
        cursor: null,
        persistedPath: null,
      },
      nextTools: ['gn_help'],
    });
    expect(response.freshness).toMatchObject({
      status: 'fresh',
      repoLabel: 'fixture',
      repoPath: '/repo/fixture',
      indexedCommit: 'commit-1',
      headCommit: 'commit-1',
      isStale: false,
      dirtyFileCount: 0,
      dirtyWorkspace: {
        state: 'clean',
        fileCount: 0,
        sourceFileCount: 0,
        stagedSourceFileCount: 0,
        unstagedSourceFileCount: 0,
        untrackedSourceFileCount: 0,
        unknownGraphCoverageCount: 0,
      },
      scopeConfidence: 'high',
    });
  });

  it('hides sidecar unavailable metadata unless quality or diagnostics require it', () => {
    const targetContext: TargetContext = {
      version: 1,
      status: 'ok',
      repoKey: 'fixture',
      repoPath: '/repo/fixture',
      branch: 'main',
      targetRef: 'HEAD',
      targetHead: 'abc',
      currentHead: 'abc',
      indexedHead: 'abc',
      dirtyWorktree: false,
      changedSinceIndex: false,
      snapshotMode: 'committed-head',
      qualityMode: 'balanced',
      embeddings: { status: 'available', count: 2 },
      lsp: { status: 'available', servers: { typescript: true, python: false, rust: false } },
      sidecar: { status: 'unavailable', reason: 'sidecar-store-empty' },
      policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
      warnings: [],
    };

    expect(
      collectCapabilityDiagnostics({
        targetContext,
        capabilitiesUsed: ['symbol-graph'],
      }).capabilitiesMissing,
    ).toEqual([]);
    expect(
      collectCapabilityDiagnostics({
        targetContext,
        capabilitiesUsed: ['symbol-graph'],
        diagnosticsRequested: true,
      }).capabilitiesMissing,
    ).toEqual(['sidecar']);
  });

  it('adds actionable embeddings remediation when semantic retrieval falls back', () => {
    const targetContext: TargetContext = {
      version: 1,
      status: 'ok',
      repoKey: 'fixture',
      repoPath: '/repo/fixture',
      branch: 'main',
      targetRef: 'HEAD',
      targetHead: 'abc',
      currentHead: 'abc',
      indexedHead: 'abc',
      dirtyWorktree: false,
      changedSinceIndex: false,
      snapshotMode: 'committed-head',
      qualityMode: 'balanced',
      embeddings: { status: 'unavailable', count: 0 },
      lsp: { status: 'available', servers: { typescript: true, python: false, rust: false } },
      sidecar: { status: 'available', reason: 'ok' },
      policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
      warnings: [],
    };

    expect(
      collectCapabilityDiagnostics({ targetContext, semanticFallbackUsed: true }),
    ).toMatchObject({
      capabilitiesMissing: ['embeddings'],
      warnings: [
        'Embeddings unavailable; semantic retrieval fell back to lexical/graph ranking. Run: ontoindex analyze --embeddings',
      ],
    });
  });
});
