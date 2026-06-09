export type FaultSimulationReasonCode =
  | 'target-call-found'
  | 'target-result-bound'
  | 'target-result-inline'
  | 'comparison-evaluated'
  | 'comparison-unsupported'
  | 'branch-block-sliced'
  | 'state-assignment-detected'
  | 'early-return-detected'
  | 'target-result-not-compared'
  | 'trigger-path-not-observed'
  | 'state-updated-before-check'
  | 'early-return-before-check'
  | 'response-truncated';

export interface FaultSimulationParams {
  sourceText: string;
  filePath?: string;
  targetCall: string;
  returnValue: string | number | boolean | null;
  triggerPath?: readonly string[];
  maxBranches?: number;
  maxAssignments?: number;
  maxEarlyReturns?: number;
}

export interface FaultSimulationLineSpan {
  startLine: number;
  endLine: number;
}

export interface FaultSimulationEvidence {
  kind: 'source-call' | 'source-pattern' | 'derived-state';
  filePath?: string;
  lineSpan?: FaultSimulationLineSpan;
  snippet?: string;
  message: string;
}

export interface FaultSimulationBranch {
  condition: string;
  line: number;
  snippet: string;
  comparesTargetResult: boolean;
  likelyTaken: boolean | 'unknown';
  confidence: number;
  reasonCodes: FaultSimulationReasonCode[];
  falsePositiveNotes: string[];
  evidence: FaultSimulationEvidence[];
}

export interface FaultSimulationAssignment {
  variable: string;
  value: string;
  line: number;
  snippet: string;
  path: 'likely-taken' | 'not-taken' | 'unknown';
  confidence: number;
  reasonCodes: FaultSimulationReasonCode[];
  falsePositiveNotes: string[];
}

export interface FaultSimulationEarlyReturn {
  expression: string;
  line: number;
  snippet: string;
  path: 'likely-taken' | 'not-taken' | 'unknown';
  confidence: number;
  reasonCodes: FaultSimulationReasonCode[];
  falsePositiveNotes: string[];
}

export interface FaultSimulationRecord {
  kind: 'systems-audit-fault-simulation';
  sidecarRecordKind: 'systems.fault_simulation';
  analyzerId: 'gn_simulate_fault';
  analyzerVersion: '0.1.0';
  provenance: {
    source: 'caller-supplied-source';
    staticOnly: true;
    runtimeMutation: false;
  };
  filePath?: string;
  targetCall: string;
  returnValue: string | number | boolean | null;
  triggerPath: string[];
  targetResultSymbols: string[];
  branches: FaultSimulationBranch[];
  likelyTakenPath: FaultSimulationBranch[];
  stateAssignments: FaultSimulationAssignment[];
  earlyReturns: FaultSimulationEarlyReturn[];
  bypassWarnings: string[];
  confidence: number;
  reasonCodes: FaultSimulationReasonCode[];
  falsePositiveNotes: string[];
  limits: {
    maxBranches: number;
    branchesReturned: number;
    totalBranches: number;
    maxAssignments: number;
    assignmentsReturned: number;
    totalAssignments: number;
    maxEarlyReturns: number;
    earlyReturnsReturned: number;
    totalEarlyReturns: number;
    truncated: boolean;
  };
}

const DEFAULT_MAX_BRANCHES = 20;
const DEFAULT_MAX_ASSIGNMENTS = 20;
const DEFAULT_MAX_EARLY_RETURNS = 20;
const HARD_MAX = 100;

const COMPARISON_OPERATORS = ['===', '!==', '==', '!=', '<=', '>=', '<', '>'] as const;
const STATE_NAME_PATTERN = /(?:state|status|mode|phase|result|error|err|failed|ready|done)/i;

