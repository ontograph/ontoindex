export type PressureReasonCode =
  | 'global-constraint'
  | 'constraint-increment'
  | 'constraint-decrement'
  | 'constraint-limit-check'
  | 'global-impact-warning';

export interface PressureImpactParams {
  source: string;
  filePath: string;
  symbol?: string;
  maxWarnings?: number;
  maxEvidence?: number;
}

export interface PressureImpactEvidence {
  kind: 'source-pattern' | 'derived-state';
  filePath: string;
  line: number;
  snippet?: string;
  message: string;
  reasonCode: PressureReasonCode;
}

export interface PressureProvenance {
  analyzerId: 'gn_pressure_impact';
  analyzerVersion: '0.1.0';
  sidecarRecordKind: 'systems.pressure_impact';
  source: 'bounded-static-heuristic';
  filePath: string;
  symbol?: string;
}

export interface PressureConstraint {
  kind: 'systems.pressure.constraint';
  name: string;
  constraintKind:
    | 'active-count'
    | 'max-concurrent'
    | 'quota'
    | 'queue-depth'
    | 'memory-budget'
    | 'capacity'
    | 'unknown';
  scope: 'global' | 'local';
  declarationLine: number;
  confidence: number;
  reasonCode: 'global-constraint';
  provenance: PressureProvenance;
  evidence: PressureImpactEvidence[];
}

export interface PressureOperation {
  kind: 'systems.pressure.operation';
  variableName: string;
  operation: 'increment' | 'decrement' | 'limit-check' | 'assignment';
  line: number;
  confidence: number;
  reasonCode: PressureReasonCode;
  provenance: PressureProvenance;
  evidence: PressureImpactEvidence[];
}

export interface PressureWarning {
  id: string;
  scope: 'ALL/global';
  severity: 'low' | 'medium' | 'high';
  confidence: number;
  message: string;
  reasonCode: PressureReasonCode;
  falsePositiveNote: string;
  evidence: PressureImpactEvidence[];
}

export interface PressureImpactReport {
  version: 1;
  tool: 'gn_pressure_impact';
  status: 'complete' | 'partial';
  sidecarRecordKind: 'systems.pressure_impact';
  provenance: PressureProvenance;
  constraints: PressureConstraint[];
  operations: PressureOperation[];
  impactScope: 'ALL/global' | 'bounded-source';
  warnings: PressureWarning[];
  systemsEvidence: PressureImpactEvidence[];
  limits: {
    maxWarnings: number;
    maxEvidence: number;
    warningsReturned: number;
    evidenceReturned: number;
    truncated: boolean;
  };
  falsePositiveNotes: string[];
  nextTools: string[];
}

const DEFAULT_MAX_WARNINGS = 50;
const DEFAULT_MAX_EVIDENCE = 100;
const HARD_MAX = 200;

export function runPressureImpact(params: PressureImpactParams): PressureImpactReport {
  const maxWarnings = normalizeLimit(params.maxWarnings, DEFAULT_MAX_WARNINGS);
  const maxEvidence = normalizeLimit(params.maxEvidence, DEFAULT_MAX_EVIDENCE);
  const provenance = provenanceFor(params);
  const lines = params.source.split(/\r?\n/);
  const constraints = findConstraints(lines, params.filePath, provenance);
  const operations = findOperations(lines, constraints, params.filePath, provenance);
  const warnings = buildWarnings(constraints, operations);
  const boundedWarnings = warnings.slice(0, maxWarnings);
  const systemsEvidence = [
    ...constraints.flatMap((constraint) => constraint.evidence),
    ...operations.flatMap((operation) => operation.evidence),
    ...boundedWarnings.flatMap((warning) => warning.evidence),
  ].slice(0, maxEvidence);
  const truncated = warnings.length > maxWarnings || systemsEvidence.length >= maxEvidence;

  return {
    version: 1,
    tool: 'gn_pressure_impact',
    status: truncated ? 'partial' : 'complete',
    sidecarRecordKind: 'systems.pressure_impact',
    provenance,
    constraints,
    operations,
    impactScope: warnings.some((warning) => warning.scope === 'ALL/global')
      ? 'ALL/global'
      : 'bounded-source',
    warnings: boundedWarnings,
    systemsEvidence,
    limits: {
      maxWarnings,
      maxEvidence,
      warningsReturned: boundedWarnings.length,
      evidenceReturned: systemsEvidence.length,
      truncated,
    },
    falsePositiveNotes: [
      'Global pressure warnings are conservative; sharding, request scoping, atomics, or external limiters may bound the blast radius.',
      'The analyzer does not prove all increment/decrement paths or interprocedural quota ownership.',
    ],
    nextTools: ['gn_concurrency_audit', 'gn_audit_logic'],
  };
}

