export type SystemsRuleCategory =
  | 'resource-leaks'
  | 'fork-safety'
  | 'signals'
  | 'toctou'
  | 'concurrency';

export type SystemsRuleSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type SystemsRulePlatformScope =
  | 'posix'
  | 'linux'
  | 'windows'
  | 'darwin'
  | 'cross-platform'
  | 'unknown';

export interface SystemsRuleEvidence {
  kind: string;
  message: string;
  filePath?: string;
  line?: number;
  symbol?: string;
  resourceInstanceId?: string;
  handle?: string | number;
  snippet?: string;
  fact?: Record<string, unknown>;
}

export interface SystemsRuleFinding {
  id: string;
  category: SystemsRuleCategory;
  severity: SystemsRuleSeverity;
  confidence: number;
  platformScope: SystemsRulePlatformScope;
  suppressionKey: string;
  whyFired: string;
  whyMayBeFalsePositive: string;
  evidence: SystemsRuleEvidence[];
  lifecycleStatusEffect: 'none';
}

export interface SystemsRuleFact {
  kind: string;
  category?: SystemsRuleCategory;
  operation?: string;
  mechanism?: string;
  resourceInstanceId?: string;
  filePath?: string;
  line?: number;
  symbol?: string;
  handle?: string | number;
  flags?: string[];
  matched?: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface SystemsRuleEngineParams {
  source?: string;
  filePath?: string;
  facts?: SystemsRuleFact[];
  categories?: SystemsRuleCategory[];
  maxFindings?: number;
}

export interface SystemsRuleEngineReport {
  version: 1;
  tool: 'gn_audit_logic';
  status: 'ok' | 'partial';
  primaryGraphFacts: unknown[];
  systemsEvidence: SystemsRuleEvidence[];
  findings: SystemsRuleFinding[];
  limits: {
    truncated: boolean;
    maxFindings: number;
    emitted: number;
    total: number;
  };
  freshness: {
    status: 'not-applicable';
    reason: string;
  };
  skipReasons: string[];
  warnings: string[];
  nextTools: string[];
}

const DEFAULT_MAX_FINDINGS = 50;
const MAX_FINDINGS = 100;
const ALL_CATEGORIES: SystemsRuleCategory[] = [
  'resource-leaks',
  'fork-safety',
  'signals',
  'toctou',
  'concurrency',
];

export function runSystemsRuleEngine(params: SystemsRuleEngineParams): SystemsRuleEngineReport {
  const categories = normalizeCategories(params.categories);
  const maxFindings = normalizeLimit(params.maxFindings, DEFAULT_MAX_FINDINGS, MAX_FINDINGS);
  const findings: SystemsRuleFinding[] = [];

  for (const category of categories) {
    findings.push(...runCategory(category, params));
  }

  const total = findings.length;
  const boundedFindings = findings.slice(0, maxFindings);
  const systemsEvidence = boundedFindings.flatMap((finding) => finding.evidence);

  return {
    version: 1,
    tool: 'gn_audit_logic',
    status: total > maxFindings ? 'partial' : 'ok',
    primaryGraphFacts: [],
    systemsEvidence,
    findings: boundedFindings,
    limits: {
      truncated: total > maxFindings,
      maxFindings,
      emitted: boundedFindings.length,
      total,
    },
    freshness: {
      status: 'not-applicable',
      reason: 'systems-audit MVP consumes caller-supplied source/facts only',
    },
    skipReasons: [],
    warnings: [],
    nextTools: ['gn_trace_boundary'],
  };
}

function runCategory(
  category: SystemsRuleCategory,
  params: SystemsRuleEngineParams,
): SystemsRuleFinding[] {
  switch (category) {
    case 'resource-leaks':
      return detectResourceLeaks(params);
    case 'fork-safety':
      return detectForkSafety(params);
    case 'signals':
      return detectSignals(params);
    case 'toctou':
      return detectToctou(params);
    case 'concurrency':
      return detectConcurrency(params);
  }
}

function detectResourceLeaks(params: SystemsRuleEngineParams): SystemsRuleFinding[] {
  const findings: SystemsRuleFinding[] = [];
  const facts = params.facts ?? [];
  const acquisitions = facts.filter((fact) =>
    ['open', 'socket', 'pipe', 'dup', 'accept'].includes(String(fact.operation ?? fact.kind)),
  );
  const releases = new Set(
    facts
      .filter((fact) => ['close', 'closed'].includes(String(fact.operation ?? fact.kind)))
      .map(resourceKey),
  );

  for (const fact of acquisitions) {
    if (!releases.has(resourceKey(fact))) {
      findings.push(
        createFinding({
          category: 'resource-leaks',
          severity: 'HIGH',
          confidence: 0.82,
          platformScope: 'posix',
          whyFired:
            'resource acquisition has no matching close/release fact in the bounded evidence set',
          whyMayBeFalsePositive:
            'the release may happen through ownership transfer, cleanup helpers, RAII destructors, or a path outside the supplied facts',
          evidence: [factEvidence(fact, 'unmatched resource acquisition')],
        }),
      );
    }
  }

  if (
    params.source &&
    /\b(open|socket|pipe|dup|accept)\s*\(/.test(params.source) &&
    !/\bclose\s*\(/.test(params.source)
  ) {
    findings.push(
      createFinding({
        category: 'resource-leaks',
        severity: 'MEDIUM',
        confidence: 0.68,
        platformScope: 'posix',
        whyFired:
          'source contains descriptor acquisition calls but no close call in the same bounded text',
        whyMayBeFalsePositive:
          'the descriptor may be returned, stored for longer ownership, or closed by a helper outside the bounded text',
        evidence: [sourceEvidence(params, 'descriptor acquisition without local close')],
      }),
    );
  }

  return findings;
}

function detectForkSafety(params: SystemsRuleEngineParams): SystemsRuleFinding[] {
  const findings: SystemsRuleFinding[] = [];
  const facts = params.facts ?? [];
  const forkFacts = facts.filter((fact) => String(fact.kind) === 'fork');
  const inheritableFacts = facts.filter(
    (fact) =>
      ['open', 'socket', 'pipe', 'dup', 'accept'].includes(String(fact.operation ?? fact.kind)) &&
      !(fact.flags ?? []).some((flag) =>
        ['O_CLOEXEC', 'FD_CLOEXEC', 'close-on-exec'].includes(flag),
      ),
  );

  for (const forkFact of forkFacts) {
    for (const inheritable of inheritableFacts) {
      findings.push(
        createFinding({
          category: 'fork-safety',
          severity: 'MEDIUM',
          confidence: 0.74,
          platformScope: 'posix',
          whyFired: 'fork occurs while an inheritable descriptor lacks close-on-exec evidence',
          whyMayBeFalsePositive:
            'the child may intentionally inherit the descriptor or close it immediately on the child path',
          evidence: [
            factEvidence(forkFact, 'fork boundary'),
            factEvidence(inheritable, 'inheritable descriptor'),
          ],
        }),
      );
    }
  }

  if (
    params.source &&
    /\bfork\s*\(/.test(params.source) &&
    /\b(open|socket|pipe|dup|accept)\s*\(/.test(params.source) &&
    !/(O_CLOEXEC|FD_CLOEXEC|close-on-exec)/.test(params.source)
  ) {
    findings.push(
      createFinding({
        category: 'fork-safety',
        severity: 'MEDIUM',
        confidence: 0.64,
        platformScope: 'posix',
        whyFired: 'source combines fork with descriptor creation but lacks close-on-exec markers',
        whyMayBeFalsePositive:
          'the descriptor may be deliberately shared or sanitized through code outside the bounded text',
        evidence: [sourceEvidence(params, 'fork with potentially inheritable descriptor')],
      }),
    );
  }

  return findings;
}

function detectSignals(params: SystemsRuleEngineParams): SystemsRuleFinding[] {
  const findings: SystemsRuleFinding[] = [];
  const signalFacts = (params.facts ?? []).filter(
    (fact) => fact.category === 'signals' || String(fact.kind).includes('signal'),
  );

  for (const fact of signalFacts) {
    if (fact.operation === 'unsafe-handler-call' || fact.matched === false) {
      findings.push(
        createFinding({
          category: 'signals',
          severity: 'HIGH',
          confidence: 0.8,
          platformScope: 'posix',
          whyFired: 'signal handler evidence includes an async-signal-unsafe operation',
          whyMayBeFalsePositive:
            'the handler may not run asynchronously on the target platform or the call may be a known safe wrapper',
          evidence: [factEvidence(fact, 'async-signal-safety evidence')],
        }),
      );
    }
  }

  if (
    params.source &&
    /\b(sigaction|signal)\s*\(/.test(params.source) &&
    /\b(printf|malloc|free|pthread_mutex_lock|new)\s*\(/.test(params.source)
  ) {
    findings.push(
      createFinding({
        category: 'signals',
        severity: 'HIGH',
        confidence: 0.7,
        platformScope: 'posix',
        whyFired:
          'bounded source registers a signal handler and contains calls commonly unsafe in async handlers',
        whyMayBeFalsePositive:
          'the unsafe call may not be inside the handler body or the handler may be synchronous/test-only code',
        evidence: [sourceEvidence(params, 'possible async-signal-unsafe handler call')],
      }),
    );
  }

  return findings;
}

function detectToctou(params: SystemsRuleEngineParams): SystemsRuleFinding[] {
  const source = params.source ?? '';
  if (!/\b(access|stat|lstat)\s*\(/.test(source) || !/\b(open|fopen)\s*\(/.test(source)) {
    return [];
  }

  return [
    createFinding({
      category: 'toctou',
      severity: 'HIGH',
      confidence: 0.72,
      platformScope: 'posix',
      whyFired: 'bounded source checks filesystem state before opening the path later',
      whyMayBeFalsePositive:
        'the path may be immutable, protected by a directory fd workflow, or reopened with race-resistant flags outside the snippet',
      evidence: [sourceEvidence(params, 'filesystem check followed by open')],
    }),
  ];
}

function detectConcurrency(params: SystemsRuleEngineParams): SystemsRuleFinding[] {
  const findings: SystemsRuleFinding[] = [];
  const source = params.source ?? '';
  const lockCount = countMatches(source, /\b(pthread_mutex_lock|mutex\.lock|lock_guard)\s*\(/g);
  const unlockCount = countMatches(source, /\b(pthread_mutex_unlock|mutex\.unlock)\s*\(/g);

  if (lockCount > unlockCount) {
    findings.push(
      createFinding({
        category: 'concurrency',
        severity: 'MEDIUM',
        confidence: 0.69,
        platformScope: 'cross-platform',
        whyFired: 'bounded source has more lock acquisitions than unlock releases',
        whyMayBeFalsePositive:
          'RAII guards, deferred cleanup, or helper functions may release the lock outside the matched text',
        evidence: [sourceEvidence(params, 'unbalanced lock/unlock pattern')],
      }),
    );
  }

  for (const fact of params.facts ?? []) {
    if (fact.category === 'concurrency' || fact.operation === 'blocking-under-lock') {
      findings.push(
        createFinding({
          category: 'concurrency',
          severity: 'MEDIUM',
          confidence: 0.78,
          platformScope: 'cross-platform',
          whyFired: 'concurrency fact indicates blocking or shared-state behavior under a lock',
          whyMayBeFalsePositive:
            'the lock may be uncontended, reentrant, or protecting a deliberately blocking critical section',
          evidence: [factEvidence(fact, 'concurrency evidence')],
        }),
      );
    }
  }

  return findings;
}

function createFinding(
  input: Omit<SystemsRuleFinding, 'id' | 'suppressionKey' | 'lifecycleStatusEffect'>,
): SystemsRuleFinding {
  const evidenceKey = input.evidence
    .map((evidence) =>
      [
        evidence.filePath ?? '',
        evidence.line ?? '',
        evidence.symbol ?? '',
        evidence.resourceInstanceId ?? '',
      ].join(':'),
    )
    .join('|');
  const suppressionKey = `systems-audit:${input.category}:${stableHash(
    [input.whyFired, evidenceKey].join('|'),
  )}`;

  return {
    ...input,
    id: `finding:${suppressionKey}`,
    suppressionKey,
    lifecycleStatusEffect: 'none',
  };
}

function factEvidence(fact: SystemsRuleFact, message: string): SystemsRuleEvidence {
  return {
    kind: 'systems-audit-fact',
    message,
    filePath: fact.filePath,
    line: fact.line,
    symbol: fact.symbol,
    resourceInstanceId: fact.resourceInstanceId,
    handle: fact.handle,
    fact: { ...fact },
  };
}

function sourceEvidence(params: SystemsRuleEngineParams, message: string): SystemsRuleEvidence {
  return {
    kind: 'source-pattern',
    message,
    filePath: params.filePath,
    snippet: firstNonEmptyLine(params.source ?? ''),
  };
}

function normalizeCategories(categories: SystemsRuleCategory[] | undefined): SystemsRuleCategory[] {
  if (!categories?.length) {
    return ALL_CATEGORIES;
  }
  return categories.filter((category): category is SystemsRuleCategory =>
    ALL_CATEGORIES.includes(category),
  );
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function resourceKey(fact: SystemsRuleFact): string {
  return String(
    fact.resourceInstanceId ?? fact.handle ?? `${fact.filePath ?? ''}:${fact.line ?? ''}`,
  );
}

function countMatches(source: string, regex: RegExp): number {
  return [...source.matchAll(regex)].length;
}

function firstNonEmptyLine(source: string): string | undefined {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
