import {
  LocalAuditEventStore,
  lintAuditBundles,
  lintAuditReport,
  type AuditLintBundle,
  type AuditLintFinding,
  type AuditLintIssue,
} from '../../core/audit-lifecycle/index.js';
import type { AuditBundle } from '../../core/audit-lifecycle/audit-session.js';
import { createPolicyFilter, resolveRepositoryPolicy } from '../../core/repository-policy.js';
import {
  paginateMcpItems,
  resolveMcpResponseMode,
  shouldExposeCursor,
  type McpResponseCursor,
} from '../shared/response-limits.js';
import { clampLimit, resolveAuditRepoHandle } from './audit-ingest.js';
import { loadLifecycleFindings } from './audit-verify.js';

export interface AuditLintParams {
  repo?: string;
  session?: string;
  sessionId?: string;
  findings?: AuditLintFinding[];
  bundles?: AuditLintBundle[];
  scope?: 'report' | 'bundle' | 'all';
  advisory?: boolean;
  maxIssues?: number;
  persist?: boolean;
  includeIgnored?: boolean;
  cursor?: string;
  summary?: boolean;
  minimal?: boolean;
}

export async function gnAuditLint(
  repoId: string,
  params: AuditLintParams,
): Promise<Record<string, unknown>> {
  const repo = await resolveAuditRepoHandle(repoId, params.repo);
  return runAuditLint(repo.repoPath, params);
}

export async function runAuditLint(
  repoPath: string,
  params: AuditLintParams,
): Promise<Record<string, unknown>> {
  const sessionId = params.sessionId ?? params.session;
  const scope = params.scope ?? 'report';
  const responseMode = resolveMcpResponseMode(params);
  const maxIssues = clampLimit(params.maxIssues, 50);
  const loadedFindings =
    params.findings ??
    (sessionId ? ((await loadLifecycleFindings(repoPath, sessionId)) as AuditLintFinding[]) : []);
  const bundles = params.bundles ?? (sessionId ? await loadAuditBundles(repoPath, sessionId) : []);
  const resolvedPolicy = await resolveRepositoryPolicy({
    repoPath,
    toolPolicy: { includeIgnored: params.includeIgnored },
  });
  const policyFilter = createPolicyFilter(resolvedPolicy.policy, {
    includeIgnored: resolvedPolicy.includeIgnored,
    sources: resolvedPolicy.sources,
  });
  const findings = loadedFindings
    .map((finding) => normalizeLintFinding(finding))
    .filter((finding) => !isFindingPolicyExcluded(finding, policyFilter));

  const reportResult =
    scope === 'report' || scope === 'all'
      ? lintAuditReport({ findings }, { advisory: params.advisory })
      : undefined;
  const bundleResult =
    scope === 'bundle' || scope === 'all'
      ? lintAuditBundles({ bundles }, { advisory: params.advisory })
      : undefined;

  const issues = sortAuditIssues([
    ...(reportResult?.issues ?? []),
    ...(bundleResult?.issues ?? []),
  ]);
  const ok = (reportResult?.ok ?? true) && (bundleResult?.ok ?? true);
  const page = paginateMcpItems(issues, { pageSize: maxIssues, cursor: params.cursor });
  const cursor = shouldExposeCursor(page.page) ? page.page : undefined;
  const truncated = page.page.offset > 0 || page.page.hasMore;

  if (params.persist !== false && sessionId) {
    await new LocalAuditEventStore(repoPath).appendEvent({
      id: `evt-lint-${sessionId}-${Date.now()}`,
      type: 'AuditLinted',
      occurredAt: new Date().toISOString(),
      sessionId,
      status: ok ? 'ok' : 'issues',
      findingIds: findings.map((finding) => finding.findingId),
      warnings: issues.map((issue) => issue.message).slice(0, maxIssues),
    });
  }

  const nextAction = createAuditLintNextAction(
    ok,
    params.advisory,
    cursor,
    policyFilter.disclosure,
  );
  const sharedSummary = {
    findings: findings.length,
    bundles: bundles.length,
    issueCount: issues.length,
    byRuleId: countBy(issues, (issue) => issue.ruleId),
    bySeverity: countBy(issues, (issue) => issue.severity),
  };

  if (responseMode === 'minimal') {
    return {
      version: 1,
      action: 'audit-lint',
      responseMode,
      result: {
        ok,
        advisory: Boolean(params.advisory),
        exitRecommendation: params.advisory ? 'zero' : ok ? 'zero' : 'nonzero',
        sessionId,
        scope,
        summary: sharedSummary,
        truncated,
      },
      ...(cursor ? { cursor } : {}),
      nextAction,
    };
  }

  return {
    version: 1,
    action: 'audit-lint',
    responseMode,
    sessionId,
    ok,
    advisory: Boolean(params.advisory),
    exitRecommendation: params.advisory ? 'zero' : ok ? 'zero' : 'nonzero',
    issues: page.items.map((issue) => (responseMode === 'summary' ? summarizeIssue(issue) : issue)),
    summary: sharedSummary,
    limits: {
      maxIssues: page.page.pageSize,
      emitted: page.page.returned,
      total: issues.length,
      truncated,
    },
    policyFilter: policyFilter.disclosure,
    warnings:
      policyFilter.disclosure.excludedPathCount > 0
        ? [
            `${policyFilter.disclosure.excludedPathCount} audit finding paths excluded by repository policy; rerun with includeIgnored:true for high-severity/vendor scans.`,
          ]
        : [],
    skipReasons: !sessionId && !params.findings ? ['missing-session-or-findings'] : [],
    ...(cursor ? { cursor } : {}),
    nextAction,
  };
}

