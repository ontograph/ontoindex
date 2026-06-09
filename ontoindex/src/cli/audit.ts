/**
 * Audit Command
 *
 * Generates a structured audit report from the knowledge graph.
 * Usage: ontoindex audit [options]
 * Default output: ./ontoindex-audit/audit-report.md
 */

import path from 'path';
import fs from 'fs/promises';
import { getGitRoot, isGitRepo, getCurrentCommit } from '../storage/git.js';
import { getStoragePaths, loadMeta } from '../storage/repo-manager.js';
import { initLbug, closeLbug } from '../core/lbug/pool-adapter.js';
import { runAuditReport, formatAuditReport } from '../mcp/local/backend-audit-report.js';
import { ingestAuditFindings, type AuditLintFinding } from '../core/audit-lifecycle/index.js';
import { runAuditIngest } from '../mcp/super/audit-ingest.js';
import { loadLifecycleFindings, runAuditVerify } from '../mcp/super/audit-verify.js';
import { loadAuditBundles, runAuditLint } from '../mcp/super/audit-lint.js';
import { runAuditBundle } from '../mcp/super/audit-bundle.js';
import type { AuditLintBundle } from '../core/audit-lifecycle/index.js';
import {
  formatAuditLintJUnit,
  formatAuditLintSarif,
  formatAuditVerifySarif,
  resolveAuditCiGate,
  withAuditCiGate,
} from './ci-export.js';

interface AuditCommandOptions {
  annotate?: boolean;
  since?: string;
  output?: string;
  force?: boolean;
}

interface AuditLifecycleCommandOptions {
  repo?: string;
  target?: string;
  targetRef?: string;
  json?: boolean;
  format?: 'json' | 'sarif' | 'junit';
  session?: string;
  findingId?: string;
  advisory?: boolean;
  strict?: boolean;
  scope?: 'report' | 'bundle' | 'all';
  maxFindings?: string | number;
  maxEvidence?: string | number;
  maxIssues?: string | number;
  maxBundles?: string | number;
  persist?: boolean;
}

function caughtMessage(err: unknown): unknown {
  if (err == null) return undefined;
  return (Object(err) as { readonly message?: unknown }).message;
}

export const auditCommand = async (options: AuditCommandOptions = {}) => {
  console.log('\n  OntoIndex Audit Report\n');

  const gitRoot = getGitRoot(process.cwd());
  if (!gitRoot) {
    console.error('  Error: Not inside a git repository\n');
    process.exitCode = 1;
    return;
  }

  if (!isGitRepo(gitRoot)) {
    console.error('  Error: Not a git repository\n');
    process.exitCode = 1;
    return;
  }

  const { storagePath, lbugPath } = getStoragePaths(gitRoot);
  const meta = await loadMeta(storagePath);
  if (!meta) {
    console.error('  Error: No OntoIndex index found. Run `ontoindex analyze` first.\n');
    process.exitCode = 1;
    return;
  }

  const outputDir = options.output
    ? path.resolve(options.output)
    : path.join(process.cwd(), 'ontoindex-audit');
  const outputFile = path.join(outputDir, 'audit-report.md');

  if (options.annotate) {
    console.log('  Annotation: enabled (one LLM call, cached)\n');
  }

  const repoName = path.basename(gitRoot);
  console.log(`  Running audit for: ${repoName}`);

  const repoId = repoName.toLowerCase();
  const lastCommit = getCurrentCommit(gitRoot);

  const repo = {
    id: repoId,
    name: repoName,
    repoPath: gitRoot,
    storagePath,
    lastCommit,
  };

  await initLbug(repoId, lbugPath);
  try {
    const result = await runAuditReport(repo, {
      since: options.since,
      annotate: options.annotate,
      force: options.force,
    });

    const markdown = formatAuditReport(result);

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outputFile, markdown, 'utf-8');

    console.log(`\n  Audit report written to: ${outputFile}\n`);
  } catch (err: unknown) {
    console.error(`\n  Error: ${caughtMessage(err)}\n`);
    process.exitCode = 1;
  } finally {
    await closeLbug(repoId);
  }
};

export const auditIngestCommand = async (
  report: string,
  options: AuditLifecycleCommandOptions = {},
) => {
  await emitLifecycleReport(
    runAuditIngest(resolveLifecycleRepoPath(options), {
      report,
      target: options.target,
      targetRef: options.targetRef,
      maxFindings: toNumber(options.maxFindings),
      persist: options.persist,
    }),
    { format: options.format ?? (options.json ? 'json' : undefined) },
  );
};

