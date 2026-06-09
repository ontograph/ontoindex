import type {
  AuditLintBundle,
  AuditLintFinding,
  AuditLintIssue,
} from '../core/audit-lifecycle/index.js';
import type { AuditEvidence } from '../core/audit-lifecycle/audit-types.js';
import type {
  AuditScopeGuardIssue,
  AuditScopeGuardResult,
} from '../core/audit-lifecycle/scope-guard.js';
import { resolveRepositoryPolicy } from '../core/repository-policy.js';

export type AuditCiGateMode = 'advisory' | 'blocking';

export interface AuditCiGate {
  mode: AuditCiGateMode;
  source: 'default-advisory' | 'repo-policy';
  warnings: string[];
  policy: {
    blockOnStaleOpen: boolean;
    severityThreshold?: string;
  };
}

export interface AuditIssueLocation {
  path: string;
  line?: number;
  symbol?: string;
  source:
    | 'claim'
    | 'verified-evidence'
    | 'negative-evidence'
    | 'transition-evidence'
    | 'bundle-file'
    | 'bundle-write-set'
    | 'bundle-test'
    | 'scope-change';
}

export interface EnrichedAuditLintIssue extends AuditLintIssue {
  locations: AuditIssueLocation[];
}

type AuditLintCliReport = Record<string, unknown> & {
  action: 'audit-lint';
  advisory?: boolean;
  exitRecommendation?: 'zero' | 'nonzero';
  issues?: AuditLintIssue[];
  warnings?: string[];
};

type AuditVerifyCliFinding = {
  findingId?: string;
  title?: string;
  status?: string;
  statusReason?: string;
  claimDsl?: { path?: string; symbol?: string } | null;
  claimedEvidence?: string[];
  evidence?: AuditEvidence[];
  negativeEvidence?: AuditEvidence[];
  comments?: unknown[];
  testMentions?: unknown[];
  fixHistory?: unknown[];
  reasonCodes?: unknown[];
  fixCommit?: string | null;
};

type AuditVerifyCliReport = Record<string, unknown> & {
  action: 'audit-verify';
  findings?: AuditVerifyCliFinding[];
  warnings?: string[];
};

type SarifLevel = 'error' | 'warning' | 'note';

export async function resolveAuditCiGate(
  repoPath: string,
  options: {
    advisory?: boolean;
    strict?: boolean;
  },
): Promise<AuditCiGate> {
  const resolved = await resolveRepositoryPolicy({ repoPath });
  const blocking = resolved.policy.audit.blockOnStaleOpen === true;
  const warnings: string[] = [];

  if (options.strict === true && !blocking) {
    warnings.push(
      'Ignoring --strict: blocking mode is controlled by .ontoindex/policy.json audit.blockOnStaleOpen=true.',
    );
  }
  if (options.advisory === true && blocking) {
    warnings.push(
      'Ignoring --advisory: repository policy enabled blocking mode for audit trust gates.',
    );
  }

  return {
    mode: blocking ? 'blocking' : 'advisory',
    source: blocking ? 'repo-policy' : 'default-advisory',
    warnings,
    policy: {
      blockOnStaleOpen: blocking,
      ...(typeof resolved.policy.audit.severityThreshold === 'string'
        ? { severityThreshold: resolved.policy.audit.severityThreshold }
        : {}),
    },
  };
}

export function withAuditCiGate(report: AuditLintCliReport, gate: AuditCiGate): AuditLintCliReport {
  return {
    ...report,
    advisory: gate.mode === 'advisory',
    exitRecommendation:
      gate.mode === 'blocking' && report.exitRecommendation === 'nonzero' ? 'nonzero' : 'zero',
    warnings: [...arrayOfStrings(report.warnings), ...gate.warnings],
    gate,
  };
}

export function enrichAuditLintIssues(
  issues: readonly AuditLintIssue[],
  findings: readonly AuditLintFinding[],
  bundles: readonly AuditLintBundle[],
): EnrichedAuditLintIssue[] {
  const findingMap = new Map(findings.map((finding) => [finding.findingId, finding]));
  const bundleMap = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  return issues.map((issue) => ({
    ...issue,
    locations:
      (issue.findingId ? collectFindingLocations(findingMap.get(issue.findingId)) : undefined) ??
      (issue.bundleId ? collectBundleLocations(bundleMap.get(issue.bundleId)) : undefined) ??
      [],
  }));
}

