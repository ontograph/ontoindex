import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalAuditEventStore,
  createAuditSessionLockFromStore,
} from '../../src/core/audit-lifecycle/index.js';
import type { AuditImplementationBundle } from '../../src/core/audit-lifecycle/audit-bundle.js';
import { generateAuditDispatchPrompt } from '../../src/core/audit-lifecycle/dispatch-prompt.js';
import { evaluateAuditScopeGuard } from '../../src/core/audit-lifecycle/scope-guard.js';
import type {
  AuditEvidence,
  AuditFinding,
  AuditSession,
} from '../../src/core/audit-lifecycle/audit-session.js';
import { gnAuditSessionDispatch } from '../../src/mcp/super/audit-session-tools.js';
import {
  buildTestGapReport,
  gnTestGap,
  gnVerifyDiff,
  gnWorkerScopeReview,
} from '../../src/mcp/super/write-through-verification.js';

const session: AuditSession = {
  id: 'session-1',
  targetRepo: 'repo-a',
  targetHead: 'abc123',
  sourceHash: 'sha256:source',
  graphIndexId: 'index-1',
  verifierVersion: 'verifier-1',
  sidecarStateHash: 'sha256:sidecar',
  createdAt: '2026-05-17T00:00:00.000Z',
  metadata: {},
};

describe('audit dispatch prompt', () => {
  it('requires exactly one bundle and includes the M7 handoff controls', () => {
    const result = generateAuditDispatchPrompt({
      session,
      bundles: [bundle('bundle-a')],
      findings: [finding('finding-a')],
      verificationTimestamp: '2026-05-17T01:00:00.000Z',
      redactionMode: 'none',
      impactChecks: ['Run ontoindex impact spawnChild before editing.'],
    });

    expect(result.prompt).toContain('Implement exactly one audit bundle.');
    expect(result.prompt).toContain('- Bundle id: bundle-a');
    expect(result.prompt).toContain('- Target HEAD: abc123');
    expect(result.prompt).toContain('- Verification timestamp: 2026-05-17T01:00:00.000Z');
    expect(result.prompt).toContain('Scope:');
    expect(result.prompt).toContain('- src/process.cpp');
    expect(result.prompt).toContain('Non-scope:');
    expect(result.prompt).toContain('- Do not edit MCP surfaces');
    expect(result.prompt).toContain('Required tests:');
    expect(result.prompt).toContain('- test/process.test.ts');
    expect(result.prompt).toContain('Required impact checks:');
    expect(result.prompt).toContain('- Run ontoindex impact spawnChild before editing.');
    expect(result.prompt).toContain('Stop conditions:');
    expect(result.prompt).toContain('- Stop if target HEAD is not abc123.');
    expect(result.prompt).toContain('- Redaction mode: none');
  });

  it('refuses multi-bundle dispatch prompts', () => {
    expect(() =>
      generateAuditDispatchPrompt({
        session,
        bundles: [bundle('bundle-a'), bundle('bundle-b')],
        verificationTimestamp: '2026-05-17T01:00:00.000Z',
      }),
    ).toThrow(/exactly one bundle/u);
  });

  it('refuses unverified and runtime-only findings by default', () => {
    expect(() =>
      generateAuditDispatchPrompt({
        session,
        bundles: [bundle('bundle-a')],
        findings: [finding('finding-a', { verification: undefined })],
        verificationTimestamp: '2026-05-17T01:00:00.000Z',
      }),
    ).toThrow(/unverified findings/u);

    expect(() =>
      generateAuditDispatchPrompt({
        session,
        bundles: [bundle('bundle-a')],
        findings: [finding('finding-a', { metadata: { runtimeOnly: true } })],
        verificationTimestamp: '2026-05-17T01:00:00.000Z',
      }),
    ).toThrow(/runtime-only findings/u);
  });

  it('redacts paths, snippets, and sensitive values when requested', () => {
    const result = generateAuditDispatchPrompt({
      session: {
        ...session,
        targetRepo: '/private/repos/repo-a',
      },
      bundles: [bundle('bundle-a')],
      findings: [finding('finding-a')],
      verificationTimestamp: '2026-05-17T01:00:00.000Z',
      redactionMode: 'sensitive',
      sourceSnippets: [
        {
          path: '/private/repos/repo-a/src/process.cpp',
          symbol: 'spawnChild',
          content: 'const token=secret;',
        },
      ],
    });

    expect(result.prompt).toContain('[REDACTED_PATH_');
    expect(result.prompt).toContain('[REDACTED_SNIPPET]');
    expect(result.prompt).not.toContain('/private/repos/repo-a');
    expect(result.prompt).not.toContain('const token=secret;');
  });
});

