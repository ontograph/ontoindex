import type {
  AuditEvidence,
  AuditFinding,
  AuditLifecycleStatus,
  VerificationKind,
} from './audit-types.js';
import type { AuditBundle } from './audit-session.js';
import {
  evaluateFreshnessGatePolicy,
  type AuditFreshnessPolicyInput,
} from '../../mcp/shared/freshness-policy.js';

export type AuditLintSeverity = 'error' | 'warning';
export type AuditLintExitRecommendation = 'zero' | 'nonzero';
export type AuditLintScope = 'report' | 'bundle';

export interface AuditLintFinding extends Omit<
  AuditFinding,
  'status' | 'verificationKind' | 'reopenTrigger' | 'blocker'
> {
  status: AuditLifecycleStatus | 'STILL-OPEN' | string;
  verificationKind?: VerificationKind | string | null;
  reopenTrigger?: AuditFinding['reopenTrigger'];
  blocker?: AuditFinding['blocker'];
  bundleId?: string;
  implementationWorkId?: string;
  rootCauseId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLintBundle extends AuditBundle {
  tests?: string[];
  impactTargets?: string[];
  metadata: Record<string, unknown>;
}

export interface AuditLintIssue {
  ruleId: string;
  scope: AuditLintScope;
  severity: AuditLintSeverity;
  message: string;
  findingId?: string;
  bundleId?: string;
  suggestedStatus?: AuditLifecycleStatus;
}

export interface AuditLintOptions {
  advisory?: boolean;
  freshnessPolicy?: AuditFreshnessPolicyInput;
}

export interface AuditReportLintInput {
  findings: readonly AuditLintFinding[];
}

export interface AuditBundleLintInput {
  bundles: readonly AuditLintBundle[];
}

export interface AuditLintResult {
  ok: boolean;
  advisory: boolean;
  exitRecommendation: AuditLintExitRecommendation;
  issues: AuditLintIssue[];
}

export interface AuditLintRule<TInput> {
  id: string;
  scope: AuditLintScope;
  lint(input: TInput): AuditLintIssue[];
}

export const REPORT_LINT_RULES: readonly AuditLintRule<AuditReportLintInput>[] = [
  {
    id: 'open-requires-fresh-evidence',
    scope: 'report',
    lint({ findings }) {
      return findings
        .filter((finding) => finding.status === 'OPEN' && !hasFreshPositiveEvidence(finding))
        .map((finding) =>
          reportIssue(
            'open-requires-fresh-evidence',
            finding,
            'OPEN findings require fresh positive evidence at targetHead.',
            'NEEDS-VERIFY',
          ),
        );
    },
  },
  {
    id: 'no-still-open-status',
    scope: 'report',
    lint({ findings }) {
      return findings
        .filter((finding) => finding.status === 'STILL-OPEN')
        .map((finding) =>
          reportIssue(
            'no-still-open-status',
            finding,
            'STILL-OPEN is not a lifecycle status; use OPEN only after fresh verification.',
            'NEEDS-VERIFY',
          ),
        );
    },
  },
  {
    id: 'no-line-only-open',
    scope: 'report',
    lint({ findings }) {
      return findings
        .filter((finding) => finding.status === 'OPEN' && isLineOnlyOpenFinding(finding))
        .map((finding) =>
          reportIssue(
            'no-line-only-open',
            finding,
            'OPEN findings cannot rely only on file/line references.',
            'NEEDS-VERIFY',
          ),
        );
    },
  },
  {
    id: 'runtime-open-requires-runtime-evidence',
    scope: 'report',
    lint({ findings }) {
      return findings
        .filter(
          (finding) =>
            finding.status === 'OPEN' &&
            requiresRuntimeEvidence(finding) &&
            !finding.verifiedEvidence.some(isRuntimeEvidence),
        )
        .map((finding) =>
          reportIssue(
            'runtime-open-requires-runtime-evidence',
            finding,
            'Runtime-only OPEN findings require runtime evidence.',
            'HOLD',
          ),
        );
    },
  },
  {
    id: 'no-duplicate-root-cause-work',
    scope: 'report',
    lint({ findings }) {
      const issues: AuditLintIssue[] = [];
      const implementationFindings = findings.filter(isImplementationWorkFinding);
      const byRootCause = new Map<string, AuditLintFinding[]>();
      for (const finding of implementationFindings) {
        const rootCause = rootCauseKey(finding);
        if (rootCause === null) continue;
        const group = byRootCause.get(rootCause) ?? [];
        group.push(finding);
        byRootCause.set(rootCause, group);
      }
      for (const group of byRootCause.values()) {
        const workIds = new Set(group.map(implementationWorkKey));
        if (group.length <= 1 || workIds.size <= 1) continue;
        for (const finding of group) {
          issues.push(
            reportIssue(
              'no-duplicate-root-cause-work',
              finding,
              'Duplicate root-cause findings must not become separate implementation work.',
            ),
          );
        }
      }
      return issues;
    },
  },
  {
    id: 'no-tombstone-reopen-while-invariant-holds',
    scope: 'report',
    lint({ findings }) {
      return findings
        .filter(
          (finding) =>
            finding.status === 'OPEN' &&
            finding.tombstoneMatch !== null &&
            tombstoneInvariantHolds(finding),
        )
        .map((finding) =>
          reportIssue(
            'no-tombstone-reopen-while-invariant-holds',
            finding,
            'Tombstoned findings cannot reopen while the fix invariant still holds.',
            'RESOLVED-ALREADY',
          ),
        );
    },
  },
  {
    id: 'hold-requires-verification-and-reopen-trigger',
    scope: 'report',
    lint({ findings }) {
      return findings
        .filter(
          (finding) =>
            finding.status === 'HOLD' &&
            (finding.verificationKind === null ||
              finding.verificationKind === undefined ||
              finding.reopenTrigger === null ||
              finding.reopenTrigger === undefined),
        )
        .map((finding) =>
          reportIssue(
            'hold-requires-verification-and-reopen-trigger',
            finding,
            'Every HOLD finding requires a verification kind and reopen trigger.',
            'NEEDS-VERIFY',
          ),
        );
    },
  },
];

export const BUNDLE_LINT_RULES: readonly AuditLintRule<AuditBundleLintInput>[] = [
  {
    id: 'bundle-requires-tests',
    scope: 'bundle',
    lint({ bundles }) {
      return bundles
        .filter((bundle) => listMetadataStrings(bundle, 'tests').length === 0)
        .map((bundle) =>
          bundleIssue(
            'bundle-requires-tests',
            bundle,
            'Every audit bundle must declare tests before dispatch.',
          ),
        );
    },
  },
  {
    id: 'bundle-requires-impact-targets',
    scope: 'bundle',
    lint({ bundles }) {
      return bundles
        .filter((bundle) => listMetadataStrings(bundle, 'impactTargets').length === 0)
        .map((bundle) =>
          bundleIssue(
            'bundle-requires-impact-targets',
            bundle,
            'Every audit bundle must declare impact targets before dispatch.',
          ),
        );
    },
  },
];

export function lintAuditReport(
  input: AuditReportLintInput,
  options: AuditLintOptions = {},
): AuditLintResult {
  return finalizeLintResult(
    [...flatMapRules(REPORT_LINT_RULES, input), ...freshnessPolicyFindingIssues(input, options)],
    options,
  );
}

export function lintAuditBundles(
  input: AuditBundleLintInput,
  options: AuditLintOptions = {},
): AuditLintResult {
  return finalizeLintResult(
    [...flatMapRules(BUNDLE_LINT_RULES, input), ...freshnessPolicyBundleIssues(input, options)],
    options,
  );
}

export function lintAuditLifecycle(
  input: AuditReportLintInput & Partial<AuditBundleLintInput>,
  options: AuditLintOptions = {},
): AuditLintResult {
  const reportIssues = [
    ...flatMapRules(REPORT_LINT_RULES, input),
    ...freshnessPolicyFindingIssues(input, options),
  ];
  const bundleIssues =
    input.bundles === undefined
      ? []
      : [
          ...flatMapRules(BUNDLE_LINT_RULES, { bundles: input.bundles }),
          ...freshnessPolicyBundleIssues({ bundles: input.bundles }, options),
        ];
  return finalizeLintResult([...reportIssues, ...bundleIssues], options);
}

function flatMapRules<TInput>(
  rules: readonly AuditLintRule<TInput>[],
  input: TInput,
): AuditLintIssue[] {
  return rules.flatMap((rule) => rule.lint(input));
}

function finalizeLintResult(
  issues: readonly AuditLintIssue[],
  options: AuditLintOptions,
): AuditLintResult {
  const advisory = options.advisory === true;
  const normalizedIssues = advisory
    ? issues.map((issue) => ({ ...issue, severity: 'warning' as const }))
    : [...issues];
  return {
    ok: normalizedIssues.length === 0,
    advisory,
    exitRecommendation: normalizedIssues.length > 0 && !advisory ? 'nonzero' : 'zero',
    issues: normalizedIssues,
  };
}

function reportIssue(
  ruleId: string,
  finding: AuditLintFinding,
  message: string,
  suggestedStatus?: AuditLifecycleStatus,
): AuditLintIssue {
  return {
    ruleId,
    scope: 'report',
    severity: 'error',
    message,
    findingId: finding.findingId,
    ...(suggestedStatus !== undefined ? { suggestedStatus } : {}),
  };
}

function bundleIssue(ruleId: string, bundle: AuditLintBundle, message: string): AuditLintIssue {
  return {
    ruleId,
    scope: 'bundle',
    severity: 'error',
    message,
    bundleId: bundle.id,
  };
}

function freshnessPolicyFindingIssues(
  input: AuditReportLintInput,
  options: AuditLintOptions,
): AuditLintIssue[] {
  if (options.freshnessPolicy === undefined) return [];
  return input.findings
    .filter((finding) => finding.status === 'OPEN')
    .filter(
      (finding) =>
        !evaluateFreshnessGatePolicy({
          ...options.freshnessPolicy,
          evidenceTargetHead: finding.verifiedEvidence[0]?.targetHead,
        }).allowOpen,
    )
    .map((finding) =>
      reportIssue(
        'freshness-policy-blocks-open',
        finding,
        'Freshness policy blocks OPEN findings from becoming dispatchable work.',
        'NEEDS-REVERIFY',
      ),
    );
}

function freshnessPolicyBundleIssues(
  input: AuditBundleLintInput,
  options: AuditLintOptions,
): AuditLintIssue[] {
  if (options.freshnessPolicy === undefined) return [];
  const decision = evaluateFreshnessGatePolicy(options.freshnessPolicy);
  if (decision.dispatchable) return [];
  return input.bundles.map((bundle) =>
    bundleIssue(
      'freshness-policy-blocks-dispatch',
      bundle,
      'Freshness policy marks this bundle non-dispatchable.',
    ),
  );
}

function hasFreshPositiveEvidence(finding: AuditLintFinding): boolean {
  return (
    finding.verifiedAt !== null &&
    finding.verifiedHead === finding.targetHead &&
    finding.verifiedEvidence.some(
      (evidence) =>
        evidence.polarity === 'positive' &&
        evidence.targetHead === finding.targetHead &&
        evidence.verifiedHead === finding.targetHead,
    )
  );
}

function isLineOnlyOpenFinding(finding: AuditLintFinding): boolean {
  if (finding.claimDsl?.symbol || finding.verifiedEvidence.some((evidence) => evidence.symbol)) {
    return false;
  }
  return (
    finding.claimedEvidence.length > 0 &&
    finding.claimedEvidence.every((claim) => /^[^:\s]+:\d+(?::\d+)?(?:\s|$)/u.test(claim.trim()))
  );
}

function requiresRuntimeEvidence(finding: AuditLintFinding): boolean {
  return (
    finding.claimDsl?.requiresRuntime === true ||
    finding.claimDsl?.evidenceMode === 'runtime' ||
    finding.verificationKind === 'runtime' ||
    finding.verificationKind === 'dynamic'
  );
}

function isRuntimeEvidence(evidence: AuditEvidence): boolean {
  return evidence.mode === 'runtime' && evidence.polarity === 'positive';
}

function isImplementationWorkFinding(finding: AuditLintFinding): boolean {
  return ['OPEN', 'PARTIAL', 'BUNDLED', 'DISPATCHED'].includes(finding.status);
}

function rootCauseKey(finding: AuditLintFinding): string | null {
  const metadataRootCause =
    metadataString(finding, 'rootCauseId') ?? metadataString(finding, 'rootCause');
  return finding.rootCauseId ?? metadataRootCause ?? finding.fingerprint.history ?? null;
}

function implementationWorkKey(finding: AuditLintFinding): string {
  return (
    finding.bundleId ??
    finding.implementationWorkId ??
    metadataString(finding, 'bundleId') ??
    metadataString(finding, 'implementationWorkId') ??
    finding.findingId
  );
}

function tombstoneInvariantHolds(finding: AuditLintFinding): boolean {
  const value =
    finding.metadata?.['tombstoneInvariantHolds'] ??
    finding.metadata?.['invariantHolds'] ??
    finding.metadata?.['fixInvariantHolds'];
  return value !== false;
}

function metadataString(finding: AuditLintFinding, key: string): string | undefined {
  const value = finding.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function listMetadataStrings(bundle: AuditLintBundle, key: 'tests' | 'impactTargets'): string[] {
  const ownValue = bundle[key];
  if (Array.isArray(ownValue) && ownValue.every((item) => typeof item === 'string')) {
    return ownValue;
  }
  const metadataValue = bundle.metadata[key];
  if (Array.isArray(metadataValue) && metadataValue.every((item) => typeof item === 'string')) {
    return metadataValue;
  }
  return [];
}