export function formatAuditLintSarif(
  report: AuditLintCliReport,
  context: {
    findings: readonly AuditLintFinding[];
    bundles: readonly AuditLintBundle[];
    gate: AuditCiGate;
  },
): Record<string, unknown> {
  const enriched = enrichAuditLintIssues(report.issues ?? [], context.findings, context.bundles);
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'OntoIndex Audit Lint',
            rules: buildSarifRules(
              enriched.map((issue) => ({
                ruleId: issue.ruleId,
                level: severityToSarifLevel(issue.severity),
                description: issue.message,
              })),
            ),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            properties: {
              action: report.action,
              advisory: context.gate.mode === 'advisory',
              gateMode: context.gate.mode,
            },
          },
        ],
        results: enriched.map((issue) => ({
          ruleId: issue.ruleId,
          level: severityToSarifLevel(issue.severity),
          message: {
            text: issue.message,
          },
          ...(issue.locations.length > 0 ? { locations: sarifLocations(issue.locations) } : {}),
          partialFingerprints: {
            ...(issue.findingId ? { findingId: issue.findingId } : {}),
            ...(issue.bundleId ? { bundleId: issue.bundleId } : {}),
          },
          properties: {
            scope: issue.scope,
            ...(issue.suggestedStatus ? { suggestedStatus: issue.suggestedStatus } : {}),
            gateMode: context.gate.mode,
            locationCount: issue.locations.length,
            evidencePaths: issue.locations.map(formatLocation),
          },
        })),
      },
    ],
  };
}

export function formatAuditVerifySarif(report: AuditVerifyCliReport): Record<string, unknown> {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'OntoIndex Audit Verify',
            rules: buildSarifRules(
              findings.map((finding) => ({
                ruleId: verifyRuleId(finding.status),
                level: statusToSarifLevel(finding.status),
                description: finding.title ?? finding.status ?? 'Audit finding',
              })),
            ),
          },
        },
        results: findings.map((finding) => {
          const locations = collectVerifyLocations(finding);
          return {
            ruleId: verifyRuleId(finding.status),
            level: statusToSarifLevel(finding.status),
            message: {
              text: `${finding.title ?? 'Audit finding'} (${finding.status ?? 'unknown'})${
                finding.statusReason ? `: ${finding.statusReason}` : ''
              }`,
            },
            ...(locations.length > 0 ? { locations: sarifLocations(locations) } : {}),
            partialFingerprints: {
              ...(finding.findingId ? { findingId: finding.findingId } : {}),
            },
            properties: {
              status: finding.status,
              statusReason: finding.statusReason,
              fixCommit: finding.fixCommit,
              reasonCodes: arrayOfStrings(finding.reasonCodes),
              comments: arrayLength(finding.comments),
              testMentions: arrayLength(finding.testMentions),
              fixHistory: arrayLength(finding.fixHistory),
            },
          };
        }),
      },
    ],
  };
}

export function formatScopeGuardSarif(result: AuditScopeGuardResult): Record<string, unknown> {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'OntoIndex Scope Guard',
            rules: buildSarifRules(
              result.issues.map((issue) => ({
                ruleId: `scope-guard/${issue.kind}`,
                level: 'error',
                description: issue.message,
              })),
            ),
          },
        },
        results: result.issues.map((issue) => {
          const locations = collectScopeGuardLocations(issue);
          return {
            ruleId: `scope-guard/${issue.kind}`,
            level: 'error',
            message: { text: issue.message },
            ...(locations.length > 0 ? { locations: sarifLocations(locations) } : {}),
            partialFingerprints: {
              bundleId: result.bundleId,
              issueValue: issue.value,
            },
            properties: {
              kind: issue.kind,
              bundleIds: issue.bundleIds ?? [result.bundleId],
            },
          };
        }),
      },
    ],
  };
}

