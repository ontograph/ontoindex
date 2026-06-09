export const TAINT_TRACE_ANALYZER_ID = 'gn_taint_trace';
export const TAINT_TRACE_ANALYZER_VERSION = '0.1.0';
export const TAINT_TRACE_SIDECAR_RECORD_KIND = 'systems.taint_trace';

export type TaintTraceReasonCode =
  | 'SOURCE_MATCHED'
  | 'ASSIGNMENT_PROPAGATION'
  | 'CALL_PROPAGATION'
  | 'SANITIZER_APPLIED'
  | 'NO_SANITIZER_PATH'
  | 'UNRESOLVED_DYNAMIC_FLOW'
  | 'RESPONSE_LIMIT';

export interface TaintTraceStep {
  kind: 'source' | 'assignment' | 'call' | 'sanitizer' | 'sink';
  name: string;
  line: number;
  snippet: string;
  confidence: number;
  reasonCodes: TaintTraceReasonCode[];
}

export interface TaintTracePath {
  id: string;
  status: 'tainted' | 'sanitized' | 'unresolved';
  source: string;
  sink: string;
  steps: TaintTraceStep[];
  sanitizer?: string;
  confidence: number;
  reasonCodes: TaintTraceReasonCode[];
  falsePositiveNotes: string[];
}

export interface TaintTraceParams {
  source: string;
  filePath?: string;
  sourceName: string;
  sinkName: string;
  sanitizers?: readonly string[];
  maxPaths?: number;
}

