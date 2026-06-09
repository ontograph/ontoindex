import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { LocalAuditEventStore } from '../../src/core/audit-lifecycle/audit-event-store.js';
import { dispatchSuper, SUPER_NAMES } from '../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';

describe('audit lifecycle MCP integration', () => {
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