export function formatAuditLintJUnit(
  report: AuditLintCliReport,
  context: {
    findings: readonly AuditLintFinding[];
    bundles: readonly AuditLintBundle[];
    gate: AuditCiGate;
  },
): string {
  const enriched = enrichAuditLintIssues(report.issues ?? [], context.findings, context.bundles);
  const tests = Math.max(enriched.length, 1);
  const failures = context.gate.mode === 'blocking' ? enriched.length : 0;
  const skipped = context.gate.mode === 'advisory' ? enriched.length : 0;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${tests}" failures="${failures}" skipped="${skipped}">`,
    `  <testsuite name="ontoindex.audit-lint" tests="${tests}" failures="${failures}" skipped="${skipped}">`,
  ];

  if (enriched.length === 0) {
    lines.push('    <testcase classname="ontoindex.audit-lint" name="audit-trust-gates-clean" />');
  } else {
    for (const issue of enriched) {
      lines.push(
        `    <testcase classname="${xmlAttr(`ontoindex.audit-lint.${issue.scope}`)}" name="${xmlAttr(junitCaseName(issue))}">`,
      );
      const detail = junitIssueDetail(issue, context.gate);
      if (context.gate.mode === 'blocking') {
        lines.push(
          `      <failure message="${xmlAttr(issue.message)}">${xmlText(detail)}</failure>`,
        );
      } else {
        lines.push(
          `      <skipped message="${xmlAttr('advisory mode')}">${xmlText(detail)}</skipped>`,
        );
      }
      lines.push(`      <system-out>${xmlText(detail)}</system-out>`);
      lines.push('    </testcase>');
    }
  }

  if (context.gate.warnings.length > 0) {
    lines.push(`    <system-out>${xmlText(context.gate.warnings.join('\n'))}</system-out>`);
  }
  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return lines.join('\n');
}