export interface TaintTraceReport {
  version: 1;
  tool: typeof TAINT_TRACE_ANALYZER_ID;
  status: 'ok' | 'partial' | 'unresolved';
  sidecarRecord: {
    kind: typeof TAINT_TRACE_SIDECAR_RECORD_KIND;
    analyzerId: typeof TAINT_TRACE_ANALYZER_ID;
    analyzerVersion: typeof TAINT_TRACE_ANALYZER_VERSION;
    provenance: {
      filePath?: string;
      mode: 'bounded-static-heuristic';
      sourceName: string;
      sinkName: string;
    };
  };
  primaryGraphFacts: unknown[];
  systemsEvidence: TaintTraceStep[];
  findings: TaintTracePath[];
  paths: TaintTracePath[];
  limits: {
    truncated: boolean;
    maxPaths: number;
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

const DEFAULT_MAX_PATHS = 25;
const MAX_PATHS = 100;
const DEFAULT_SANITIZERS = ['sanitize', 'escape', 'encode', 'validate', 'clean'];

export function traceTaint(params: TaintTraceParams): TaintTraceReport {
  const maxPaths = normalizeLimit(params.maxPaths, DEFAULT_MAX_PATHS, MAX_PATHS);
  const sanitizerNames = new Set([...(params.sanitizers ?? DEFAULT_SANITIZERS)]);
  const state = new Map<string, TaintTracePath>();
  const paths: TaintTracePath[] = [];
  const warnings: string[] = [];
  const skipReasons: string[] = [];

  for (const [index, rawLine] of stripBlockComments(params.source).split('\n').entries()) {
    const line = stripLineComment(rawLine).trim();
    const lineNumber = index + 1;
    if (!line) continue;

    if (isDynamicFlow(line)) {
      warnings.push(`dynamic flow unresolved at ${params.filePath ?? '<source>'}:${lineNumber}`);
    }

    seedSource(params, line, lineNumber, state);
    propagateCall(line, lineNumber, state);
    applySanitizer(line, lineNumber, sanitizerNames, state);
    propagateAssignment(line, lineNumber, state);
    collectSink(params, line, lineNumber, state, paths, sanitizerNames);
  }

  if (paths.length === 0) {
    skipReasons.push('no bounded source-to-sink path matched');
  }
  if (warnings.length > 0) {
    for (const path of paths) {
      if (!path.reasonCodes.includes('UNRESOLVED_DYNAMIC_FLOW')) {
        path.reasonCodes.push('UNRESOLVED_DYNAMIC_FLOW');
      }
    }
  }

  const boundedPaths = paths.slice(0, maxPaths);
  const truncated = paths.length > maxPaths;
  if (truncated) {
    warnings.push(`taint paths truncated from ${paths.length} to ${maxPaths}`);
  }

  return {
    version: 1,
    tool: TAINT_TRACE_ANALYZER_ID,
    status: truncated ? 'partial' : warnings.length > 0 ? 'unresolved' : 'ok',
    sidecarRecord: {
      kind: TAINT_TRACE_SIDECAR_RECORD_KIND,
      analyzerId: TAINT_TRACE_ANALYZER_ID,
      analyzerVersion: TAINT_TRACE_ANALYZER_VERSION,
      provenance: {
        filePath: params.filePath,
        mode: 'bounded-static-heuristic',
        sourceName: params.sourceName,
        sinkName: params.sinkName,
      },
    },
    primaryGraphFacts: [],
    systemsEvidence: boundedPaths.flatMap((path) => path.steps),
    findings: boundedPaths,
    paths: boundedPaths,
    limits: { truncated, maxPaths, emitted: boundedPaths.length, total: paths.length },
    freshness: {
      status: 'not-applicable',
      reason: 'taint trace MVP consumes caller-supplied source only',
    },
    skipReasons,
    warnings,
    nextTools: ['gn_audit_verify'],
  };
}

function seedSource(
  params: TaintTraceParams,
  line: string,
  lineNumber: number,
  state: Map<string, TaintTracePath>,
): void {
  const assignment = assignmentMatch(line);
  const sourceCall = callNames(line).some((name) => name === params.sourceName);
  const sourceVariable = new RegExp(`\\b${escapeRegExp(params.sourceName)}\\b`).test(line);
  if (!assignment || (!sourceCall && !sourceVariable)) return;
  const [, target] = assignment;
  state.set(target, {
    id: `taint:${params.filePath ?? 'source'}:${lineNumber}:${target}`,
    status: 'tainted',
    source: params.sourceName,
    sink: params.sinkName,
    steps: [
      step('source', params.sourceName, lineNumber, line, 0.82, ['SOURCE_MATCHED']),
      step('assignment', target, lineNumber, line, 0.78, ['ASSIGNMENT_PROPAGATION']),
    ],
    confidence: 0.78,
    reasonCodes: ['SOURCE_MATCHED', 'ASSIGNMENT_PROPAGATION'],
    falsePositiveNotes: [
      'bounded heuristic does not model aliases, branches, object fields, or sanitizer semantics beyond names',
    ],
  });
}

function applySanitizer(
  line: string,
  lineNumber: number,
  sanitizerNames: Set<string>,
  state: Map<string, TaintTracePath>,
): void {
  const assignment = assignmentMatch(line);
  if (!assignment) return;
  const [, target, expression] = assignment;
  const sanitizer = callNames(expression).find((name) => sanitizerNames.has(name));
  if (!sanitizer) return;
  const sourceName = firstTaintedName(expression, state);
  if (!sourceName) return;
  const prior = state.get(sourceName);
  if (!prior) return;
  state.set(target, {
    ...prior,
    id: `${prior.id}:sanitized:${lineNumber}`,
    status: 'sanitized',
    sanitizer,
    steps: [
      ...prior.steps,
      step('sanitizer', sanitizer, lineNumber, line, 0.74, ['SANITIZER_APPLIED']),
    ],
    confidence: Math.min(prior.confidence, 0.74),
    reasonCodes: unique([...prior.reasonCodes, 'SANITIZER_APPLIED']),
  });
}

function propagateAssignment(
  line: string,
  lineNumber: number,
  state: Map<string, TaintTracePath>,
): void {
  const assignment = assignmentMatch(line);
  if (!assignment) return;
  const [, target, expression] = assignment;
  if (state.has(target) && state.get(target)?.steps.at(-1)?.line === lineNumber) return;
  const sourceName = firstTaintedName(expression, state);
  if (!sourceName) return;
  const prior = state.get(sourceName);
  if (!prior) return;
  state.set(target, {
    ...prior,
    id: `${prior.id}:assign:${lineNumber}:${target}`,
    steps: [
      ...prior.steps,
      step('assignment', target, lineNumber, line, 0.72, ['ASSIGNMENT_PROPAGATION']),
    ],
    confidence: Math.min(prior.confidence, 0.72),
    reasonCodes: unique([...prior.reasonCodes, 'ASSIGNMENT_PROPAGATION']),
  });
}

function propagateCall(line: string, lineNumber: number, state: Map<string, TaintTracePath>): void {
  const assignment = assignmentMatch(line);
  if (!assignment) return;
  const [, target, expression] = assignment;
  if (state.has(target) && state.get(target)?.steps.at(-1)?.line === lineNumber) return;
  const sourceName = firstTaintedName(expression, state);
  const callee = callNames(expression)[0];
  if (!sourceName || !callee) return;
  const prior = state.get(sourceName);
  if (!prior) return;
  state.set(target, {
    ...prior,
    id: `${prior.id}:call:${lineNumber}:${target}`,
    steps: [...prior.steps, step('call', callee, lineNumber, line, 0.62, ['CALL_PROPAGATION'])],
    confidence: Math.min(prior.confidence, 0.62),
    reasonCodes: unique([...prior.reasonCodes, 'CALL_PROPAGATION']),
    falsePositiveNotes: unique([
      ...prior.falsePositiveNotes,
      'call propagation assumes return value may derive from tainted arguments',
    ]),
  });
}

function collectSink(
  params: TaintTraceParams,
  line: string,
  lineNumber: number,
  state: Map<string, TaintTracePath>,
  paths: TaintTracePath[],
  sanitizerNames: Set<string>,
): void {
  if (!callNames(line).includes(params.sinkName)) return;
  const taintedName = firstTaintedName(line, state);
  if (!taintedName) return;
  const prior = state.get(taintedName);
  if (!prior) return;
  const sanitizerInSink = callNames(line).find((name) => sanitizerNames.has(name));
  const status = prior.status === 'sanitized' || sanitizerInSink ? 'sanitized' : 'tainted';
  const reasonCodes = unique([
    ...prior.reasonCodes,
    ...(status === 'tainted' ? (['NO_SANITIZER_PATH'] as const) : (['SANITIZER_APPLIED'] as const)),
  ]);
  paths.push({
    ...prior,
    id: `${prior.id}:sink:${lineNumber}`,
    status,
    sanitizer: sanitizerInSink ?? prior.sanitizer,
    steps: [
      ...prior.steps,
      ...(sanitizerInSink
        ? [step('sanitizer', sanitizerInSink, lineNumber, line, 0.7, ['SANITIZER_APPLIED'])]
        : []),
      step(
        'sink',
        params.sinkName,
        lineNumber,
        line,
        status === 'tainted' ? 0.8 : 0.64,
        reasonCodes,
      ),
    ],
    confidence: Math.min(prior.confidence, status === 'tainted' ? 0.8 : 0.64),
    reasonCodes,
  });
}

function step(
  kind: TaintTraceStep['kind'],
  name: string,
  line: number,
  snippet: string,
  confidence: number,
  reasonCodes: TaintTraceReasonCode[],
): TaintTraceStep {
  return { kind, name, line, snippet, confidence, reasonCodes };
}

function assignmentMatch(line: string): RegExpMatchArray | null {
  return line.match(
    /(?:^|[;\s])(?:const|let|var|auto|std::string|string|String|char\s*\*)?\s*([A-Za-z_]\w*)\s*=\s*([^;]+)/,
  );
}

function firstTaintedName(
  expression: string,
  state: Map<string, TaintTracePath>,
): string | undefined {
  return Array.from(state.keys()).find((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`).test(expression),
  );
}

function callNames(value: string): string[] {
  return [...value.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]).filter(Boolean);
}

function isDynamicFlow(line: string): boolean {
  return /\b(eval|Function|dlsym|GetProcAddress|reflect)\b/.test(line);
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripLineComment(line: string): string {
  return line.replace(/\/\/.*$/, '');
}

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => '\n'.repeat(match.split('\n').length - 1));
}
