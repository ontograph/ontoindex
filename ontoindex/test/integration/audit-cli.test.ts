import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auditIngestCommand, auditLintCommand, auditVerifyCommand } from '../../src/cli/audit.js';
import { formatAuditVerifySarif } from '../../src/cli/ci-export.js';
import { LocalAuditEventStore } from '../../src/core/audit-lifecycle/index.js';
import { expectSchemaMatch, loadJsonFixture } from '../helpers/json-schema.js';

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('audit lifecycle CLI', () => {
  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('parses audit ingest options and emits candidate JSON without opening findings', async () => {
    const repo = initRepo();
    const report = writeReport(repo);

    await auditIngestCommand(report, { repo, target: 'HEAD', json: true, persist: true });

    const output = JSON.parse(String(mockLog.mock.calls[0][0]));
    expect(output.action).toBe('audit-ingest');
    expect(output.rawCount).toBe(1);
    expect(output.findings[0].status).toBe('NEEDS-VERIFY');
    expect(output.targetHead).toMatch(/^[0-9a-f]{40}$/);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('supports audit lint report mode as advisory JSON', async () => {
    const repo = initRepo();
    const report = writeReport(repo);

    await auditLintCommand(report, {
      repo,
      target: 'HEAD',
      json: true,
      advisory: true,
      persist: false,
    });

    const output = JSON.parse(String(mockLog.mock.calls.at(-1)?.[0]));
    expect(output.action).toBe('audit-lint');
    expect(output.advisory).toBe(true);
    expect(output.exitRecommendation).toBe('zero');
    expect(output.summary.findings).toBe(1);
    expect(output.gate).toMatchObject({
      mode: 'advisory',
      source: 'default-advisory',
      policy: { blockOnStaleOpen: false },
    });
    expectSchemaMatch(loadJsonFixture('audit-ci/audit-lint.schema.json'), output);
  });

  it('validates audit verify JSON against the committed schema fixture', async () => {
    const repo = initRepo();
    const report = writeReport(repo);

    await auditIngestCommand(report, { repo, target: 'HEAD', json: true, persist: true });
    const ingest = JSON.parse(String(mockLog.mock.calls.at(-1)?.[0]));

    await auditVerifyCommand({
      repo,
      session: ingest.sessionId,
      json: true,
      persist: false,
    });

    const output = JSON.parse(findLoggedJson('"action": "audit-verify"'));
    expect(output.action).toBe('audit-verify');
    expect(output.verifiedCount).toBe(1);
    expectSchemaMatch(loadJsonFixture('audit-ci/audit-verify.schema.json'), output);
  });

  it('formats audit verify JSON as SARIF for PR annotations', async () => {
    const repo = initRepo();
    const report = writeReport(repo);

    await auditIngestCommand(report, { repo, target: 'HEAD', json: true, persist: true });
    const ingest = JSON.parse(String(mockLog.mock.calls.at(-1)?.[0]));

    await auditVerifyCommand({
      repo,
      session: ingest.sessionId,
      json: true,
      persist: false,
    });

    const sarif = formatAuditVerifySarif(JSON.parse(findLoggedJson('"action": "audit-verify"')));
    const results = sarif.runs[0].results;
    expect(sarif.version).toBe('2.1.0');
    expect(results).toHaveLength(1);
    expect(results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('src/app.ts');
  });

  it('keeps audit lint advisory unless repository policy enables blocking', async () => {
    const repo = initRepo();
    writePolicy(repo, {
      schemaVersion: 1,
      ignoreGlobs: [],
      generatedGlobs: [],
      riskThresholds: {},
      owners: {},
      audit: { blockOnStaleOpen: true },
    });
    const sessionId = await seedLintSession(repo);

    await auditLintCommand({
      repo,
      session: sessionId,
      format: 'junit',
      persist: false,
      advisory: true,
      strict: false,
    });

    const xml = String(mockLog.mock.calls.at(-1)?.[0]);
    expect(xml).toContain(
      '<failure message="OPEN findings require fresh positive evidence at targetHead.">',
    );
    expect(xml).toContain('src/app.ts (run) [claim]');
    expect(process.exitCode).toBe(1);
  });
});

function initRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'gn-audit-cli-'));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src/app.ts'), 'export function run() { return 1; }\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function writeReport(repo: string): string {
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
  return report;
}

function writePolicy(repo: string, policy: object): void {
  mkdirSync(path.join(repo, '.ontoindex'), { recursive: true });
  writeFileSync(path.join(repo, '.ontoindex', 'policy.json'), JSON.stringify(policy));
}

function findLoggedJson(needle: string): string {
  const match = [...mockLog.mock.calls]
    .map((call) => String(call[0]))
    .reverse()
    .find((entry) => entry.includes(needle));
  if (!match) {
    throw new Error(`Missing console.log payload containing ${needle}`);
  }
  return match;
}

async function seedLintSession(repo: string): Promise<string> {
  const sessionId = 'session-open';
  const targetHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  const store = new LocalAuditEventStore(repo);

  await store.createSession({
    id: sessionId,
    targetRepo: 'fixture',
    targetHead,
    sourceHash: 'sha256:report',
    graphIndexId: 'idx:test',
    verifierVersion: '0.1.0',
    sidecarStateHash: 'sidecar:ok',
    sourcePath: 'audit.md',
  });
  await store.createFindingCandidate({
    id: 'AUDIT-OPEN-1',
    sessionId,
    title: 'Open stale finding',
    fingerprint: 'fingerprint-open-1',
    status: 'OPEN',
    summary: 'OPEN findings require fresh positive evidence at targetHead.',
    severity: 'HIGH',
    metadata: {
      auditLifecycleFinding: {
        findingId: 'AUDIT-OPEN-1',
        title: 'Open stale finding',
        severity: 'HIGH',
        status: 'OPEN',
        source: {
          path: 'audit.md',
          hash: 'sha256:report',
          ingestedAt: '2026-05-17T09:00:00.000Z',
          dirtyWorktree: false,
        },
        targetRepo: 'fixture',
        targetRef: 'main',
        targetHead,
        graphIndexId: 'idx:test',
        claimedEvidence: ['src/app.ts:1'],
        verifiedEvidence: [],
        negativeEvidence: [],
        statusReason: 'OPEN findings require fresh positive evidence at targetHead.',
        fixCommit: null,
        confidence: 0,
        reasonCodes: [],
        fingerprint: {
          location: 'loc-open',
          claim: 'claim-open',
          history: 'history-open',
        },
        claimDsl: {
          id: 'CLAIM-OPEN-1',
          kind: 'missing-guard',
          symbol: 'run',
          path: 'src/app.ts',
        },
        verificationKind: 'static',
        verifiedAt: null,
        verifiedHead: null,
        statusChangedAt: null,
        statusChangedBy: 'ontoindex',
        statusTransitionEvidence: [],
        reopenTrigger: null,
        blocker: null,
        tombstoneMatch: null,
      },
    },
  });

  return sessionId;
}
