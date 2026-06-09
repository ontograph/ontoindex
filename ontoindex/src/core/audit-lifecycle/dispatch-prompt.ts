import type { AuditImplementationBundle } from './audit-bundle.js';
import type { AuditFinding, AuditSession, AuditSnapshotMode } from './audit-session.js';
import {
  evaluateFreshnessGatePolicy,
  freshnessGateErrorMessage,
  type AuditFreshnessPolicyInput,
} from '../../mcp/shared/freshness-policy.js';

export type AuditDispatchRedactionMode = 'none' | 'paths' | 'snippets' | 'sensitive';

export interface AuditDispatchSourceSnippet {
  path: string;
  symbol?: string;
  content: string;
}

export interface AuditDispatchPromptInput {
  session: Pick<AuditSession, 'id' | 'targetRepo' | 'targetHead' | 'sourceHash'> &
    Partial<Pick<AuditSession, 'snapshotMode' | 'snapshot' | 'staleWarnings'>>;
  bundles: readonly AuditImplementationBundle[];
  findings?: readonly AuditFinding[];
  bundleId?: string;
  verificationTimestamp: string;
  redactionMode?: AuditDispatchRedactionMode;
  impactChecks?: readonly string[];
  sourceSnippets?: readonly AuditDispatchSourceSnippet[];
  allowUnverifiedFindings?: boolean;
  allowRuntimeOnlyFindings?: boolean;
  freshnessPolicy?: AuditFreshnessPolicyInput;
}

export interface AuditDispatchPromptResult {
  bundleId: string;
  targetHead: string;
  snapshotMode?: AuditSnapshotMode;
  staleWarnings?: string[];
  verificationTimestamp: string;
  redactionMode: AuditDispatchRedactionMode;
  prompt: string;
}

const PLACEHOLDER_PATTERNS = [
  /\bTBD\b/iu,
  /\bTODO\b/iu,
  /\bFIXME\b/iu,
  /\bPLACEHOLDER\b/iu,
  /\bREPLACE_ME\b/iu,
  /<[^>\n]+>/u,
  /\{\{[^}\n]+\}\}/u,
  /__[^_\n]+__/u,
];

export function generateAuditDispatchPrompt(
  input: AuditDispatchPromptInput,
): AuditDispatchPromptResult {
  const redactionMode = input.redactionMode ?? 'sensitive';
  const bundle = selectSingleBundle(input.bundles, input.bundleId);
  const verificationTimestamp = toIsoTimestamp(
    input.verificationTimestamp,
    'verificationTimestamp',
  );
  const findingById = new Map((input.findings ?? []).map((finding) => [finding.id, finding]));
  const bundleFindings = bundle.findingIds
    .map((findingId) => findingById.get(findingId))
    .filter((finding): finding is AuditFinding => finding !== undefined);
  const snapshotMode =
    input.session.snapshot?.mode ?? input.session.snapshotMode ?? bundle.snapshotMode;
  const staleWarnings = sortedStrings([
    ...(input.session.snapshot?.staleWarnings ?? []),
    ...(input.session.staleWarnings ?? []),
    ...(bundle.staleWarnings ?? []),
  ]);

  if (input.findings !== undefined) {
    const missingFindingIds = bundle.findingIds.filter((findingId) => !findingById.has(findingId));
    if (missingFindingIds.length > 0) {
      throw new Error(
        `dispatch bundle references missing findings: ${missingFindingIds.join(', ')}`,
      );
    }
  }

  if (input.freshnessPolicy !== undefined) {
    const decision = evaluateFreshnessGatePolicy({
      ...input.freshnessPolicy,
      evidenceTargetHead: bundleFindings[0]?.verification?.evidence[0]?.targetHead,
    });
    if (!decision.dispatchable) {
      throw new Error(freshnessGateErrorMessage(decision));
    }
  }

  if (input.allowUnverifiedFindings !== true) {
    const unverified = bundleFindings.filter((finding) => !isImplementationVerified(finding));
    if (unverified.length > 0) {
      throw new Error(
        `dispatch implementation prompt refused for unverified findings: ${unverified
          .map((finding) => finding.id)
          .sort()
          .join(', ')}`,
      );
    }
  }

  if (input.allowRuntimeOnlyFindings !== true) {
    const runtimeOnly = bundleFindings.filter(isRuntimeOnlyFinding);
    if (runtimeOnly.length > 0) {
      throw new Error(
        `dispatch implementation prompt refused for runtime-only findings: ${runtimeOnly
          .map((finding) => finding.id)
          .sort()
          .join(', ')}`,
      );
    }
  }

  const redactor = createRedactor(redactionMode);
  const prompt = [
    'Audit Lifecycle Dispatch Prompt',
    '',
    'Hard requirements:',
    '- Implement exactly one audit bundle.',
    '- Do not implement any finding outside this bundle.',
    '- Do not use placeholders in code, tests, commit text, or handoff notes.',
    '- Stop instead of guessing when evidence, scope, target HEAD, or verification data is missing.',
    '',
    'Bundle:',
    `- Bundle id: ${bundle.id}`,
    `- Session id: ${input.session.id}`,
    `- Target repo: ${redactor(input.session.targetRepo)}`,
    `- Target HEAD: ${input.session.targetHead}`,
    ...(snapshotMode !== undefined ? [`- Snapshot mode: ${snapshotMode}`] : []),
    ...(staleWarnings.length > 0
      ? [`- Stale warnings: ${redactor(staleWarnings.join('; '))}`]
      : []),
    `- Source hash: ${input.session.sourceHash}`,
    `- Verification timestamp: ${verificationTimestamp}`,
    `- Redaction mode: ${redactionMode}`,
    `- Finding ids: ${formatList(bundle.findingIds)}`,
    `- Root cause: ${redactor(bundle.rootCause.title)}`,
    '',
    'Scope:',
    ...formatBullets(redactValues([...bundle.files, ...bundle.writeSet], redactor)),
    '',
    'Symbols:',
    ...formatBullets(bundle.symbols.map(redactor)),
    '',
    'Non-scope:',
    ...formatBullets(bundle.nonScope.map(redactor)),
    '',
    'Required tests:',
    ...formatBullets(redactValues(bundle.tests, redactor)),
    '',
    'Required impact checks:',
    ...formatBullets((input.impactChecks ?? defaultImpactChecks(bundle)).map(redactor)),
    '',
    'Stop conditions:',
    ...formatBullets(defaultStopConditions(input.session.targetHead, bundle).map(redactor)),
    '',
    'Source snippets:',
    ...formatSnippets(input.sourceSnippets ?? [], redactor, redactionMode),
  ].join('\n');

  assertNoPlaceholders(prompt);
  return {
    bundleId: bundle.id,
    targetHead: input.session.targetHead,
    ...(snapshotMode !== undefined ? { snapshotMode } : {}),
    ...(staleWarnings.length > 0 ? { staleWarnings } : {}),
    verificationTimestamp,
    redactionMode,
    prompt,
  };
}

