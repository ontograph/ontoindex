export interface FsmExtractorParams {
  source: string;
  filePath?: string;
  enumName?: string;
  stateVariable: string;
  maxRecords?: number;
}

export interface FsmState {
  kind: 'systems-fsm-state';
  state: string;
  source: 'enum-member' | 'assignment-only';
  filePath?: string;
  line?: number;
  confidence: number;
  reasonCodes: string[];
  provenance: FsmProvenance;
}

export interface FsmTransition {
  kind: 'systems-fsm-transition';
  fromState: string;
  toState: string;
  guard?: string;
  assignment: string;
  filePath?: string;
  line: number;
  confidence: number;
  reasonCodes: string[];
  whyMayBeFalsePositive: string;
  provenance: FsmProvenance;
}

export interface FsmWarning {
  kind: 'systems-fsm-warning';
  warningKind: 'missing-guard' | 'implicit-fallthrough-state' | 'enum-not-found';
  state?: string;
  message: string;
  filePath?: string;
  line?: number;
  confidence: number;
  reasonCodes: string[];
  whyMayBeFalsePositive: string;
  provenance: FsmProvenance;
}

export interface FsmEvidence {
  kind: 'source-pattern' | 'derived-state';
  message: string;
  filePath?: string;
  line?: number;
  snippet?: string;
}

export interface FsmProvenance {
  recordKind: 'systems.fsm';
  analyzerId: 'gn_extract_fsm';
  analyzerVersion: typeof FSM_EXTRACTOR_VERSION;
  promotedToPrimaryGraph: false;
}