export function simulateFault(params: FaultSimulationParams): FaultSimulationRecord {
  const sourceLines = params.sourceText.split(/\r?\n/);
  const targetCall = requireNonEmpty(params.targetCall, 'targetCall');
  const maxBranches = normalizeLimit(params.maxBranches, DEFAULT_MAX_BRANCHES);
  const maxAssignments = normalizeLimit(params.maxAssignments, DEFAULT_MAX_ASSIGNMENTS);
  const maxEarlyReturns = normalizeLimit(params.maxEarlyReturns, DEFAULT_MAX_EARLY_RETURNS);
  const targetResultSymbols = findTargetResultSymbols(sourceLines, targetCall);
  const targetCallLines = findTargetCallLines(sourceLines, targetCall);
  const branches = findBranches({
    sourceLines,
    filePath: params.filePath,
    targetCall,
    targetResultSymbols,
    returnValue: params.returnValue,
  });
  const likelyBranches = branches.filter((branch) => branch.likelyTaken === true);
  const pathBranches = likelyBranches.length > 0 ? likelyBranches : branches;
  const assignments = pathBranches.flatMap((branch) => findStateAssignments(sourceLines, branch));
  const earlyReturns = pathBranches.flatMap((branch) => findEarlyReturns(sourceLines, branch));
  const bypassWarnings = findBypassWarnings({
    sourceLines,
    targetCallLines,
    targetResultSymbols,
    branches,
    triggerPath: params.triggerPath ?? [],
  });
  const boundedBranches = branches.slice(0, maxBranches);
  const boundedAssignments = assignments.slice(0, maxAssignments);
  const boundedEarlyReturns = earlyReturns.slice(0, maxEarlyReturns);
  const truncated =
    boundedBranches.length < branches.length ||
    boundedAssignments.length < assignments.length ||
    boundedEarlyReturns.length < earlyReturns.length;
  const reasonCodes = uniqueReasonCodes([
    ...(targetCallLines.length > 0 ? ['target-call-found' as const] : []),
    ...(targetResultSymbols.length > 0 ? ['target-result-bound' as const] : []),
    ...branches.flatMap((branch) => branch.reasonCodes),
    ...assignments.flatMap((assignment) => assignment.reasonCodes),
    ...earlyReturns.flatMap((earlyReturn) => earlyReturn.reasonCodes),
    ...bypassWarnings.map(warningToReasonCode),
    ...(truncated ? ['response-truncated' as const] : []),
  ]);

  return {
    kind: 'systems-audit-fault-simulation',
    sidecarRecordKind: 'systems.fault_simulation',
    analyzerId: 'gn_simulate_fault',
    analyzerVersion: '0.1.0',
    provenance: {
      source: 'caller-supplied-source',
      staticOnly: true,
      runtimeMutation: false,
    },
    filePath: params.filePath,
    targetCall,
    returnValue: params.returnValue,
    triggerPath: [...(params.triggerPath ?? [])],
    targetResultSymbols,
    branches: boundedBranches,
    likelyTakenPath: boundedBranches.filter((branch) => branch.likelyTaken === true),
    stateAssignments: boundedAssignments,
    earlyReturns: boundedEarlyReturns,
    bypassWarnings,
    confidence: computeRecordConfidence(branches, bypassWarnings, truncated),
    reasonCodes,
    falsePositiveNotes: [
      'bounded static source scan; macros, aliases, overloads, callbacks, and interprocedural effects may be missed',
      'likely path is inferred from textual branch predicates only; no runtime mutation or symbolic execution is performed',
    ],
    limits: {
      maxBranches,
      branchesReturned: boundedBranches.length,
      totalBranches: branches.length,
      maxAssignments,
      assignmentsReturned: boundedAssignments.length,
      totalAssignments: assignments.length,
      maxEarlyReturns,
      earlyReturnsReturned: boundedEarlyReturns.length,
      totalEarlyReturns: earlyReturns.length,
      truncated,
    },
  };
}

