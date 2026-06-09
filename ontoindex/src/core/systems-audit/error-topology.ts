export interface ErrorTopologyParams {
  source: string;
  filePath?: string;
  symbol?: string;
  maxRecords?: number;
}

export interface ErrorTopologyNode {
  kind: 'systems-error-topology-node';
  nodeKind: 'source' | 'check' | 'catch' | 'sink' | 'swallow';
  mechanism: 'errno' | 'exception' | 'boolean' | 'null' | 'exit-code' | 'unknown';
  label: string;
  filePath?: string;
  line: number;
  confidence: number;
  reasonCodes: string[];
  whyMayBeFalsePositive: string;
  provenance: ErrorTopologyProvenance;
}

export interface ErrorTopologyEdge {
  kind: 'systems-error-topology-edge';
  from: string;
  to: string;
  relation: 'checked-by' | 'flows-to' | 'swallowed-by';
  filePath?: string;
  line: number;
  confidence: number;
  reasonCodes: string[];
  provenance: ErrorTopologyProvenance;
}

export interface ErrorTopologyEvidence {
  kind: 'source-pattern' | 'derived-state';
  message: string;
  filePath?: string;
  line?: number;
  snippet?: string;
}

export interface ErrorTopologyFinding {
  kind: 'systems-error-topology-finding';
  category: 'swallowed-error' | 'generic-exit-code' | 'unchecked-error-source';
  severity: 'info' | 'low' | 'medium' | 'high';
  message: string;
  filePath?: string;
  line?: number;
  confidence: number;
  reasonCodes: string[];
  whyMayBeFalsePositive: string;
  evidence: ErrorTopologyEvidence[];
  provenance: ErrorTopologyProvenance;
}

export interface ErrorTopologyProvenance {
  recordKind: 'systems.error_topology';
  analyzerId: 'gn_error_topology';
  analyzerVersion: typeof ERROR_TOPOLOGY_VERSION;
  promotedToPrimaryGraph: false;
}