function findConstraints(
  lines: string[],
  filePath: string,
  provenance: PressureProvenance,
): PressureConstraint[] {
  const constraints: PressureConstraint[] = [];
  lines.forEach((line, index) => {
    const declaration = parseConstraintDeclaration(line);
    if (!declaration) return;
    constraints.push({
      kind: 'systems.pressure.constraint',
      name: declaration.name,
      constraintKind: classifyConstraint(declaration.name),
      scope: braceDepthBefore(lines, index) === 0 ? 'global' : 'local',
      declarationLine: index + 1,
      confidence: 0.76,
      reasonCode: 'global-constraint',
      provenance,
      evidence: [
        evidence(
          filePath,
          index + 1,
          line,
          'constraint-like variable declaration',
          'global-constraint',
        ),
      ],
    });
  });
  return constraints;
}

function findOperations(
  lines: string[],
  constraints: PressureConstraint[],
  filePath: string,
  provenance: PressureProvenance,
): PressureOperation[] {
  const names = new Set(constraints.map((constraint) => constraint.name));
  const operations: PressureOperation[] = [];
  lines.forEach((line, index) => {
    for (const name of names) {
      const operation = parseOperation(line, name);
      if (!operation) continue;
      operations.push({
        kind: 'systems.pressure.operation',
        variableName: name,
        operation,
        line: index + 1,
        confidence: operation === 'limit-check' ? 0.68 : 0.78,
        reasonCode:
          operation === 'increment'
            ? 'constraint-increment'
            : operation === 'decrement'
              ? 'constraint-decrement'
              : 'constraint-limit-check',
        provenance,
        evidence: [
          evidence(
            filePath,
            index + 1,
            line,
            `${operation} of ${name}`,
            operation === 'increment'
              ? 'constraint-increment'
              : operation === 'decrement'
                ? 'constraint-decrement'
                : 'constraint-limit-check',
          ),
        ],
      });
    }
  });
  return operations;
}

function buildWarnings(
  constraints: PressureConstraint[],
  operations: PressureOperation[],
): PressureWarning[] {
  const warnings: PressureWarning[] = [];
  for (const constraint of constraints.filter((candidate) => candidate.scope === 'global')) {
    const relatedOps = operations.filter((operation) => operation.variableName === constraint.name);
    const increments = relatedOps.filter((operation) => operation.operation === 'increment');
    const decrements = relatedOps.filter((operation) => operation.operation === 'decrement');
    const checks = relatedOps.filter((operation) => operation.operation === 'limit-check');
    warnings.push({
      id: `pressure:global:${constraint.name}`,
      scope: 'ALL/global',
      severity: increments.length > decrements.length ? 'high' : 'medium',
      confidence: increments.length || checks.length ? 0.76 : 0.62,
      message: `${constraint.name} is a global ${constraint.constraintKind} constraint; changes can affect ALL callers sharing process state`,
      reasonCode: 'global-impact-warning',
      falsePositiveNote:
        'The variable may be test-only, process-local by deployment, reset between requests, or guarded by a higher-level scheduler.',
      evidence: [
        constraint.evidence[0],
        ...relatedOps.slice(0, 3).flatMap((operation) => operation.evidence),
      ],
    });
    if (increments.length > decrements.length) {
      warnings.push({
        id: `pressure:unbalanced:${constraint.name}`,
        scope: 'ALL/global',
        severity: 'high',
        confidence: 0.72,
        message: `${constraint.name} has more increment than decrement evidence in bounded source`,
        reasonCode: 'constraint-increment',
        falsePositiveNote:
          'The decrement may happen through deferred cleanup, RAII, finally blocks, or a helper outside this bounded source.',
        evidence: increments.slice(0, 3).flatMap((operation) => operation.evidence),
      });
    }
  }
  return warnings;
}