describe('audit scope guard', () => {
  it('passes when edits and tests stay inside the dispatched bundle', () => {
    const result = evaluateAuditScopeGuard({
      bundle: bundle('bundle-a'),
      changedFiles: ['src/process.cpp'],
      changedSymbols: ['spawnChild'],
      executedTests: ['test/process.test.ts'],
    });

    expect(result).toEqual({
      status: 'PASS',
      bundleId: 'bundle-a',
      issues: [],
    });
  });

  it('detects unexpected files, unexpected symbols, and missing tests', () => {
    const result = evaluateAuditScopeGuard({
      bundle: bundle('bundle-a'),
      changedFiles: ['src/process.cpp', 'src/mcp/server.ts'],
      changedSymbols: ['spawnChild', 'registerMcpTool'],
      executedTests: [],
    });

    expect(result.status).toBe('FAIL');
    expect(result.issues.map((issue) => issue.kind).sort()).toEqual([
      'missing-required-test',
      'unexpected-file',
      'unexpected-symbol',
    ]);
  });

  it('detects cross-bundle file and symbol edits', () => {
    const current = bundle('bundle-a');
    const other = bundle('bundle-b', {
      files: ['src/shared.ts'],
      symbols: ['sharedSymbol'],
      writeSet: ['src/shared.ts'],
      tests: ['test/shared.test.ts'],
    });

    const result = evaluateAuditScopeGuard({
      bundle: current,
      allBundles: [current, other],
      changedFiles: ['src/shared.ts'],
      changedSymbols: ['sharedSymbol'],
      executedTests: ['test/process.test.ts'],
    });

    expect(result.status).toBe('FAIL');
    expect(result.issues.filter((issue) => issue.kind === 'cross-bundle-edit')).toHaveLength(2);
  });
});