function findTargetResultSymbols(sourceLines: string[], targetCall: string): string[] {
  const callPattern = escapeRegex(targetCall);
  const symbols = new Set<string>();
  const declarationPattern = new RegExp(
    `\\b(?:const|let|var|auto|int|long|ssize_t|size_t|bool|BOOL|HRESULT|NTSTATUS|Status|Result)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${callPattern}\\s*\\(`,
  );
  const assignmentPattern = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${callPattern}\\s*\\(`);

  for (const line of sourceLines) {
    const declarationMatch = declarationPattern.exec(line);
    const assignmentMatch = assignmentPattern.exec(line);
    const symbol = declarationMatch?.[1] ?? assignmentMatch?.[1];
    if (symbol) symbols.add(symbol);
  }

  return [...symbols];
}

function findTargetCallLines(sourceLines: string[], targetCall: string): number[] {
  const callPattern = new RegExp(`\\b${escapeRegex(targetCall)}\\s*\\(`);
  return sourceLines.flatMap((line, index) => (callPattern.test(line) ? [index + 1] : []));
}

function findBranches(input: {
  sourceLines: string[];
  filePath?: string;
  targetCall: string;
  targetResultSymbols: string[];
  returnValue: FaultSimulationParams['returnValue'];
}): FaultSimulationBranch[] {
  const branches: FaultSimulationBranch[] = [];

  input.sourceLines.forEach((line, index) => {
    const condition = extractIfCondition(line);
    if (!condition) return;

    const comparesBoundSymbol = input.targetResultSymbols.some((symbol) =>
      referencesIdentifier(condition, symbol),
    );
    const comparesInlineCall = new RegExp(`\\b${escapeRegex(input.targetCall)}\\s*\\(`).test(
      condition,
    );
    if (!comparesBoundSymbol && !comparesInlineCall) return;

    const evaluation = evaluateCondition(condition, input.targetResultSymbols, input.returnValue);
    const reasonCodes: FaultSimulationReasonCode[] = [
      comparesInlineCall ? 'target-result-inline' : 'target-result-bound',
      evaluation.supported ? 'comparison-evaluated' : 'comparison-unsupported',
      'branch-block-sliced',
    ];

    branches.push({
      condition,
      line: index + 1,
      snippet: line.trim(),
      comparesTargetResult: true,
      likelyTaken: evaluation.likelyTaken,
      confidence: evaluation.supported ? 0.78 : 0.52,
      reasonCodes,
      falsePositiveNotes: [
        'condition may depend on side effects, macro expansion, exception flow, or values outside the supplied source text',
      ],
      evidence: [
        {
          kind: 'source-pattern',
          filePath: input.filePath,
          lineSpan: { startLine: index + 1, endLine: index + 1 },
          snippet: line.trim(),
          message: 'branch compares the target call result or a symbol bound from it',
        },
      ],
    });
  });

  return branches;
}

function findStateAssignments(
  sourceLines: string[],
  branch: FaultSimulationBranch,
): FaultSimulationAssignment[] {
  return sliceBranchBlock(sourceLines, branch.line).flatMap(({ line, lineNumber }) => {
    const match = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*=\s*([^;]+);?/.exec(line);
    if (!match || !STATE_NAME_PATTERN.test(match[1])) return [];

    return [
      {
        variable: match[1],
        value: match[2].trim(),
        line: lineNumber,
        snippet: line.trim(),
        path:
          branch.likelyTaken === true
            ? 'likely-taken'
            : branch.likelyTaken === false
              ? 'not-taken'
              : 'unknown',
        confidence: 0.68,
        reasonCodes: ['state-assignment-detected'],
        falsePositiveNotes: [
          'assignment is text-matched inside the branch slice and may not represent a durable state transition',
        ],
      },
    ];
  });
}

function findEarlyReturns(
  sourceLines: string[],
  branch: FaultSimulationBranch,
): FaultSimulationEarlyReturn[] {
  return sliceBranchBlock(sourceLines, branch.line).flatMap(({ line, lineNumber }) => {
    const match = /\breturn\b\s*([^;]*);?/.exec(line);
    if (!match) return [];

    return [
      {
        expression: match[1].trim(),
        line: lineNumber,
        snippet: line.trim(),
        path:
          branch.likelyTaken === true
            ? 'likely-taken'
            : branch.likelyTaken === false
              ? 'not-taken'
              : 'unknown',
        confidence: 0.72,
        reasonCodes: ['early-return-detected'],
        falsePositiveNotes: [
          'return is text-matched inside a bounded branch slice; nested scopes and preprocessor branches may alter reachability',
        ],
      },
    ];
  });
}

function findBypassWarnings(input: {
  sourceLines: string[];
  targetCallLines: number[];
  targetResultSymbols: string[];
  branches: FaultSimulationBranch[];
  triggerPath: readonly string[];
}): string[] {
  const warnings: string[] = [];
  if (input.targetCallLines.length === 0)
    return ['target call was not found in supplied source text'];
  if (input.branches.length === 0)
    warnings.push('target result is not compared in the bounded source text');

  const firstCallLine = Math.min(...input.targetCallLines);
  const firstBranchLine = input.branches.length
    ? Math.min(...input.branches.map((branch) => branch.line))
    : Number.POSITIVE_INFINITY;
  const linesBeforeCheck = input.sourceLines.slice(firstCallLine, firstBranchLine - 1);

  if (linesBeforeCheck.some((line) => STATE_NAME_PATTERN.test(line) && /=/.test(line))) {
    warnings.push('state appears to be updated before the target result is checked');
  }
  if (linesBeforeCheck.some((line) => /\breturn\b/.test(line))) {
    warnings.push('an early return appears before the target result is checked');
  }
  if (
    input.triggerPath.length > 0 &&
    !input.triggerPath.some((hint) => input.sourceLines.some((line) => line.includes(hint)))
  ) {
    warnings.push('trigger path was not observed in the supplied source text');
  }

  return warnings;
}

function sliceBranchBlock(
  sourceLines: string[],
  branchLine: number,
): { line: string; lineNumber: number }[] {
  const startIndex = branchLine - 1;
  const branchLineText = sourceLines[startIndex] ?? '';
  const sliced: { line: string; lineNumber: number }[] = [];
  let depth = countChar(branchLineText, '{') - countChar(branchLineText, '}');

  if (depth <= 0) {
    const inlineTail = branchLineText.slice(branchLineText.indexOf(')') + 1);
    if (inlineTail.trim()) sliced.push({ line: inlineTail, lineNumber: branchLine });
    return sliced;
  }

  for (let index = startIndex + 1; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? '';
    depth += countChar(line, '{') - countChar(line, '}');
    if (depth < 0) break;
    if (line.trim() && depth >= 0) sliced.push({ line, lineNumber: index + 1 });
    if (depth === 0) break;
  }

  return sliced;
}

function extractIfCondition(line: string): string | undefined {
  const ifIndex = line.search(/\bif\s*\(/);
  if (ifIndex < 0) return undefined;

  const openIndex = line.indexOf('(', ifIndex);
  let depth = 0;
  for (let index = openIndex; index < line.length; index += 1) {
    const char = line[index];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0) return line.slice(openIndex + 1, index).trim();
  }
  return undefined;
}

function evaluateCondition(
  condition: string,
  targetResultSymbols: string[],
  returnValue: FaultSimulationParams['returnValue'],
): { likelyTaken: boolean | 'unknown'; supported: boolean } {
  const numericReturnValue = toComparableNumber(returnValue);
  for (const operator of COMPARISON_OPERATORS) {
    const parts = splitOperator(condition, operator);
    if (!parts) continue;

    const [left, right] = parts;
    const leftValue = expressionValue(left, targetResultSymbols, numericReturnValue);
    const rightValue = expressionValue(right, targetResultSymbols, numericReturnValue);
    if (leftValue === undefined || rightValue === undefined) continue;
    return { likelyTaken: compareValues(leftValue, rightValue, operator), supported: true };
  }

  const trimmed = stripParens(condition.trim());
  if (targetResultSymbols.some((symbol) => trimmed === symbol)) {
    return { likelyTaken: Boolean(numericReturnValue), supported: true };
  }
  if (
    trimmed.startsWith('!') &&
    targetResultSymbols.some((symbol) => stripParens(trimmed.slice(1).trim()) === symbol)
  ) {
    return { likelyTaken: !Boolean(numericReturnValue), supported: true };
  }

  return { likelyTaken: 'unknown', supported: false };
}

function splitOperator(
  condition: string,
  operator: (typeof COMPARISON_OPERATORS)[number],
): [string, string] | undefined {
  const index = condition.indexOf(operator);
  if (index < 0) return undefined;
  return [condition.slice(0, index).trim(), condition.slice(index + operator.length).trim()];
}

function expressionValue(
  expression: string,
  targetResultSymbols: string[],
  returnValue: number,
): number | undefined {
  const stripped = stripParens(expression.trim());
  if (targetResultSymbols.some((symbol) => stripped === symbol)) return returnValue;
  if (/^-?\d+(?:\.\d+)?$/.test(stripped)) return Number(stripped);
  if (stripped === 'true') return 1;
  if (stripped === 'false' || stripped === 'NULL' || stripped === 'nullptr' || stripped === 'null')
    return 0;
  return undefined;
}

function compareValues(
  left: number,
  right: number,
  operator: (typeof COMPARISON_OPERATORS)[number],
): boolean {
  switch (operator) {
    case '===':
    case '==':
      return left === right;
    case '!==':
    case '!=':
      return left !== right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '>':
      return left > right;
  }
}

function warningToReasonCode(warning: string): FaultSimulationReasonCode {
  if (warning.includes('not compared')) return 'target-result-not-compared';
  if (warning.includes('trigger path')) return 'trigger-path-not-observed';
  if (warning.includes('state appears')) return 'state-updated-before-check';
  if (warning.includes('early return')) return 'early-return-before-check';
  return 'target-call-found';
}

function computeRecordConfidence(
  branches: FaultSimulationBranch[],
  bypassWarnings: string[],
  truncated: boolean,
): number {
  if (branches.length === 0) return 0.35;
  const averageBranchConfidence =
    branches.reduce((sum, branch) => sum + branch.confidence, 0) / branches.length;
  const warningPenalty = Math.min(0.25, bypassWarnings.length * 0.06);
  const truncationPenalty = truncated ? 0.08 : 0;
  return clampConfidence(averageBranchConfidence - warningPenalty - truncationPenalty);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(HARD_MAX, Math.floor(value)));
}

function toComparableNumber(value: FaultSimulationParams['returnValue']): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function referencesIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegex(identifier)}\\b`).test(source);
}

function stripParens(value: string): string {
  let stripped = value;
  while (stripped.startsWith('(') && stripped.endsWith(')')) {
    stripped = stripped.slice(1, -1).trim();
  }
  return stripped;
}

function countChar(value: string, char: string): number {
  return [...value].filter((candidate) => candidate === char).length;
}

function uniqueReasonCodes(reasonCodes: FaultSimulationReasonCode[]): FaultSimulationReasonCode[] {
  return [...new Set(reasonCodes)];
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function requireNonEmpty(value: string, fieldName: string): string {
  if (value.trim().length === 0) throw new Error(`${fieldName} must be a non-empty string`);
  return value.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