function selectSingleBundle(
  bundles: readonly AuditImplementationBundle[],
  bundleId: string | undefined,
): AuditImplementationBundle {
  const selected =
    bundleId === undefined ? [...bundles] : bundles.filter((bundle) => bundle.id === bundleId);
  if (selected.length !== 1) {
    throw new Error(`dispatch prompt requires exactly one bundle; received ${selected.length}`);
  }
  return selected[0];
}

function isImplementationVerified(finding: AuditFinding): boolean {
  return (
    (finding.status === 'OPEN' || finding.status === 'PARTIAL') &&
    finding.verification !== undefined &&
    finding.verification.verifiedAt.trim().length > 0 &&
    finding.verification.evidence.length > 0
  );
}

function isRuntimeOnlyFinding(finding: AuditFinding): boolean {
  const metadata = finding.metadata;
  const reasonCodes = [
    ...(finding.verification?.reasonCodes ?? []),
    ...finding.evidence.flatMap((evidence) => evidence.reasonCodes ?? []),
  ];
  return (
    metadata.runtimeOnly === true ||
    metadata.requiresRuntime === true ||
    metadata.verificationKind === 'runtime' ||
    metadata.evidenceMode === 'runtime' ||
    reasonCodes.includes('runtime-required') ||
    finding.evidence.some((evidence) => evidence.kind === 'runtime')
  );
}

function defaultImpactChecks(bundle: AuditImplementationBundle): string[] {
  return [
    `Run impact analysis for bundle ${bundle.id} before editing each in-scope symbol.`,
    ...bundle.symbols.map((symbol) => `Confirm upstream blast radius for ${symbol}.`),
  ];
}

function defaultStopConditions(targetHead: string, bundle: AuditImplementationBundle): string[] {
  return [
    `Stop if target HEAD is not ${targetHead}.`,
    'Stop if edits require MCP or CLI shared files.',
    'Stop if changed files, symbols, or tests exceed bundle scope.',
    'Stop if required tests cannot be run.',
    ...bundle.stopConditions,
  ];
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

function formatBullets(values: readonly string[]): string[] {
  const unique = sortedStrings(values);
  return unique.length === 0 ? ['- none'] : unique.map((value) => `- ${value}`);
}

function formatSnippets(
  snippets: readonly AuditDispatchSourceSnippet[],
  redactor: (value: string) => string,
  mode: AuditDispatchRedactionMode,
): string[] {
  if (snippets.length === 0) {
    return ['- none'];
  }
  return snippets.flatMap((snippet) => [
    `- ${redactor(snippet.path)}${snippet.symbol === undefined ? '' : ` :: ${redactor(snippet.symbol)}`}`,
    mode === 'snippets' || mode === 'sensitive' ? '  [REDACTED_SNIPPET]' : `  ${snippet.content}`,
  ]);
}

function createRedactor(mode: AuditDispatchRedactionMode): (value: string) => string {
  const pathTokens = new Map<string, string>();
  return (value: string): string => {
    if (mode === 'none' || value.trim().length === 0) {
      return value;
    }
    if (mode === 'sensitive') {
      value = value.replace(/(token|secret|password|api[_-]?key)=\S+/giu, '$1=[REDACTED]');
    }
    if ((mode === 'paths' || mode === 'sensitive') && looksLikePath(value)) {
      const existing = pathTokens.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const token = `[REDACTED_PATH_${pathTokens.size + 1}]`;
      pathTokens.set(value, token);
      return token;
    }
    return value;
  };
}

function redactValues(values: readonly string[], redactor: (value: string) => string): string[] {
  return values.map(redactor);
}

function looksLikePath(value: string): boolean {
  return (
    /(^|\/|\\)[\w.-]+\.[a-z0-9]+$/iu.test(value) || value.includes('/') || value.includes('\\')
  );
}

function assertNoPlaceholders(prompt: string): void {
  const match = PLACEHOLDER_PATTERNS.find((pattern) => pattern.test(prompt));
  if (match !== undefined) {
    throw new Error(`dispatch prompt contains forbidden placeholder pattern: ${match.source}`);
  }
}

function toIsoTimestamp(value: string, fieldName: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
  return timestamp.toISOString();
}

function sortedStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}
