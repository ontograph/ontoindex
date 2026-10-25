import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAuditEventStore } from '../../src/core/audit-lifecycle/audit-event-store.js';
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { dispatchSuper, type SuperTool } from '../../src/mcp/super/dispatch.js';

vi.mock('../../src/mcp/super/audit-ingest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/super/audit-ingest.js')>()),
  resolveAuditRepoHandle: async (repoId: string, repo?: string) => ({
    id: repo ?? repoId,
    repoPath: repo ?? repoId,
  }),
}));

const routes = {
  fix_history: 'gn_fix_history',
  session_dedupe: 'gn_audit_session_dedupe',
  diff: 'gn_audit_diff',
} as const satisfies Record<string, SuperTool>;
type Route = keyof typeof routes;

let repo: string;
let targetHead: string;
let backend: LocalBackend;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'facade-audit-gaps-'));
  git('init');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src/app.ts'), 'export function run() { return 1; }\n');
  git('add', 'src/app.ts');
  git('-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
  writeFileSync(path.join(repo, 'src/app.ts'), 'export function run() { return 2; }\n');
  git('add', 'src/app.ts');
  git('-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'fix run');
  targetHead = git('rev-parse', 'HEAD');
  mkdirSync(path.join(repo, '.ontoindex'));
  writeFileSync(
    path.join(repo, '.ontoindex/meta.json'),
    JSON.stringify({
      repoPath: repo,
      lastCommit: targetHead,
      indexedAt: '2026-05-17T00:00:00.000Z',
    }),
  );
  backend = {
    resolveRepo: async () => ({ id: repo, repoPath: repo }),
  } as unknown as LocalBackend;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function withoutRepoIdentity(value: Record<string, unknown>): Record<string, unknown> {
  const { repoLabel, repoPath, ...report } = value;
  expect({ repoLabel, repoPath }).toEqual({ repoLabel: repo, repoPath: repo });
  return report;
}

async function parity(action: Route, options: Record<string, unknown>) {
  const args = { repo, ...options };
  const direct = await dispatchSuper(routes[action], args, repo);
  const facade = await dispatchFacade('audit', action, args, backend);
  expect(withoutRepoIdentity(facade as Record<string, unknown>)).toEqual(direct);
  return direct as Record<string, unknown>;
}

async function errorParity(action: Route, options: Record<string, unknown>, message: string) {
  const args = { repo, ...options };
  const direct = await dispatchSuper(routes[action], args, repo).catch((error: unknown) => error);
  const facade = await dispatchFacade('audit', action, args, backend).catch(
    (error: unknown) => error,
  );
  expect(direct).toBeInstanceOf(Error);
  expect(facade).toBeInstanceOf(Error);
  const directError = direct as Error;
  const facadeError = facade as Error;
  expect(directError.message).toBe(message);
  expect(facadeError.message).toBe(message);
  expect(facadeError.name).toBe(directError.name);
  expect(withoutRepoIdentity({ ...facadeError })).toEqual({ ...directError });
}

async function seedManagerSession(
  sessionId: string,
  findingIds: string[],
  distinctFingerprints = false,
): Promise<void> {
  const store = new LocalAuditEventStore(repo);
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
    { id: `evt-session-${sessionId}`, occurredAt: '2026-05-17T00:00:00.000Z' },
  );
  for (const findingId of findingIds) {
    await store.createFindingCandidate(
      {
        id: findingId,
        sessionId,
        title: `Finding ${findingId}`,
        fingerprint: distinctFingerprints ? `root-cause:${findingId}` : 'root-cause:run-guard',
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
      { id: `evt-candidate-${findingId}`, occurredAt: '2026-05-17T00:00:01.000Z' },
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

describe('real audit gap handlers through facade and direct dispatch', () => {
  describe('fix_history', () => {
    it('preserves matching git commit evidence', async () => {
      const report = await parity('fix_history', {
        targetHead,
        path: 'src/app.ts',
        patterns: ['return 2'],
      });
      expect(report.candidates).toEqual([
        { commit: targetHead, subject: 'fix run', path: 'src/app.ts', matchedPattern: 'return 2' },
      ]);
    });

    it('preserves the missing-patterns warning and skip reason', async () => {
      const report = await parity('fix_history', { targetHead, path: 'src/app.ts' });
      expect(report).toMatchObject({
        candidates: [],
        warnings: ['No patterns supplied; fix-history lookup skipped.'],
        skipReasons: ['missing-patterns'],
      });
    });

    it('reports truncated only when more candidates exist than the limit', async () => {
      const exact = await parity('fix_history', {
        targetHead,
        path: 'src/app.ts',
        patterns: ['return 2'],
        limit: 1,
      });
      expect(exact.candidates).toEqual([
        { commit: targetHead, subject: 'fix run', path: 'src/app.ts', matchedPattern: 'return 2' },
      ]);
      expect(exact.limits).toEqual({ maxItems: 1, emitted: 1, truncated: false });
      const overflow = await parity('fix_history', {
        targetHead,
        path: 'src/app.ts',
        patterns: ['return'],
        limit: 1,
      });
      expect(overflow.limits).toEqual({ maxItems: 1, emitted: 1, truncated: true });
    });

    it('rejects a missing target HEAD identically', async () => {
      await errorParity(
        'fix_history',
        { targetHead: '', path: 'src/app.ts' },
        'targetHead is required for gn_fix_history',
      );
    });

    it('rejects a missing path identically', async () => {
      await errorParity(
        'fix_history',
        { targetHead, path: '' },
        'path is required for gn_fix_history',
      );
    });
  });

  describe('session_dedupe', () => {
    it('preserves a real dedupe group behind a valid manager session lock', async () => {
      const session = 'session-dedupe';
      await seedManagerSession(session, ['finding-a', 'finding-b']);
      await dispatchSuper('gn_audit_session_lock', { repo, session, action: 'create' }, repo);
      const report = await parity('session_dedupe', { session, strategy: 'root-cause' });
      expect(report).toMatchObject({
        ok: true,
        sessionId: session,
        lockValidation: { ok: true },
        dedupe: {
          groups: [{ strategy: 'root-cause', findingIds: ['finding-a', 'finding-b'] }],
        },
      });
    });

    it('rejects a missing session selector identically', async () => {
      await errorParity('session_dedupe', { session: '' }, 'session is required');
    });

    it('preserves the missing manager lock refusal identically', async () => {
      const session = 'session-without-lock';
      await seedManagerSession(session, ['finding-unlocked']);
      const report = await parity('session_dedupe', { session });
      expect(report).toMatchObject({
        ok: false,
        code: 'SESSION_LOCK_REQUIRED',
        message: `audit session lock is required for ${session}`,
        sessionId: session,
        skipReasons: ['session_lock_required'],
      });
    });
  });

  describe('diff', () => {
    beforeEach(async () => {
      await seedManagerSession('session-before', ['finding-removed'], true);
      await seedManagerSession('session-after', ['finding-added'], true);
    });

    it('preserves added and removed findings from two seeded sessions', async () => {
      const report = await parity('diff', {
        sessionA: 'session-before',
        sessionB: 'session-after',
      });
      expect(report).toMatchObject({
        added: [{ current: { id: 'finding-added', status: 'OPEN' } }],
        removed: [{ previous: { id: 'finding-removed', status: 'OPEN' } }],
        statusChanged: [],
        unchanged: [],
      });
    });

    it('rejects an unknown previous session identically', async () => {
      await errorParity(
        'diff',
        { sessionA: 'missing-before', sessionB: 'session-after' },
        'audit session does not exist: missing-before',
      );
    });

    it('rejects an unknown current session identically', async () => {
      await errorParity(
        'diff',
        { sessionA: 'session-before', sessionB: 'missing-after' },
        'audit session does not exist: missing-after',
      );
    });
  });
});
