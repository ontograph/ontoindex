export type ConcurrencyReasonCode =
  | 'lock-declaration'
  | 'lock-scope'
  | 'blocking-under-lock'
  | 'io-under-lock'
  | 'allocation-under-lock'
  | 'nested-lock'
  | 'lock-order-inversion';

export interface ConcurrencyAuditParams {
  source: string;
  filePath: string;
  symbol?: string;
  maxFindings?: number;
  maxEvidence?: number;
}

export interface ConcurrencyAuditEvidence {
  kind: 'source-pattern' | 'derived-state';
  filePath: string;
  line: number;
  snippet?: string;
  message: string;
  reasonCode: ConcurrencyReasonCode;
}

export interface ConcurrencyLockDeclaration {
  kind: 'systems.concurrency.lock-declaration';
  lockName: string;
  declarationKind: string;
  filePath: string;
  line: number;
  confidence: number;
  reasonCode: 'lock-declaration';
  provenance: ConcurrencyProvenance;
  evidence: ConcurrencyAuditEvidence[];
}

export interface ConcurrencyLockScope {
  kind: 'systems.concurrency.lock-scope';
  lockName: string;
  acquisitionLine: number;
  releaseLine?: number;
  scopeEndLine: number;
  acquisitionMechanism: string;
  nestedLockNames: string[];
  hazards: ConcurrencyHazard[];
  confidence: number;
  reasonCode: 'lock-scope';
  provenance: ConcurrencyProvenance;
  evidence: ConcurrencyAuditEvidence[];
}

export interface ConcurrencyHazard {
  kind: 'systems.concurrency.hazard';
  hazardKind: 'blocking-call' | 'io-call' | 'allocation-call';
  callName: string;
  lockName: string;
  line: number;
  confidence: number;
  reasonCode: 'blocking-under-lock' | 'io-under-lock' | 'allocation-under-lock';
  falsePositiveNote: string;
  provenance: ConcurrencyProvenance;
  evidence: ConcurrencyAuditEvidence[];
}

export interface ConcurrencyLockOrderEdge {
  outerLockName: string;
  innerLockName: string;
  line: number;
  confidence: number;
}

export interface ConcurrencyFinding {
  id: string;
  category: 'concurrency';
  severity: 'low' | 'medium' | 'high';
  confidence: number;
  message: string;
  reasonCode: ConcurrencyReasonCode;
  falsePositiveNote: string;
  evidence: ConcurrencyAuditEvidence[];
  status: 'open' | 'unresolved';
}

export interface ConcurrencyProvenance {
  analyzerId: 'gn_concurrency_audit';
  analyzerVersion: '0.1.0';
  sidecarRecordKind: 'systems.concurrency';
  source: 'bounded-static-heuristic';
  filePath: string;
  symbol?: string;
}

export interface ConcurrencyAuditReport {
  version: 1;
  tool: 'gn_concurrency_audit';
  status: 'complete' | 'partial';
  sidecarRecordKind: 'systems.concurrency';
  provenance: ConcurrencyProvenance;
  lockDeclarations: ConcurrencyLockDeclaration[];
  lockScopes: ConcurrencyLockScope[];
  lockOrderEdges: ConcurrencyLockOrderEdge[];
  lockInversionRisk: {
    status: 'none' | 'possible';
    pairs: Array<{ firstLockName: string; secondLockName: string; evidenceLines: number[] }>;
    summary: string;
  };
  systemsEvidence: ConcurrencyAuditEvidence[];
  findings: ConcurrencyFinding[];
  limits: {
    maxFindings: number;
    maxEvidence: number;
    findingsReturned: number;
    evidenceReturned: number;
    truncated: boolean;
  };
  warnings: string[];
  falsePositiveNotes: string[];
  nextTools: string[];
}

const DEFAULT_MAX_FINDINGS = 50;
const DEFAULT_MAX_EVIDENCE = 100;
const HARD_MAX = 200;

const BLOCKING_CALLS = [
  'sleep',
  'usleep',
  'nanosleep',
  'wait',
  'waitpid',
  'poll',
  'select',
  'join',
];
const IO_CALLS = ['read', 'write', 'open', 'fopen', 'recv', 'send', 'accept', 'connect', 'fsync'];
const ALLOCATION_CALLS = [
  'malloc',
  'calloc',
  'realloc',
  'free',
  'new',
  'push_back',
  'resize',
  'reserve',
];