export interface ErrorTopologyReport {
  version: 1;
  tool: 'gn_error_topology';
  status: 'ok' | 'partial' | 'unresolved';
  target: {
    path?: string;
    symbol?: string;
  };
  primaryGraphFacts: [];
  systemsEvidence: ErrorTopologyEvidence[];
  nodes: ErrorTopologyNode[];
  edges: ErrorTopologyEdge[];
  findings: ErrorTopologyFinding[];
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

const ERROR_TOPOLOGY_VERSION = '0.1.0';
const DEFAULT_MAX_RECORDS = 50;
const MAX_RECORDS = 200;
const provenance: ErrorTopologyProvenance = {
  recordKind: 'systems.error_topology',
  analyzerId: 'gn_error_topology',
  analyzerVersion: ERROR_TOPOLOGY_VERSION,
  promotedToPrimaryGraph: false,
};

const ERROR_SOURCES =
  /\b(open|read|write|close|socket|connect|bind|listen|accept|fork|execve|waitpid|malloc|fopen|fread|fwrite|rename|unlink)\s*\(/;
const ERROR_CHECKS =
  /(==\s*-1|<\s*0|!\s*[A-Za-z_]\w*|==\s*NULL|==\s*nullptr|catch\s*\(|\.catch\s*\()/;
const LOG_SINKS =
  /\b(perror|fprintf\s*\(\s*stderr|console\.error|logger\.(error|warn)|log\.(error|warn)|syslog|throw\s+|return\s+Err|Result::Err)\b/;
const USER_SINKS = /\b(alert|toast|res\.status|response\.status|sendError|showError|printf)\s*\(/;

export function analyzeErrorTopology(params: ErrorTopologyParams): ErrorTopologyReport {
  const maxRecords = normalizeLimit(params.maxRecords, DEFAULT_MAX_RECORDS, MAX_RECORDS);
  const nodes: ErrorTopologyNode[] = [];
  const edges: ErrorTopologyEdge[] = [];
  const findings: ErrorTopologyFinding[] = [];
  const recentSources: ErrorTopologyNode[] = [];
  const lines = params.source.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = stripComment(rawLine).trim();
    if (!line) return;
    const lineNumber = index + 1;
    const sourceCall = ERROR_SOURCES.exec(line);
    if (sourceCall) {
      const sourceNode = node(
        'source',
        mechanismForSource(sourceCall[1]),
        sourceCall[1],
        params.filePath,
        lineNumber,
        ['error-source-call'],
      );
      nodes.push(sourceNode);
      recentSources.push(sourceNode);
    }

    if (ERROR_CHECKS.test(line)) {
      const check = node('check', mechanismForCheck(line), line, params.filePath, lineNumber, [
        'error-check',
      ]);
      nodes.push(check);
      linkRecentSources(recentSources, check, edges, 'checked-by');
    }

    if (/\bcatch\s*\(|\.catch\s*\(/.test(line)) {
      const catchNode = node('catch', 'exception', line, params.filePath, lineNumber, [
        'catch-block',
      ]);
      nodes.push(catchNode);
      if (isSwallow(lines, index)) {
        const swallow = node(
          'swallow',
          'exception',
          'empty or non-propagating catch',
          params.filePath,
          lineNumber,
          ['swallowed-error'],
        );
        nodes.push(swallow);
        edges.push(edge(catchNode, swallow, 'swallowed-by'));
        findings.push(
          finding(
            'swallowed-error',
            'medium',
            'catch block appears to swallow an error without logging, rethrow, return, or user-facing sink',
            params.filePath,
            lineNumber,
            ['catch-block', 'no-observed-sink'],
            [line],
          ),
        );
      }
    }

    if (LOG_SINKS.test(line) || USER_SINKS.test(line)) {
      const sink = node(
        'sink',
        /\bthrow\s+|return\s+Err|Result::Err/.test(line) ? 'exception' : 'unknown',
        line,
        params.filePath,
        lineNumber,
        LOG_SINKS.test(line) ? ['logging-sink'] : ['user-facing-sink'],
      );
      nodes.push(sink);
      linkRecentSources(recentSources, sink, edges, 'flows-to');
    }

    if (/\b(exit|process\.exit)\s*\(\s*1\s*\)/.test(line)) {
      findings.push(
        finding(
          'generic-exit-code',
          'low',
          'generic exit code collapses distinct error paths',
          params.filePath,
          lineNumber,
          ['generic-exit-code'],
          [line],
        ),
      );
    }
  });

  findings.push(...uncheckedSourceFindings(nodes, edges, params.filePath));
  const records = [...nodes, ...edges, ...findings];
  const boundedRecords = records.slice(0, maxRecords);
  const boundedNodeCount = boundedRecords.filter(
    (record) => record.kind === 'systems-error-topology-node',
  ).length;
  const boundedEdgeCount = boundedRecords.filter(
    (record) => record.kind === 'systems-error-topology-edge',
  ).length;
  const boundedFindingCount = boundedRecords.filter(
    (record) => record.kind === 'systems-error-topology-finding',
  ).length;
  const boundedNodes = nodes.slice(0, boundedNodeCount);
  const boundedEdges = edges.slice(0, boundedEdgeCount);
  const boundedFindings = findings.slice(0, boundedFindingCount);
  const total = records.length;

  return {
    version: 1,
    tool: 'gn_error_topology',
    status: total > maxRecords ? 'partial' : nodes.length === 0 ? 'unresolved' : 'ok',
    target: {
      path: params.filePath,
      symbol: params.symbol,
    },
    primaryGraphFacts: [],
    systemsEvidence: [
      ...boundedNodes.map((record) => evidence(record, `${record.nodeKind}: ${record.label}`)),
      ...boundedFindings.flatMap((record) => record.evidence),
    ],
    nodes: boundedNodes,
    edges: boundedEdges,
    findings: boundedFindings,
    limits: {
      truncated: total > maxRecords,
      maxRecords,
      emitted: boundedRecords.length,
      total,
    },
    freshness: {
      status: 'not-applicable',
      reason: 'error topology MVP consumes caller-supplied source only',
    },
    skipReasons:
      nodes.length === 0 ? ['no syscall, error-return, catch, or sink patterns found'] : [],
    warnings: [
      'bounded static heuristic: no symbolic execution, exception type resolution, alias tracking, or interprocedural flow',
    ],
    nextTools: ['gn_audit_logic'],
  };
}

function node(
  nodeKind: ErrorTopologyNode['nodeKind'],
  mechanism: ErrorTopologyNode['mechanism'],
  label: string,
  filePath: string | undefined,
  line: number,
  reasonCodes: string[],
): ErrorTopologyNode {
  return {
    kind: 'systems-error-topology-node',
    nodeKind,
    mechanism,
    label,
    filePath,
    line,
    confidence: nodeKind === 'source' ? 0.72 : 0.78,
    reasonCodes,
    whyMayBeFalsePositive:
      'pattern may be in dead code, tests, comments not stripped by the bounded scanner, or handled by wrappers outside the snippet',
    provenance,
  };
}

function edge(
  from: ErrorTopologyNode,
  to: ErrorTopologyNode,
  relation: ErrorTopologyEdge['relation'],
): ErrorTopologyEdge {
  return {
    kind: 'systems-error-topology-edge',
    from: `${from.nodeKind}:${from.line}:${from.label}`,
    to: `${to.nodeKind}:${to.line}:${to.label}`,
    relation,
    filePath: from.filePath,
    line: to.line,
    confidence: 0.62,
    reasonCodes: ['nearby-line-flow'],
    provenance,
  };
}

function finding(
  category: ErrorTopologyFinding['category'],
  severity: ErrorTopologyFinding['severity'],
  message: string,
  filePath: string | undefined,
  line: number,
  reasonCodes: string[],
  snippets: string[],
): ErrorTopologyFinding {
  return {
    kind: 'systems-error-topology-finding',
    category,
    severity,
    message,
    filePath,
    line,
    confidence: category === 'unchecked-error-source' ? 0.58 : 0.7,
    reasonCodes,
    whyMayBeFalsePositive:
      'the error path may be handled by a helper, deferred cleanup, RAII, framework middleware, or a path outside the bounded source',
    evidence: snippets.map((snippet) => ({
      kind: 'source-pattern',
      message,
      filePath,
      line,
      snippet,
    })),
    provenance,
  };
}

function linkRecentSources(
  recentSources: ErrorTopologyNode[],
  target: ErrorTopologyNode,
  edges: ErrorTopologyEdge[],
  relation: ErrorTopologyEdge['relation'],
): void {
  for (const source of recentSources.slice(-3)) {
    if (target.line - source.line <= 5) {
      edges.push(edge(source, target, relation));
    }
  }
}

function uncheckedSourceFindings(
  nodes: ErrorTopologyNode[],
  edges: ErrorTopologyEdge[],
  filePath: string | undefined,
): ErrorTopologyFinding[] {
  const checkedSources = new Set(edges.map((edgeRecord) => edgeRecord.from));
  return nodes
    .filter((record) => record.nodeKind === 'source')
    .filter((record) => !checkedSources.has(`${record.nodeKind}:${record.line}:${record.label}`))
    .map((record) =>
      finding(
        'unchecked-error-source',
        'medium',
        `error-return source ${record.label} has no nearby check or sink`,
        filePath,
        record.line,
        ['unchecked-error-source'],
        [record.label],
      ),
    );
}

function isSwallow(lines: string[], catchIndex: number): boolean {
  const body = lines
    .slice(catchIndex, Math.min(lines.length, catchIndex + 5))
    .map(stripComment)
    .join('\n');
  return !/(throw\b|return\b|perror|console\.error|logger\.|log\.|syslog|fprintf\s*\(\s*stderr|alert|toast|sendError|showError)/.test(
    body,
  );
}

function mechanismForSource(call: string): ErrorTopologyNode['mechanism'] {
  if (
    [
      'open',
      'read',
      'write',
      'close',
      'socket',
      'connect',
      'bind',
      'listen',
      'accept',
      'fork',
      'execve',
      'waitpid',
    ].includes(call)
  ) {
    return 'errno';
  }
  if (['malloc', 'fopen', 'fread', 'fwrite'].includes(call)) return 'null';
  return 'unknown';
}

function mechanismForCheck(line: string): ErrorTopologyNode['mechanism'] {
  if (/(==\s*-1|<\s*0)/.test(line)) return 'errno';
  if (/(==\s*NULL|==\s*nullptr)/.test(line)) return 'null';
  if (/catch\s*\(|\.catch\s*\(/.test(line)) return 'exception';
  if (/!\s*[A-Za-z_]\w*/.test(line)) return 'boolean';
  return 'unknown';
}

function evidence(record: ErrorTopologyNode, message: string): ErrorTopologyEvidence {
  return {
    kind:
      record.nodeKind === 'sink' || record.nodeKind === 'check'
        ? 'source-pattern'
        : 'derived-state',
    message,
    filePath: record.filePath,
    line: record.line,
    snippet: record.label,
  };
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function stripComment(line: string): string {
  return line.replace(/\/\/.*$/, '');
}