export interface FsmExtractorReport {
  version: 1;
  tool: 'gn_extract_fsm';
  status: 'ok' | 'partial' | 'unresolved';
  target: {
    enumName?: string;
    stateVariable: string;
  };
  primaryGraphFacts: [];
  systemsEvidence: FsmEvidence[];
  states: FsmState[];
  transitions: FsmTransition[];
  transitionMatrix: Record<string, string[]>;
  findings: FsmWarning[];
  limits: {
    truncated: boolean;
    maxRecords: number;
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

const FSM_EXTRACTOR_VERSION = '0.1.0';
const DEFAULT_MAX_RECORDS = 50;
const MAX_RECORDS = 200;
const provenance: FsmProvenance = {
  recordKind: 'systems.fsm',
  analyzerId: 'gn_extract_fsm',
  analyzerVersion: FSM_EXTRACTOR_VERSION,
  promotedToPrimaryGraph: false,
};

export function extractFsm(params: FsmExtractorParams): FsmExtractorReport {
  const maxRecords = normalizeLimit(params.maxRecords, DEFAULT_MAX_RECORDS, MAX_RECORDS);
  const lines = params.source.split(/\r?\n/);
  const enumStates = extractEnumStates(params.source, params.enumName, params.filePath);
  const transitions = extractTransitions(lines, params);
  const assignmentStates = new Set(transitions.map((transition) => transition.toState));
  const stateNames = new Set([...enumStates.map((state) => state.state), ...assignmentStates]);
  const states = [
    ...enumStates,
    ...[...assignmentStates]
      .filter((state) => !enumStates.some((enumState) => enumState.state === state))
      .map((state) => assignmentOnlyState(state, params.filePath)),
  ];
  const findings = createWarnings(params, transitions, stateNames, enumStates.length > 0);
  const records = [...states, ...transitions, ...findings];
  const total = records.length;
  const boundedRecords = records.slice(0, maxRecords);
  const boundedStateCount = boundedRecords.filter(
    (record) => record.kind === 'systems-fsm-state',
  ).length;
  const boundedTransitionCount = boundedRecords.filter(
    (record) => record.kind === 'systems-fsm-transition',
  ).length;
  const boundedWarningCount = boundedRecords.filter(
    (record) => record.kind === 'systems-fsm-warning',
  ).length;
  const boundedStates = states.slice(0, boundedStateCount);
  const boundedTransitions = transitions.slice(0, boundedTransitionCount);
  const boundedFindings = findings.slice(0, boundedWarningCount);

  return {
    version: 1,
    tool: 'gn_extract_fsm',
    status: total > maxRecords ? 'partial' : transitions.length === 0 ? 'unresolved' : 'ok',
    target: {
      enumName: params.enumName,
      stateVariable: params.stateVariable,
    },
    primaryGraphFacts: [],
    systemsEvidence: [
      ...boundedStates.map((state) => evidence(state, `FSM state ${state.state}`)),
      ...boundedTransitions.map((transition) =>
        evidence(transition, `FSM transition to ${transition.toState}`),
      ),
      ...boundedFindings.map((warning) => evidence(warning, warning.message)),
    ],
    states: boundedStates,
    transitions: boundedTransitions,
    transitionMatrix: transitionMatrix(boundedTransitions),
    findings: boundedFindings,
    limits: {
      truncated: total > maxRecords,
      maxRecords,
      emitted: boundedRecords.length,
      total,
    },
    freshness: {
      status: 'not-applicable',
      reason: 'FSM extractor MVP consumes caller-supplied source only',
    },
    skipReasons: enumStates.length === 0 ? ['enum target was not found in bounded source'] : [],
    warnings: [
      'bounded static heuristic: no symbolic execution, macro expansion, alias tracking, or interprocedural flow',
    ],
    nextTools: ['gn_audit_logic'],
  };
}

function extractEnumStates(
  source: string,
  enumName: string | undefined,
  filePath?: string,
): FsmState[] {
  const enumPattern = enumName
    ? new RegExp(`\\benum(?:\\s+class)?\\s+${escapeRegex(enumName)}\\s*\\{([\\s\\S]*?)\\}`, 'm')
    : /\benum(?:\s+class)?\s+\w+\s*\{([\s\S]*?)\}/m;
  const match = enumPattern.exec(source);
  if (!match) return [];

  const enumStartLine = lineNumberAt(source, match.index);
  return match[1]
    .split(',')
    .map((member) => member.replace(/=.*/, '').trim())
    .filter((member) => /^[A-Za-z_]\w*$/.test(member))
    .map((state, index) => ({
      kind: 'systems-fsm-state',
      state,
      source: 'enum-member',
      filePath,
      line: enumStartLine + index,
      confidence: 0.9,
      reasonCodes: ['enum-member'],
      provenance,
    }));
}

function extractTransitions(lines: string[], params: FsmExtractorParams): FsmTransition[] {
  const transitions: FsmTransition[] = [];
  const statePattern = escapeRegex(params.stateVariable);
  const assignmentPattern = new RegExp(
    `\\b${statePattern}\\s*=\\s*([A-Za-z_][\\w:]*)(?:\\s*;|\\s*,|\\s*\\))`,
  );
  const equalityPattern = new RegExp(`\\b${statePattern}\\s*(?:==|!=)\\s*([A-Za-z_][\\w:]*)`);

  lines.forEach((rawLine, index) => {
    const line = stripComment(rawLine).trim();
    const assignment = assignmentPattern.exec(line);
    if (!assignment) return;

    const toState = baseName(assignment[1]);
    const guard = nearestGuard(lines, index, equalityPattern);
    transitions.push({
      kind: 'systems-fsm-transition',
      fromState: guard?.state ?? 'UNKNOWN',
      toState,
      guard: guard?.guard,
      assignment: assignment[0].replace(/[;,)]$/, '').trim(),
      filePath: params.filePath,
      line: index + 1,
      confidence: guard ? 0.78 : 0.62,
      reasonCodes: guard ? ['assignment', 'conditional-guard'] : ['assignment', 'missing-guard'],
      whyMayBeFalsePositive:
        'assignment may target a shadowed variable, macro-expanded state, or a non-FSM field with the same name',
      provenance,
    });
  });

  return transitions;
}

function nearestGuard(
  lines: string[],
  assignmentIndex: number,
  equalityPattern: RegExp,
): { state: string; guard: string } | undefined {
  const min = Math.max(0, assignmentIndex - 4);
  for (let index = assignmentIndex; index >= min; index -= 1) {
    const line = stripComment(lines[index]).trim();
    if (!/\b(if|else\s+if|while|case)\b/.test(line) && !line.startsWith('case ')) continue;
    const equality = equalityPattern.exec(line);
    if (equality) {
      return { state: baseName(equality[1]), guard: line };
    }
    const caseMatch = /case\s+([A-Za-z_][\w:]*)\s*:/.exec(line);
    if (caseMatch) {
      return { state: baseName(caseMatch[1]), guard: line };
    }
  }
  return undefined;
}

function createWarnings(
  params: FsmExtractorParams,
  transitions: FsmTransition[],
  states: Set<string>,
  enumFound: boolean,
): FsmWarning[] {
  const warnings: FsmWarning[] = [];
  if (!enumFound) {
    warnings.push(
      warning('enum-not-found', 'enum target was not found in bounded source', params.filePath),
    );
  }
  for (const transition of transitions) {
    if (!transition.guard) {
      warnings.push(
        warning(
          'missing-guard',
          `transition to ${transition.toState} has no nearby conditional guard`,
          params.filePath,
          transition.line,
          transition.toState,
        ),
      );
    }
  }
  const guardedStates = new Set(transitions.map((transition) => transition.fromState));
  for (const state of states) {
    if (!guardedStates.has(state)) {
      warnings.push(
        warning(
          'implicit-fallthrough-state',
          `state ${state} has no observed incoming guard in bounded source`,
          params.filePath,
          undefined,
          state,
        ),
      );
    }
  }
  return warnings;
}

function warning(
  warningKind: FsmWarning['warningKind'],
  message: string,
  filePath?: string,
  line?: number,
  state?: string,
): FsmWarning {
  return {
    kind: 'systems-fsm-warning',
    warningKind,
    state,
    message,
    filePath,
    line,
    confidence: warningKind === 'missing-guard' ? 0.7 : 0.55,
    reasonCodes: [warningKind],
    whyMayBeFalsePositive:
      'the guard or state may be expressed through helper functions, fallthrough control flow, macros, or paths outside the bounded source',
    provenance,
  };
}

function assignmentOnlyState(state: string, filePath?: string): FsmState {
  return {
    kind: 'systems-fsm-state',
    state,
    source: 'assignment-only',
    filePath,
    confidence: 0.58,
    reasonCodes: ['assignment-only-state'],
    provenance,
  };
}

function transitionMatrix(transitions: FsmTransition[]): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};
  for (const transition of transitions) {
    matrix[transition.fromState] ??= [];
    if (!matrix[transition.fromState].includes(transition.toState)) {
      matrix[transition.fromState].push(transition.toState);
    }
  }
  return matrix;
}

function evidence(record: FsmState | FsmTransition | FsmWarning, message: string): FsmEvidence {
  return {
    kind: record.kind === 'systems-fsm-transition' ? 'source-pattern' : 'derived-state',
    message,
    filePath: record.filePath,
    line: record.line,
    snippet: record.kind === 'systems-fsm-transition' ? record.assignment : undefined,
  };
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function baseName(value: string): string {
  return value.split('::').at(-1) ?? value;
}

function stripComment(line: string): string {
  return line.replace(/\/\/.*$/, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