export function runConcurrencyAudit(params: ConcurrencyAuditParams): ConcurrencyAuditReport {
  const maxFindings = normalizeLimit(params.maxFindings, DEFAULT_MAX_FINDINGS);
  const maxEvidence = normalizeLimit(params.maxEvidence, DEFAULT_MAX_EVIDENCE);
  const provenance = provenanceFor(params);
  const lines = splitLines(params.source);
  const declarations = findLockDeclarations(lines, params.filePath, provenance);
  const lockNames = new Set(declarations.map((declaration) => declaration.lockName));
  const scopes = findLockScopes(lines, params.filePath, provenance, lockNames);
  const warnings = findUnsupportedLockCalls(lines, params.filePath, lockNames);
  const edges = scopes.flatMap((scope) =>
    scope.nestedLockNames.map((innerLockName) => ({
      outerLockName: scope.lockName,
      innerLockName,
      line: scope.acquisitionLine,
      confidence: 0.72,
    })),
  );
  const inversionPairs = findInversions(edges);
  const findings = [
    ...scopes.flatMap((scope) => scope.hazards.map((hazard) => findingForHazard(hazard))),
    ...scopes
      .filter((scope) => scope.nestedLockNames.length > 0)
      .map((scope) => findingForNestedScope(scope)),
    ...inversionPairs.map((pair) => findingForInversion(pair, params.filePath)),
  ];
  const boundedFindings = findings.slice(0, maxFindings);
  const systemsEvidence = [
    ...declarations.flatMap((declaration) => declaration.evidence),
    ...scopes.flatMap((scope) => scope.evidence),
    ...boundedFindings.flatMap((finding) => finding.evidence),
  ].slice(0, maxEvidence);
  const truncated = findings.length > maxFindings || systemsEvidence.length >= maxEvidence;

  return {
    version: 1,
    tool: 'gn_concurrency_audit',
    status: truncated ? 'partial' : 'complete',
    sidecarRecordKind: 'systems.concurrency',
    provenance,
    lockDeclarations: declarations,
    lockScopes: scopes,
    lockOrderEdges: edges,
    lockInversionRisk: {
      status: inversionPairs.length > 0 ? 'possible' : 'none',
      pairs: inversionPairs,
      summary:
        inversionPairs.length > 0
          ? `${inversionPairs.length} possible lock-order inversion pair(s) found`
          : 'no opposing nested lock order found in bounded source',
    },
    systemsEvidence,
    findings: boundedFindings,
    limits: {
      maxFindings,
      maxEvidence,
      findingsReturned: boundedFindings.length,
      evidenceReturned: systemsEvidence.length,
      truncated,
    },
    warnings,
    falsePositiveNotes: [
      'Heuristics do not prove runtime lock ownership, aliasing, macro expansion, or interprocedural lock release.',
      'RAII and helper wrappers may shorten or release a scope outside the bounded source text.',
    ],
    nextTools: ['gn_audit_logic', 'gn_pressure_impact'],
  };
}

function findLockDeclarations(
  lines: string[],
  filePath: string,
  provenance: ConcurrencyProvenance,
): ConcurrencyLockDeclaration[] {
  const declarations: ConcurrencyLockDeclaration[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\bpthread_mutex_t\s+([A-Za-z_]\w*)\b/, 'pthread_mutex_t'],
    [/\bstd::(?:recursive_)?mutex\s+([A-Za-z_]\w*)\b/, 'std::mutex'],
    [/\b(?:Mutex|RwLock|Semaphore)\s+([A-Za-z_]\w*)\b/, 'lock-type'],
  ];
  lines.forEach((line, index) => {
    for (const [pattern, declarationKind] of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      declarations.push({
        kind: 'systems.concurrency.lock-declaration',
        lockName: match[1],
        declarationKind,
        filePath,
        line: index + 1,
        confidence: 0.82,
        reasonCode: 'lock-declaration',
        provenance,
        evidence: [
          evidence(filePath, index + 1, line, 'lock declaration matched', 'lock-declaration'),
        ],
      });
    }
  });
  return declarations;
}

function findLockScopes(
  lines: string[],
  filePath: string,
  provenance: ConcurrencyProvenance,
  knownLockNames: ReadonlySet<string>,
): ConcurrencyLockScope[] {
  const scopes: ConcurrencyLockScope[] = [];
  lines.forEach((line, index) => {
    const acquisition = parseAcquisition(line, knownLockNames);
    if (!acquisition) return;
    const releaseLine = findReleaseLine(lines, index + 1, acquisition.lockName);
    const scopeEndLine =
      releaseLine ??
      (acquisition.raii ? findBlockEndLine(lines, index) : Math.min(lines.length, index + 8));
    const scopeLines = lines.slice(index + 1, scopeEndLine);
    const hazards = findHazards(scopeLines, index + 2, acquisition.lockName, filePath, provenance);
    const nestedLockNames = scopeLines
      .map((scopeLine) => parseAcquisition(scopeLine, knownLockNames))
      .filter((nested): nested is LockAcquisition => Boolean(nested))
      .map((nested) => nested.lockName)
      .filter((lockName) => lockName !== acquisition.lockName);

    scopes.push({
      kind: 'systems.concurrency.lock-scope',
      lockName: acquisition.lockName,
      acquisitionLine: index + 1,
      releaseLine,
      scopeEndLine,
      acquisitionMechanism: acquisition.mechanism,
      nestedLockNames: [...new Set(nestedLockNames)],
      hazards,
      confidence: releaseLine || acquisition.raii ? 0.78 : 0.58,
      reasonCode: 'lock-scope',
      provenance,
      evidence: [evidence(filePath, index + 1, line, 'lock acquisition matched', 'lock-scope')],
    });
  });
  return scopes;
}