function collectFindingLocations(finding: AuditLintFinding | undefined): AuditIssueLocation[] {
  if (!finding) return [];
  const seen = new Set<string>();
  const locations: AuditIssueLocation[] = [];
  const add = (location: AuditIssueLocation | undefined) => {
    if (!location) return;
    const key = `${location.source}\u0000${location.path}\u0000${location.line ?? ''}\u0000${location.symbol ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(location);
  };

  add(
    typeof finding.claimDsl?.path === 'string'
      ? {
          path: finding.claimDsl.path,
          symbol: finding.claimDsl.symbol,
          source: 'claim',
        }
      : undefined,
  );
  for (const evidence of finding.verifiedEvidence ?? []) {
    add(toEvidenceLocation(evidence, 'verified-evidence'));
  }
  for (const evidence of finding.negativeEvidence ?? []) {
    add(toEvidenceLocation(evidence, 'negative-evidence'));
  }
  for (const evidence of finding.statusTransitionEvidence ?? []) {
    add(toEvidenceLocation(evidence, 'transition-evidence'));
  }
  return locations;
}

function collectBundleLocations(bundle: AuditLintBundle | undefined): AuditIssueLocation[] {
  if (!bundle) return [];
  const locations: AuditIssueLocation[] = [];
  const metadata = bundle.metadata as Record<string, unknown>;
  const addAll = (items: readonly string[] | undefined, source: AuditIssueLocation['source']) => {
    for (const item of items ?? []) {
      if (item.trim().length === 0) continue;
      locations.push({ path: item, source });
    }
  };
  addAll(stringArray(metadata.files), 'bundle-file');
  addAll(stringArray(metadata.writeSet), 'bundle-write-set');
  addAll(bundle.tests, 'bundle-test');
  addAll(stringArray(metadata.tests), 'bundle-test');
  return dedupeLocations(locations);
}

function collectVerifyLocations(finding: AuditVerifyCliFinding): AuditIssueLocation[] {
  return dedupeLocations([
    ...(typeof finding.claimDsl?.path === 'string'
      ? [
          {
            path: finding.claimDsl.path,
            ...(typeof finding.claimDsl.symbol === 'string' && finding.claimDsl.symbol.length > 0
              ? { symbol: finding.claimDsl.symbol }
              : {}),
            source: 'claim' as const,
          },
        ]
      : []),
    ...collectEvidenceLocations(finding.evidence, 'verified-evidence'),
    ...collectEvidenceLocations(finding.negativeEvidence, 'negative-evidence'),
  ]);
}

function collectScopeGuardLocations(issue: AuditScopeGuardIssue): AuditIssueLocation[] {
  if (!looksLikePath(issue.value)) return [];
  return [{ path: issue.value, source: 'scope-change' }];
}

function collectEvidenceLocations(
  evidence: AuditEvidence[] | undefined,
  source: AuditIssueLocation['source'],
): AuditIssueLocation[] {
  return (evidence ?? [])
    .map((item) => toEvidenceLocation(item, source))
    .filter((item): item is AuditIssueLocation => item !== undefined);
}

function toEvidenceLocation(
  evidence: Pick<AuditEvidence, 'path' | 'line' | 'symbol'>,
  source: AuditIssueLocation['source'],
): AuditIssueLocation | undefined {
  if (typeof evidence.path !== 'string' || evidence.path.trim().length === 0) return undefined;
  return {
    path: evidence.path,
    ...(typeof evidence.line === 'number' ? { line: evidence.line } : {}),
    ...(typeof evidence.symbol === 'string' && evidence.symbol.length > 0
      ? { symbol: evidence.symbol }
      : {}),
    source,
  };
}

function dedupeLocations(locations: readonly AuditIssueLocation[]): AuditIssueLocation[] {
  const seen = new Set<string>();
  const deduped: AuditIssueLocation[] = [];
  for (const location of locations) {
    const key = `${location.source}\u0000${location.path}\u0000${location.line ?? ''}\u0000${location.symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(location);
  }
  return deduped;
}

function verifyRuleId(status: string | undefined): string {
  return `audit-verify/${(status ?? 'unknown').toLowerCase()}`;
}

function severityToSarifLevel(severity: string | undefined): SarifLevel {
  return severity === 'warning' ? 'warning' : 'error';
}

function statusToSarifLevel(status: string | undefined): SarifLevel {
  switch (status) {
    case 'RESOLVED-ALREADY':
    case 'FALSE-POSITIVE':
      return 'note';
    case 'OPEN':
    case 'PARTIAL':
    case 'HOLD':
    case 'NEEDS-VERIFY':
    case 'NEEDS-REVERIFY':
      return 'error';
    default:
      return 'warning';
  }
}

function buildSarifRules(rules: Array<{ ruleId: string; level: SarifLevel; description: string }>) {
  const seen = new Set<string>();
  return rules.flatMap((rule) => {
    if (seen.has(rule.ruleId)) return [];
    seen.add(rule.ruleId);
    return [
      {
        id: rule.ruleId,
        shortDescription: { text: rule.description },
        defaultConfiguration: { level: rule.level },
      },
    ];
  });
}

function sarifLocations(locations: readonly AuditIssueLocation[]) {
  return locations.map((location) => ({
    physicalLocation: {
      artifactLocation: {
        uri: location.path,
      },
      ...(typeof location.line === 'number'
        ? {
            region: {
              startLine: location.line,
            },
          }
        : {}),
    },
    ...(location.symbol
      ? {
          logicalLocations: [
            {
              kind: 'symbol',
              name: location.symbol,
            },
          ],
        }
      : {}),
  }));
}

function junitCaseName(issue: AuditLintIssue): string {
  return [issue.ruleId, issue.findingId ?? issue.bundleId ?? 'gate'].join(' ');
}

function junitIssueDetail(issue: EnrichedAuditLintIssue, gate: AuditCiGate): string {
  const lines = [
    `ruleId: ${issue.ruleId}`,
    `scope: ${issue.scope}`,
    `severity: ${issue.severity}`,
    `message: ${issue.message}`,
    `gateMode: ${gate.mode}`,
  ];
  if (issue.findingId) lines.push(`findingId: ${issue.findingId}`);
  if (issue.bundleId) lines.push(`bundleId: ${issue.bundleId}`);
  if (issue.suggestedStatus) lines.push(`suggestedStatus: ${issue.suggestedStatus}`);
  if (issue.locations.length > 0) {
    lines.push('locations:');
    for (const location of issue.locations) {
      lines.push(`- ${formatLocation(location)}`);
    }
  }
  return lines.join('\n');
}

function formatLocation(location: AuditIssueLocation): string {
  return `${location.path}${typeof location.line === 'number' ? `:${location.line}` : ''}${
    location.symbol ? ` (${location.symbol})` : ''
  } [${location.source}]`;
}

function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.includes('.');
}