describe('manager audit dispatch wrapper', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-audit-dispatch-'));
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src/app.ts'), 'export function run() { return 1; }\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('refuses duplicate-only bundle children', async () => {
    const store = new LocalAuditEventStore(repo);
    const targetHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();

    await store.createSession(
      {
        id: 'session-1',
        targetRepo: 'repo-a',
        targetHead,
        sourceHash: 'sha256:source',
        graphIndexId: 'index-1',
        verifierVersion: 'verifier-1',
        sidecarStateHash: 'sha256:sidecar',
        createdAt: '2026-05-17T00:00:00.000Z',
      },
      { id: 'evt-session' },
    );
    await store.createFindingCandidate(
      {
        id: 'finding-a',
        sessionId: 'session-1',
        title: 'Duplicate child',
        fingerprint: 'fp-a',
        metadata: {
          files: ['src/app.ts'],
          symbols: ['run'],
          tests: ['test/app.test.ts'],
          writeSet: ['src/app.ts'],
        },
      },
      { id: 'evt-candidate', occurredAt: '2026-05-17T00:00:01.000Z' },
    );
    await store.appendEvent({
      id: 'evt-verify',
      type: 'FindingVerified',
      occurredAt: '2026-05-17T00:00:02.000Z',
      sessionId: 'session-1',
      findingId: 'finding-a',
      verification: {
        verifiedAt: '2026-05-17T00:00:02.000Z',
        status: 'OPEN',
        evidence: [sessionEvidence(targetHead)],
        reasonCodes: ['fresh-positive-evidence'],
        verifierVersion: 'verifier-1',
      },
    });
    await store.appendEvent({
      id: 'evt-bundle',
      type: 'FindingBundled',
      occurredAt: '2026-05-17T00:00:03.000Z',
      sessionId: 'session-1',
      bundleId: 'bundle-1',
      bundle: {
        id: 'bundle-1',
        sessionId: 'session-1',
        findingIds: ['finding-a'],
        status: 'CREATED',
        createdAt: '2026-05-17T00:00:03.000Z',
        metadata: {
          duplicateFindingIds: ['finding-a'],
          files: ['src/app.ts'],
          symbols: ['run'],
          tests: ['test/app.test.ts'],
          writeSet: ['src/app.ts'],
        },
      },
    });
    await createAuditSessionLockFromStore({
      repoRoot: repo,
      sessionId: 'session-1',
      graphHash: 'sha256:sidecar',
      ontoindexVersion: '1.0.0',
      store,
    });

    const result = await gnAuditSessionDispatch(repo, {
      session: 'session-1',
      bundleId: 'bundle-1',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('DISPATCH_BLOCKED');
    expect(result.duplicateOnlyChildren).toBe(true);
  });

  it('reports unexpected files, symbols, impacts, and missing tests in gn_verify_diff', async () => {
    const result = await gnVerifyDiff(repo, {
      repo,
      expectedFiles: ['src/process.cpp'],
      expectedSymbols: ['spawnChild'],
      expectedTests: ['test/process.test.ts'],
      changedFiles: ['src/process.cpp', 'src/mcp/server.ts'],
      changedSymbols: ['spawnChild', 'registerMcpTool'],
      executedTests: [],
    });

    expect(result.status).toBe('FAIL');
    expect(result.unexpectedChangedFiles).toEqual(['src/mcp/server.ts']);
    expect(result.unexpectedChangedSymbols).toEqual(['registerMcpTool']);
    expect(result.missingRequiredTests).toEqual(['test/process.test.ts']);
  });

  it('reports changed production symbols without test evidence in gn_test_gap', async () => {
    const result = await gnTestGap(repo, {
      repo,
      changedFiles: ['src/process.cpp'],
      changedSymbols: ['spawnChild'],
      executedTests: [],
    });

    expect(result.status).toBe('FAIL');
    expect(result.heuristics).toMatchObject({
      filenameDerivedCoverage: 'heuristic',
    });
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: 'spawnChild',
          coverageStatus: 'missing-test-evidence',
        }),
      ]),
    );
  });

  it('does not count markdown headings as changed production symbols in test gaps', () => {
    const result = buildTestGapReport({
      symbolRecords: [
        { name: 'Evidence expansion', filePath: 'docs/adr/0028-answer-engine.md', type: 'Heading' },
        { name: 'spawnChild', filePath: 'src/process.cpp', type: 'Method' },
      ],
      executedTests: [],
    });

    expect(result.status).toBe('FAIL');
    expect(result.changedProductionSymbolCount).toBe(1);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        symbol: 'spawnChild',
        filePath: 'src/process.cpp',
      }),
    ]);
  });

  it('rejects worker scope reviews with unexpected scope and missing test evidence', async () => {
    await seedWorkerReviewBundle(repo);

    const result = await gnWorkerScopeReview(repo, {
      repo,
      session: 'session-1',
      bundleId: 'bundle-1',
      changedFiles: ['src/process.cpp', 'src/mcp/server.ts'],
      changedSymbols: ['spawnChild', 'registerMcpTool'],
      executedTests: [],
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('FAIL');
    expect(result.scopeGuard).toMatchObject({ status: 'FAIL' });
    expect(result.verifyDiff).toMatchObject({
      status: 'FAIL',
      unexpectedChangedFiles: ['src/mcp/server.ts'],
      unexpectedChangedSymbols: ['registerMcpTool'],
      missingRequiredTests: ['test/process.test.ts'],
    });
    expect(result.testGap).toMatchObject({ status: 'FAIL' });
  });
});

function bundle(
  id: string,
  overrides: Partial<AuditImplementationBundle> = {},
): AuditImplementationBundle {
  return {
    id,
    sessionId: 'session-1',
    rootCauseId: 'rc-process',
    strategy: 'root-cause',
    status: 'CREATED',
    findingIds: ['finding-a'],
    duplicateFindingIds: [],
    files: ['src/process.cpp'],
    symbols: ['spawnChild'],
    tests: ['test/process.test.ts'],
    writeSet: ['src/process.cpp'],
    estimatedLoc: 8,
    nonScope: ['Do not edit MCP surfaces'],
    stopConditions: ['Stop if runtime evidence is required'],
    rootCause: {
      id: 'root-cause:process',
      title: 'Process descriptor leak',
      files: ['src/process.cpp'],
      symbols: ['spawnChild'],
      writeSet: ['src/process.cpp'],
      testSurface: ['test/process.test.ts'],
      findingIds: ['finding-a'],
    },
    conflicts: [],
    createdAt: '2026-05-17T01:00:00.000Z',
    ...overrides,
  };
}