interface LockAcquisition {
  lockName: string;
  mechanism: string;
  raii: boolean;
}

function parseAcquisition(
  line: string,
  knownLockNames: ReadonlySet<string>,
): LockAcquisition | undefined {
  const pthread = /\bpthread_mutex_lock\s*\(\s*&?([A-Za-z_]\w*)\s*\)/.exec(line);
  if (pthread) return { lockName: pthread[1], mechanism: 'pthread_mutex_lock', raii: false };
  const method = /\b([A-Za-z_]\w*)\.lock\s*\(/.exec(line);
  if (method && knownLockNames.has(method[1]))
    return { lockName: method[1], mechanism: 'lock-method', raii: false };
  const raii =
    /\b(?:std::)?(?:lock_guard|unique_lock|scoped_lock)\s*<[^>]+>\s+[A-Za-z_]\w*\s*\(\s*&?([A-Za-z_]\w*)\s*\)/.exec(
      line,
    );
  if (raii) return { lockName: raii[1], mechanism: 'raii-guard', raii: true };
  return undefined;
}

function findUnsupportedLockCalls(
  lines: string[],
  filePath: string,
  knownLockNames: ReadonlySet<string>,
): string[] {
  const warnings: string[] = [];
  lines.forEach((line, index) => {
    const method = /\b([A-Za-z_]\w*)\.lock\s*\(/.exec(line);
    if (!method || knownLockNames.has(method[1])) return;
    warnings.push(
      `${filePath}:${index + 1}: unsupported lock() receiver '${method[1]}' skipped because no mutex/lock type evidence was found`,
    );
  });
  return warnings;
}

function findReleaseLine(
  lines: string[],
  startIndex: number,
  lockName: string,
): number | undefined {
  const unlockPatterns = [
    new RegExp(`\\bpthread_mutex_unlock\\s*\\(\\s*&?${escapeRegExp(lockName)}\\s*\\)`),
    new RegExp(`\\b${escapeRegExp(lockName)}\\.unlock\\s*\\(`),
  ];
  for (let index = startIndex; index < lines.length; index += 1) {
    if (unlockPatterns.some((pattern) => pattern.test(lines[index]))) return index + 1;
  }
  return undefined;
}

function findBlockEndLine(lines: string[], startIndex: number): number {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    depth += countChar(lines[index], '{');
    depth -= countChar(lines[index], '}');
    if (index > startIndex && depth <= 0 && lines[index].includes('}')) return index + 1;
  }
  return lines.length;
}

function findHazards(
  scopeLines: string[],
  firstLineNumber: number,
  lockName: string,
  filePath: string,
  provenance: ConcurrencyProvenance,
): ConcurrencyHazard[] {
  const hazards: ConcurrencyHazard[] = [];
  scopeLines.forEach((line, offset) => {
    const lineNumber = firstLineNumber + offset;
    for (const callName of BLOCKING_CALLS) {
      if (hasCall(line, callName))
        hazards.push(
          hazard('blocking-call', callName, lockName, lineNumber, line, filePath, provenance),
        );
    }
    for (const callName of IO_CALLS) {
      if (hasCall(line, callName))
        hazards.push(hazard('io-call', callName, lockName, lineNumber, line, filePath, provenance));
    }
    for (const callName of ALLOCATION_CALLS) {
      if (hasCall(line, callName))
        hazards.push(
          hazard('allocation-call', callName, lockName, lineNumber, line, filePath, provenance),
        );
    }
  });
  return hazards;
}

function hazard(
  hazardKind: ConcurrencyHazard['hazardKind'],
  callName: string,
  lockName: string,
  line: number,
  snippet: string,
  filePath: string,
  provenance: ConcurrencyProvenance,
): ConcurrencyHazard {
  const reasonCode =
    hazardKind === 'blocking-call'
      ? 'blocking-under-lock'
      : hazardKind === 'io-call'
        ? 'io-under-lock'
        : 'allocation-under-lock';
  return {
    kind: 'systems.concurrency.hazard',
    hazardKind,
    callName,
    lockName,
    line,
    confidence: hazardKind === 'blocking-call' ? 0.76 : 0.7,
    reasonCode,
    falsePositiveNote:
      'The call may be nonblocking, bounded, preallocated, or intentionally serialized by this lock.',
    provenance,
    evidence: [
      evidence(
        filePath,
        line,
        snippet,
        `${callName} matched while ${lockName} is held`,
        reasonCode,
      ),
    ],
  };
}

function findInversions(
  edges: ConcurrencyLockOrderEdge[],
): ConcurrencyAuditReport['lockInversionRisk']['pairs'] {
  const pairs: ConcurrencyAuditReport['lockInversionRisk']['pairs'] = [];
  for (const edge of edges) {
    const inverse = edges.find(
      (candidate) =>
        candidate.outerLockName === edge.innerLockName &&
        candidate.innerLockName === edge.outerLockName,
    );
    if (!inverse) continue;
    const firstLockName = [edge.outerLockName, edge.innerLockName].sort()[0];
    const secondLockName = [edge.outerLockName, edge.innerLockName].sort()[1];
    if (
      pairs.some(
        (pair) => pair.firstLockName === firstLockName && pair.secondLockName === secondLockName,
      )
    ) {
      continue;
    }
    pairs.push({ firstLockName, secondLockName, evidenceLines: [edge.line, inverse.line] });
  }
  return pairs;
}

function findingForHazard(hazard: ConcurrencyHazard): ConcurrencyFinding {
  return {
    id: `concurrency:${hazard.reasonCode}:${hazard.lockName}:${hazard.line}`,
    category: 'concurrency',
    severity: hazard.hazardKind === 'blocking-call' ? 'high' : 'medium',
    confidence: hazard.confidence,
    message: `${hazard.callName} occurs while lock ${hazard.lockName} is held`,
    reasonCode: hazard.reasonCode,
    falsePositiveNote: hazard.falsePositiveNote,
    evidence: hazard.evidence,
    status: 'open',
  };
}

function findingForNestedScope(scope: ConcurrencyLockScope): ConcurrencyFinding {
  return {
    id: `concurrency:nested-lock:${scope.lockName}:${scope.acquisitionLine}`,
    category: 'concurrency',
    severity: 'medium',
    confidence: 0.72,
    message: `lock ${scope.lockName} is held while acquiring ${scope.nestedLockNames.join(', ')}`,
    reasonCode: 'nested-lock',
    falsePositiveNote:
      'Nested locks may be safe when the project has a documented and consistently enforced lock order.',
    evidence: scope.evidence,
    status: 'open',
  };
}

function findingForInversion(
  pair: ConcurrencyAuditReport['lockInversionRisk']['pairs'][number],
  filePath: string,
): ConcurrencyFinding {
  return {
    id: `concurrency:lock-order-inversion:${pair.firstLockName}:${pair.secondLockName}`,
    category: 'concurrency',
    severity: 'high',
    confidence: 0.74,
    message: `possible lock-order inversion between ${pair.firstLockName} and ${pair.secondLockName}`,
    reasonCode: 'lock-order-inversion',
    falsePositiveNote:
      'This is order-based only; branch conditions, try-lock behavior, or non-overlapping execution may make it safe.',
    evidence: pair.evidenceLines.map((line) =>
      evidence(filePath, line, '', 'opposing nested lock order evidence', 'lock-order-inversion'),
    ),
    status: 'open',
  };
}

function evidence(
  filePath: string,
  line: number,
  snippet: string,
  message: string,
  reasonCode: ConcurrencyReasonCode,
): ConcurrencyAuditEvidence {
  return { kind: 'source-pattern', filePath, line, snippet: snippet.trim(), message, reasonCode };
}

function provenanceFor(params: ConcurrencyAuditParams): ConcurrencyProvenance {
  return {
    analyzerId: 'gn_concurrency_audit',
    analyzerVersion: '0.1.0',
    sidecarRecordKind: 'systems.concurrency',
    source: 'bounded-static-heuristic',
    filePath: params.filePath,
    symbol: params.symbol,
  };
}

function splitLines(source: string): string[] {
  return source.split(/\r?\n/);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(HARD_MAX, Math.floor(value)));
}

function hasCall(line: string, callName: string): boolean {
  return new RegExp(`\\b${escapeRegExp(callName)}\\s*(?:\\(|<)`).test(line);
}

function countChar(value: string, char: string): number {
  return [...value].filter((candidate) => candidate === char).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
