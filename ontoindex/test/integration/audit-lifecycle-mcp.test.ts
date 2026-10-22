import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { LocalAuditEventStore } from '../../src/core/audit-lifecycle/audit-event-store.js';
import { dispatchSuper, SUPER_NAMES } from '../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { registerRepo, saveMeta } from '../../src/storage/repo-manager.js';

describe('audit lifecycle MCP integration', () => {
  it('bundles and dispatches a cold verified session over the SDK, then refuses HEAD drift', async () => {
    const repo = initRepo();
    const home = mkdtempSync(path.join(tmpdir(), 'gn-audit-sdk-home-'));
    const backend = new LocalBackend();
    const server = createMCPServer(backend);
    const client = new Client({ name: 'audit-lifecycle-sdk', version: '1' });
    const sessionId = 'session-sdk';
    try {
      vi.stubEnv('ONTOINDEX_HOME', home);
      writeFileSync(path.join(home, 'registry.json'), '[]\n');
      const meta = {
        repoPath: repo,
        lastCommit: head(repo),
        indexedAt: '2026-05-17T00:00:00.000Z',
        capabilities: { symbols: false, impact: 'degraded' as const, processes: false },
      };
      // Lifecycle operations need repository identity, without an initialized graph.
      await saveMeta(path.join(repo, '.ontoindex'), meta);
      await registerRepo(repo, meta, { name: 'audit-lifecycle-sdk' });
      await seedManagerSession(repo, sessionId, ['finding-sdk']);
      await backend.init();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const response = await client.callTool({
          name,
          arguments: { repo, session: sessionId, response_budget_bytes: 30000, ...args },
        });
        const text = (response.content as Array<{ type: string; text?: string }>)
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
        return { response, report: JSON.parse(text) as Record<string, any> };
      };

      const lock = await call('gn_audit_session_lock', { action: 'create' });
      expect(lock.response.isError).not.toBe(true);
      expect(lock.report.lock.sessionId).toBe(sessionId);
      const bundled = await call('gn_audit_session_bundle', { strategy: 'root-cause' });
      expect(bundled.response.isError).not.toBe(true);
      expect(bundled.report.ok).toBe(true);
      expect(bundled.report.bundle.bundles).toHaveLength(1);
      const bundleId = bundled.report.bundle.bundles[0].id;
      const dispatched = await call('gn_audit_session_dispatch', { bundleId });
      expect(dispatched.response.isError).not.toBe(true);
      expect(dispatched.report.ok).toBe(true);
      expect(dispatched.report.dispatch.prompt.length).toBeGreaterThan(0);
      const store = new LocalAuditEventStore(repo);
      const dispatchEvents = (await store.load()).events.filter(
        (event) => event.type === 'BundleDispatched',
      );
      expect(dispatchEvents).toHaveLength(1);

      writeFileSync(path.join(repo, 'src/app.ts'), 'export function run() { return 2; }\n');
      execFileSync('git', ['add', 'src/app.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'drift'], { cwd: repo, stdio: 'pipe' });
      for (const name of ['gn_audit_session_bundle', 'gn_audit_session_dispatch']) {
        const stale = await call(name, { bundleId });
        expect(stale.response.isError).toBe(true);
        expect(stale.report).toMatchObject({ ok: false, code: 'STALE_SESSION' });
        expect(stale.report.prompt).toBeUndefined();
        expect(stale.report.dispatch).toBeUndefined();
      }
      expect(
        (await store.load()).events.filter((event) => event.type === 'BundleDispatched'),
      ).toEqual(dispatchEvents);
    } finally {
      try {
        await client.close();
      } finally {
        try {
          await server.close();
        } finally {
          try {
            await backend.disconnect();
          } finally {
            vi.unstubAllEnvs();
            rmSync(home, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
          }
        }
      }
    }
  });

  it('registers audit lifecycle super-functions in definitions and dispatch', () => {
    const names = new Set(ONTOINDEX_SUPER_TOOLS.map((tool) => tool.name));

    for (const name of [
      'gn_audit_ingest',
      'gn_audit_verify',
      'gn_fix_history',
      'gn_audit_bundle',
      'gn_audit_lint',
      'gn_audit_dedupe',
      'gn_dispatch_prompt',
      'gn_audit_tombstone_create',
      'gn_audit_session_start',
      'gn_audit_session_verify',
      'gn_audit_session_dedupe',
      'gn_audit_session_bundle',
      'gn_audit_session_dispatch',
      'gn_audit_session_review_worker',
      'gn_audit_session_lock',
      'gn_audit_pr_marker_scan',
      'gn_audit_diff',
      'gn_audit_replay',
      'gn_audit_export',
      'gn_scope_guard',
      'gn_bundle_conflicts',
    ]) {
      expect(names.has(name)).toBe(true);
      expect(SUPER_NAMES.has(name as never)).toBe(true);
    }
  });

  it('dispatches ingest and lint through bounded JSON-friendly reports', async () => {
    const repo = initRepo();
    const report = path.join(repo, 'audit.md');
    writeFileSync(
      report,
      [
        '## Missing guard in run',
        'Severity: HIGH',
        'Path: src/app.ts',
        'Symbol: run',
        'Claim: run is missing a guard',
        '- evidence: src/app.ts:1',
      ].join('\n'),
    );

    const ingest = (await dispatchSuper(
      'gn_audit_ingest',
      { repo, report, target: 'HEAD', persist: false },
      repo,
    )) as Record<string, any>;

    expect(ingest.action).toBe('audit-ingest');
    expect(ingest.rawCount).toBe(1);
    expect(ingest.findings[0]).toMatchObject({ status: 'NEEDS-VERIFY' });
    expect(ingest.limits.truncated).toBe(false);

    const lint = (await dispatchSuper(
      'gn_audit_lint',
      { repo, findings: ingest.findings, persist: false },
      repo,
    )) as Record<string, any>;

    expect(lint.action).toBe('audit-lint');
    expect(lint.ok).toBe(true);
    expect(lint.summary.findings).toBe(1);
  });

  it('dispatches session lock and PR marker scan lifecycle controls', async () => {
    const repo = initRepo();
    const report = path.join(repo, 'audit.md');
    writeFileSync(
      report,
      [
        '## Deferred guard in run',
        'Severity: HIGH',
        'Path: src/app.ts',
        'Symbol: run',
        'Claim: run is missing a guard',
        '- evidence: src/app.ts:2',
      ].join('\n'),
    );

    const ingest = (await dispatchSuper(
      'gn_audit_ingest',
      { repo, report, target: 'HEAD' },
      repo,
    )) as Record<string, any>;

    const lock = (await dispatchSuper(
      'gn_audit_session_lock',
      { repo, session: ingest.sessionId, action: 'create' },
      repo,
    )) as Record<string, any>;
    expect(lock.operation).toBe('create');
    expect(lock.lock.sessionId).toBe(ingest.sessionId);

    const validate = (await dispatchSuper(
      'gn_audit_session_lock',
      { repo, session: ingest.sessionId, action: 'validate' },
      repo,
    )) as Record<string, any>;
    expect(validate.status).toBe('VALID_SESSION');

    const markers = (await dispatchSuper(
      'gn_audit_pr_marker_scan',
      {
        repo,
        sourceText: 'export function run() {\\n  // TODO: PR-3 follow-up\\n  return 1;\\n}\\n',
        path: 'src/app.ts',
        evidenceLine: 3,
      },
      repo,
    )) as Record<string, any>;
    expect(markers.markers.map((marker: any) => marker.markerKind)).toEqual(
      expect.arrayContaining(['TODO', 'PR_REFERENCE']),
    );

    const exported = (await dispatchSuper(
      'gn_audit_export',
      { repo, session: ingest.sessionId, format: 'both' },
      repo,
    )) as Record<string, any>;
    expect(exported.json.session.id).toBe(ingest.sessionId);
    expect(exported.markdown).toContain('## Audit Result');
  });

  it('starts a manager session and refuses stale verify when HEAD drifts', async () => {
    const repo = initRepo();
    const report = path.join(repo, 'audit.md');
    writeFileSync(
      report,
      [
        '## Missing guard in run',
        'Severity: HIGH',
        'Path: src/app.ts',
        'Symbol: run',
        'Claim: run is missing a guard',
        '- evidence: src/app.ts:1',
      ].join('\n'),
    );

    const started = (await dispatchSuper(
      'gn_audit_session_start',
      { repo, sourcePath: report, targetRef: 'HEAD' },
      repo,
    )) as Record<string, any>;

    expect(started.action).toBe('audit-session-start');
    expect(started.ok).toBe(true);
    expect(started.lock.sessionId).toBe(started.sessionId);

    writeFileSync(path.join(repo, 'src/app.ts'), 'export function run() { return 2; }\n');
    execFileSync('git', ['add', 'src/app.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'drift'], { cwd: repo, stdio: 'ignore' });

    const verify = (await dispatchSuper(
      'gn_audit_session_verify',
      { repo, session: started.sessionId },
      repo,
    )) as Record<string, any>;

    expect(verify.ok).toBe(false);
    expect(verify.code).toBe('STALE_SESSION');
  });

  it('starts a non-persistent session without creating a store-backed lock', async () => {
    const repo = initRepo();
    const report = path.join(repo, 'audit.md');
    writeFileSync(
      report,
      [
        '## Missing guard in run',
        'Severity: HIGH',
        'Path: src/app.ts',
        'Symbol: run',
        'Claim: run is missing a guard',
        '- evidence: src/app.ts:1',
      ].join('\n'),
    );

    const started = (await dispatchSuper(
      'gn_audit_session_start',
      { repo, sourcePath: report, targetRef: 'HEAD', persist: false },
      repo,
    )) as Record<string, any>;

    expect(started.action).toBe('audit-session-start');
    expect(started.ok).toBe(true);
    expect(started.persisted).toBe(false);
    expect(started.lock).toBeNull();
  });

  it('runs dedupe before manager bundling and blocks manager dispatch for NEEDS-REVERIFY findings', async () => {
    const repo = initRepo();
    const sessionId = 'session-manager';
    await seedManagerSession(repo, sessionId, ['finding-a', 'finding-b']);

    const lock = (await dispatchSuper(
      'gn_audit_session_lock',
      { repo, session: sessionId, action: 'create' },
      repo,
    )) as Record<string, any>;
    expect(lock.lock.sessionId).toBe(sessionId);

    const bundle = (await dispatchSuper(
      'gn_audit_session_bundle',
      { repo, session: sessionId, strategy: 'root-cause' },
      repo,
    )) as Record<string, any>;

    expect(bundle.ok).toBe(true);
    expect(bundle.dedupe.action).toBe('audit-dedupe');
    expect(bundle.bundle.action).toBe('audit-bundle');
    expect(bundle.bundle.bundles).toHaveLength(1);

    const store = new LocalAuditEventStore(repo);
    await store.appendEvent({
      id: 'evt-reverify',
      type: 'FindingStatusChanged',
      occurredAt: '2026-05-17T00:00:05.000Z',
      sessionId,
      findingId: 'finding-a',
      status: 'NEEDS-REVERIFY',
      reason: 'stale OPEN refused by manager',
    });

    const dispatch = (await dispatchSuper(
      'gn_audit_session_dispatch',
      { repo, session: sessionId, bundleId: bundle.bundle.bundles[0].id },
      repo,
    )) as Record<string, any>;

    expect(dispatch.ok).toBe(false);
    expect(dispatch.code).toBe('DISPATCH_BLOCKED');
    expect(dispatch.blockedFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ findingId: 'finding-a', currentStatus: 'NEEDS-REVERIFY' }),
      ]),
    );
  });

  it('returns integrity metadata while preserving readable BROKEN-chain reports', async () => {
    const repo = initRepo();
    const sessionId = 'session-integrity';
    const store = new LocalAuditEventStore(repo);
    await store.createSession(
      {
        id: sessionId,
        targetRepo: path.basename(repo),
        targetHead: head(repo),
        sourceHash: 'sha256:integrity',
        graphIndexId: 'graph-1',
        verifierVersion: 'verifier-1',
        sidecarStateHash: 'graph-hash-1',
        createdAt: '2026-05-17T00:00:00.000Z',
      },
      { id: 'evt-session-integrity' },
    );
    const state = JSON.parse(readFileSync(store.eventStorePath, 'utf8')) as Record<string, unknown>;
    const events = state.events as Array<Record<string, unknown>>;
    events[0].checksum = 'tampered';
    writeFileSync(store.eventStorePath, JSON.stringify({ ...state, events }));

    for (const [name, params] of [
      ['gn_audit_replay', { repo, session: sessionId }],
      ['gn_audit_export', { repo, session: sessionId, format: 'both' }],
    ] as const) {
      const report = (await dispatchSuper(name, params, repo)) as Record<string, any>;
      expect(report.integrity).toMatchObject({ status: 'BROKEN', firstBrokenSequence: 0 });
      expect(report.ok).not.toBe(false);
      if (name === 'gn_audit_export') {
        expect(report.markdown).toContain('Integrity:');
        expect(report.markdown).toContain('- Status: BROKEN');
        expect(report.markdown).toContain('- First broken sequence: 0');
        expect(report.markdown).toContain('- Reason: checksum-mismatch');
      }
    }
  });

  it('runs scope guard and required test checks during manager review', async () => {
    const repo = initRepo();
    const sessionId = 'session-review';
    await seedManagerSession(repo, sessionId, ['finding-a']);
    await dispatchSuper(
      'gn_audit_session_lock',
      { repo, session: sessionId, action: 'create' },
      repo,
    );
    const bundle = (await dispatchSuper(
      'gn_audit_session_bundle',
      { repo, session: sessionId, strategy: 'root-cause' },
      repo,
    )) as Record<string, any>;

    const review = (await dispatchSuper(
      'gn_audit_session_review_worker',
      {
        repo,
        session: sessionId,
        bundleId: bundle.bundle.bundles[0].id,
        changedFiles: ['src/unexpected.ts'],
        changedSymbols: ['run'],
        executedTests: [],
      },
      repo,
    )) as Record<string, any>;

    expect(review.ok).toBe(false);
    expect(review.review.status).toBe('FAIL');
    expect(review.review.issues.map((issue: any) => issue.kind).sort()).toEqual([
      'missing-required-test',
      'unexpected-file',
    ]);
  });
});

function initRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'gn-audit-mcp-'));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  writeFileSync(path.join(repo, 'src-app-placeholder'), '');
  execFileSync('mkdir', ['-p', 'src'], { cwd: repo });
  writeFileSync(path.join(repo, 'src/app.ts'), 'export function run() { return 1; }\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

async function seedManagerSession(
  repo: string,
  sessionId: string,
  findingIds: string[],
): Promise<void> {
  const store = new LocalAuditEventStore(repo);
  const targetHead = head(repo);
  await store.createSession(
    {
      id: sessionId,
      targetRepo: path.basename(repo),
      targetHead,
      sourceHash: `sha256:${sessionId}`,
      graphIndexId: 'graph-1',
      verifierVersion: 'verifier-1',
      sidecarStateHash: 'graph-hash-1',
      createdAt: '2026-05-17T00:00:00.000Z',
    },
    { id: `evt-session-${sessionId}` },
  );

  for (const findingId of findingIds) {
    await store.createFindingCandidate(
      {
        id: findingId,
        sessionId,
        title: `Finding ${findingId}`,
        fingerprint: 'root-cause:run-guard',
        status: 'NEEDS-VERIFY',
        metadata: {
          files: ['src/app.ts'],
          symbols: ['run'],
          tests: ['test/app.test.ts'],
          writeSet: ['src/app.ts'],
          estimatedLoc: 3,
          rootCauseId: 'rc-run-guard',
        },
      },
      {
        id: `evt-candidate-${findingId}`,
        occurredAt: '2026-05-17T00:00:01.000Z',
      },
    );
    await store.appendEvent({
      id: `evt-verify-${findingId}`,
      type: 'FindingVerified',
      occurredAt: '2026-05-17T00:00:02.000Z',
      sessionId,
      findingId,
      verification: {
        verifiedAt: '2026-05-17T00:00:02.000Z',
        status: 'OPEN',
        evidence: [
          {
            id: `evidence-${findingId}`,
            kind: 'static',
            targetHead,
            graphIndexId: 'graph-1',
            verifierVersion: 'verifier-1',
            sidecarStateHash: 'graph-hash-1',
            reasonCodes: ['fresh-positive-evidence'],
            data: { path: 'src/app.ts', symbol: 'run', line: 1 },
          },
        ],
        reasonCodes: ['fresh-positive-evidence'],
        verifierVersion: 'verifier-1',
      },
    });
    await store.appendEvent({
      id: `evt-status-${findingId}`,
      type: 'FindingStatusChanged',
      occurredAt: '2026-05-17T00:00:03.000Z',
      sessionId,
      findingId,
      status: 'OPEN',
      reason: 'fresh positive evidence',
    });
  }
}

function head(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}