function isFindingPolicyExcluded(
  finding: AuditLintFinding,
  policyFilter: ReturnType<typeof createPolicyFilter>,
): boolean {
  const paths = findingTargetPaths(finding);
  return paths.length > 0 && paths.some((filePath) => policyFilter.shouldExcludePath(filePath));
}

function findingTargetPaths(finding: AuditLintFinding): string[] {
  return [
    finding.claimDsl?.path,
    ...safeEvidencePaths(finding.verifiedEvidence),
    ...safeEvidencePaths(finding.negativeEvidence),
    ...safeEvidencePaths(finding.statusTransitionEvidence),
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeLintFinding(finding: AuditLintFinding): AuditLintFinding {
  return {
    ...finding,
    findingId: typeof finding.findingId === 'string' ? finding.findingId : '',
    title: typeof finding.title === 'string' ? finding.title : '',
    severity: typeof finding.severity === 'string' ? finding.severity : 'LOW',
    status: typeof finding.status === 'string' ? finding.status : 'NEEDS-VERIFY',
    targetRepo: typeof finding.targetRepo === 'string' ? finding.targetRepo : '',
    targetHead: typeof finding.targetHead === 'string' ? finding.targetHead : '',
    graphIndexId: typeof finding.graphIndexId === 'string' ? finding.graphIndexId : '',
    claimedEvidence: Array.isArray(finding.claimedEvidence) ? finding.claimedEvidence : [],
    verifiedEvidence: Array.isArray(finding.verifiedEvidence) ? finding.verifiedEvidence : [],
    negativeEvidence: Array.isArray(finding.negativeEvidence) ? finding.negativeEvidence : [],
    reasonCodes: Array.isArray(finding.reasonCodes) ? finding.reasonCodes : [],
    statusTransitionEvidence: Array.isArray(finding.statusTransitionEvidence)
      ? finding.statusTransitionEvidence
      : [],
    verifiedAt: finding.verifiedAt ?? null,
    verifiedHead: finding.verifiedHead ?? null,
    verificationKind: finding.verificationKind ?? null,
    reopenTrigger: finding.reopenTrigger ?? null,
    blocker: finding.blocker ?? null,
    tombstoneMatch: finding.tombstoneMatch ?? null,
    metadata:
      typeof finding.metadata === 'object' && finding.metadata !== null ? finding.metadata : {},
  };
}

function safeEvidencePaths(
  evidence: AuditLintFinding['verifiedEvidence'] | undefined,
): Array<string | undefined> {
  return Array.isArray(evidence) ? evidence.map((item) => item.path) : [];
}

export async function loadAuditBundles(
  repoPath: string,
  sessionId: string,
): Promise<AuditLintBundle[]> {
  const state = await new LocalAuditEventStore(repoPath).load();
  return state.events
    .filter((event) => event.type === 'FindingBundled')
    .filter((event) => event.sessionId === sessionId)
    .map((event) => toLintBundle(event.bundle));
}

function toLintBundle(bundle: AuditBundle): AuditLintBundle {
  return {
    ...bundle,
    tests: stringArray(bundle.metadata.tests),
    impactTargets: stringArray(bundle.metadata.impactTargets),
    metadata: bundle.metadata,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function sortAuditIssues(issues: readonly AuditLintIssue[]): AuditLintIssue[] {
  return [...issues].sort((a, b) => {
    const aKey = [a.scope, a.ruleId, a.findingId ?? '', a.bundleId ?? '', a.message].join('\u0000');
    const bKey = [b.scope, b.ruleId, b.findingId ?? '', b.bundleId ?? '', b.message].join('\u0000');
    return aKey.localeCompare(bKey);
  });
}

function summarizeIssue(issue: AuditLintIssue): Record<string, unknown> {
  return {
    ruleId: issue.ruleId,
    scope: issue.scope,
    severity: issue.severity,
    message: issue.message,
    ...(issue.findingId ? { findingId: issue.findingId } : {}),
    ...(issue.bundleId ? { bundleId: issue.bundleId } : {}),
    ...(issue.suggestedStatus ? { suggestedStatus: issue.suggestedStatus } : {}),
  };
}

function createAuditLintNextAction(
  ok: boolean,
  advisory: boolean | undefined,
  cursor: McpResponseCursor | undefined,
  policyDisclosure: ReturnType<typeof createPolicyFilter>['disclosure'],
): string {
  if (cursor?.next) {
    return `Rerun audit lint with cursor:"${cursor.next}" to fetch the next page.`;
  }
  if (!ok && !advisory)
    return 'Fix reported lint issues or rerun with advisory:true for informational mode.';
  if (policyDisclosure.excludedPathCount > 0) {
    return 'Rerun with includeIgnored:true if you need vendor/generated findings in this report.';
  }
  return 'No follow-up required.';
}

function countBy<T>(items: readonly T[], getKey: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