function parseConstraintDeclaration(line: string): { name: string } | undefined {
  const match =
    /\b(?:static\s+)?(?:std::atomic<[^>]+>|Atomic\w+|let|const|var|int|size_t|uint\d*_t|number)\s+([A-Za-z_]\w*(?:Count|Concurrent|Quota|Limit|Capacity|Depth|Budget|quota|limit|capacity|depth|budget))\b/.exec(
      line,
    );
  return match ? { name: match[1] } : undefined;
}

function parseOperation(line: string, name: string): PressureOperation['operation'] | undefined {
  const escaped = escapeRegExp(name);
  if (new RegExp(`\\b${escaped}\\s*(?:\\+\\+|\\+=\\s*1|\\.fetch_add\\s*\\()`).test(line))
    return 'increment';
  if (new RegExp(`(?:\\+\\+${escaped}\\b|\\b${escaped}\\.fetch_add\\s*\\()`).test(line))
    return 'increment';
  if (new RegExp(`\\b${escaped}\\s*(?:--|-=\\s*1|\\.fetch_sub\\s*\\()`).test(line))
    return 'decrement';
  if (new RegExp(`(?:--${escaped}\\b|\\b${escaped}\\.fetch_sub\\s*\\()`).test(line))
    return 'decrement';
  if (new RegExp(`\\b${escaped}\\b\\s*(?:[<>]=?|={2,3})`).test(line)) return 'limit-check';
  if (new RegExp(`(?:[<>]=?|={2,3})\\s*\\b${escaped}\\b`).test(line)) return 'limit-check';
  if (new RegExp(`\\b${escaped}\\s*=`).test(line)) return 'assignment';
  return undefined;
}

function classifyConstraint(name: string): PressureConstraint['constraintKind'] {
  if (/active.*count|activeCount/i.test(name)) return 'active-count';
  if (/max.*concurrent|maxConcurrent/i.test(name)) return 'max-concurrent';
  if (/quota/i.test(name)) return 'quota';
  if (/queue.*depth|depth/i.test(name)) return 'queue-depth';
  if (/memory.*budget|budget/i.test(name)) return 'memory-budget';
  if (/capacity|limit/i.test(name)) return 'capacity';
  return 'unknown';
}

function evidence(
  filePath: string,
  line: number,
  snippet: string,
  message: string,
  reasonCode: PressureReasonCode,
): PressureImpactEvidence {
  return { kind: 'source-pattern', filePath, line, snippet: snippet.trim(), message, reasonCode };
}

function provenanceFor(params: PressureImpactParams): PressureProvenance {
  return {
    analyzerId: 'gn_pressure_impact',
    analyzerVersion: '0.1.0',
    sidecarRecordKind: 'systems.pressure_impact',
    source: 'bounded-static-heuristic',
    filePath: params.filePath,
    symbol: params.symbol,
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(HARD_MAX, Math.floor(value)));
}

function braceDepthBefore(lines: string[], targetIndex: number): number {
  let depth = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    depth += countChar(lines[index], '{');
    depth -= countChar(lines[index], '}');
  }
  return depth;
}

function countChar(value: string, char: string): number {
  return [...value].filter((candidate) => candidate === char).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