function finding(id: string, overrides: Partial<AuditFinding> = {}): AuditFinding {
  const evidence = auditEvidence();
  return {
    id,
    sessionId: 'session-1',
    title: `Finding ${id}`,
    fingerprint: `fingerprint-${id}`,
    status: 'OPEN',
    evidence: [evidence],
    metadata: {},
    verification: {
      verifiedAt: '2026-05-17T01:00:00.000Z',
      status: 'OPEN',
      evidence: [evidence],
      reasonCodes: ['fresh-positive-evidence'],
      verifierVersion: 'verifier-1',
    },
    ...overrides,
  };
}

async function seedWorkerReviewBundle(repo: string): Promise<void> {
  const store = new LocalAuditEventStore(repo);
  const targetHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();

  await store.createSession(
    {
      id: 'session-1',
      targetRepo: 'repo-a',
      targetHead,
      sourceHash: 'sha256:source',
      graphIndexId: 'index-1',
      verifierVersion: 'verifier-1',
      sidecarStateHash: 'sha256:sidecar',
      createdAt: '2026-05-17T00:00:00.000Z',
    },
    { id: 'evt-session-review' },
  );
  await store.createFindingCandidate(
    {
      id: 'finding-a',
      sessionId: 'session-1',
      title: 'Process descriptor leak',
      fingerprint: 'fp-a',
      metadata: {
        files: ['src/process.cpp'],
        symbols: ['spawnChild'],
        tests: ['test/process.test.ts'],
        writeSet: ['src/process.cpp'],
      },
    },
    { id: 'evt-candidate-review', occurredAt: '2026-05-17T00:00:01.000Z' },
  );
  await store.appendEvent({
    id: 'evt-verify-review',
    type: 'FindingVerified',
    occurredAt: '2026-05-17T00:00:02.000Z',
    sessionId: 'session-1',
    findingId: 'finding-a',
    verification: {
      verifiedAt: '2026-05-17T00:00:02.000Z',
      status: 'OPEN',
      evidence: [sessionEvidence(targetHead)],
      reasonCodes: ['fresh-positive-evidence'],
      verifierVersion: 'verifier-1',
    },
  });
  await store.appendEvent({
    id: 'evt-bundle-review',
    type: 'FindingBundled',
    occurredAt: '2026-05-17T00:00:03.000Z',
    sessionId: 'session-1',
    bundleId: 'bundle-1',
    bundle: {
      id: 'bundle-1',
      sessionId: 'session-1',
      findingIds: ['finding-a'],
      status: 'CREATED',
      createdAt: '2026-05-17T00:00:03.000Z',
      metadata: {
        duplicateFindingIds: [],
        files: ['src/process.cpp'],
        symbols: ['spawnChild'],
        tests: ['test/process.test.ts'],
        writeSet: ['src/process.cpp'],
      },
    },
  });
  await createAuditSessionLockFromStore({
    repoRoot: repo,
    sessionId: 'session-1',
    graphHash: 'sha256:sidecar',
    ontoindexVersion: '1.0.0',
    store,
  });
}

function auditEvidence(): AuditEvidence {
  return {
    id: 'evidence-1',
    kind: 'static',
    targetHead: 'abc123',
    graphIndexId: 'index-1',
    verifierVersion: 'verifier-1',
    sidecarStateHash: 'sha256:sidecar',
    reasonCodes: ['fresh-positive-evidence'],
    data: {},
  };
}

function sessionEvidence(targetHead: string) {
  return {
    id: 'session-evidence-1',
    kind: 'static',
    targetHead,
    graphIndexId: 'index-1',
    verifierVersion: 'verifier-1',
    sidecarStateHash: 'sha256:sidecar',
    reasonCodes: ['fresh-positive-evidence'],
    data: {},
  };
}