export const auditVerifyCommand = async (options: AuditLifecycleCommandOptions = {}) => {
  const repoPath = resolveLifecycleRepoPath(options);
  await emitLifecycleReport(
    runAuditVerify(repoPath, {
      session: options.session,
      findingId: options.findingId,
      maxFindings: toNumber(options.maxFindings),
      maxEvidence: toNumber(options.maxEvidence),
      persist: options.persist,
    }),
    { format: options.format ?? (options.json ? 'json' : undefined) },
  );
};

export const auditLintCommand = async (
  reportOrOptions?: string | AuditLifecycleCommandOptions,
  maybeOptions: AuditLifecycleCommandOptions = {},
) => {
  const report = typeof reportOrOptions === 'string' ? reportOrOptions : undefined;
  const options = typeof reportOrOptions === 'string' ? maybeOptions : (reportOrOptions ?? {});
  const repoPath = resolveLifecycleRepoPath(options);
  let ingestSession: string | undefined;
  let findings: AuditLintFinding[] | undefined;
  if (report) {
    const ingest = await ingestAuditFindings({
      repoPath,
      sourcePath: report,
      targetRef: options.targetRef ?? options.target,
    });
    ingestSession = ingest.sessionId;
    findings = ingest.findings as AuditLintFinding[];
  }

  const gate = await resolveAuditCiGate(repoPath, {
    advisory: options.advisory,
    strict: options.strict,
  });
  const output = await runAuditLint(repoPath, {
    session: options.session ?? ingestSession,
    findings,
    scope: options.scope,
    advisory: gate.mode === 'advisory',
    maxIssues: toNumber(options.maxIssues),
    persist: options.persist,
  });
  const lintSessionId =
    typeof output.sessionId === 'string' && output.sessionId.length > 0
      ? output.sessionId
      : (options.session ?? ingestSession);
  const lintFindings =
    findings ??
    (lintSessionId
      ? ((await loadLifecycleFindings(repoPath, lintSessionId)) as AuditLintFinding[])
      : []);
  const bundles =
    lintSessionId && (options.scope === 'bundle' || options.scope === 'all')
      ? await loadAuditBundles(repoPath, lintSessionId)
      : ([] as AuditLintBundle[]);

  await emitLifecycleReport(
    Promise.resolve(
      withAuditCiGate(output as Record<string, unknown> & { action: 'audit-lint' }, gate),
    ),
    {
      format: options.format ?? (options.json ? 'json' : undefined),
      lintContext: {
        findings: lintFindings,
        bundles,
        gate,
      },
    },
  );
  if (gate.mode === 'blocking' && output.exitRecommendation === 'nonzero') {
    process.exitCode = 1;
  }
};

export const auditBundleCommand = async (options: AuditLifecycleCommandOptions = {}) => {
  await emitLifecycleReport(
    runAuditBundle(resolveLifecycleRepoPath(options), {
      session: options.session,
      maxBundles: toNumber(options.maxBundles),
      persist: options.persist,
    }),
    { format: options.format ?? (options.json ? 'json' : undefined) },
  );
};

function resolveLifecycleRepoPath(options: AuditLifecycleCommandOptions): string {
  if (options.repo) return path.resolve(options.repo);
  const gitRoot = getGitRoot(process.cwd());
  if (!gitRoot) {
    throw new Error('Not inside a git repository and no --repo specified.');
  }
  return gitRoot;
}

async function emitLifecycleReport(
  report: Promise<Record<string, unknown>>,
  options: {
    format?: 'json' | 'sarif' | 'junit';
    lintContext?: {
      findings: readonly AuditLintFinding[];
      bundles: readonly AuditLintBundle[];
      gate: Awaited<ReturnType<typeof resolveAuditCiGate>>;
    };
  } = {},
) {
  try {
    const output = await report;
    const format = options.format ?? 'json';
    if (format === 'sarif') {
      const payload =
        output.action === 'audit-lint' && options.lintContext
          ? formatAuditLintSarif(
              output as Record<string, unknown> & { action: 'audit-lint' },
              options.lintContext,
            )
          : output.action === 'audit-verify'
            ? formatAuditVerifySarif(output as Record<string, unknown> & { action: 'audit-verify' })
            : output;
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (format === 'junit') {
      if (output.action !== 'audit-lint' || !options.lintContext) {
        throw new Error('JUnit export is only supported for audit lint gate results.');
      }
      console.log(
        formatAuditLintJUnit(
          output as Record<string, unknown> & { action: 'audit-lint' },
          options.lintContext,
        ),
      );
      return;
    }
    console.log(JSON.stringify(output, null, 2));
  } catch (err: unknown) {
    console.error(`Error: ${caughtMessage(err)}`);
    process.exitCode = 1;
  }
}

function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
