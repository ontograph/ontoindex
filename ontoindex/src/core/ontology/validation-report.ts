export type OntologyConstraintSeverity = 'violation' | 'warning' | 'info';

export type OntologyConstraintAuditSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface OntologyConstraintFindingInput {
  focusNode: unknown;
  sourceShape: unknown;
  resultPath?: unknown;
  message: unknown;
  severity?: unknown;
  evidence?: unknown;
  metadata?: unknown;
}

export interface OntologyConstraintValidationResult {
  focusNode: string;
  sourceShape: string;
  resultPath?: string;
  message: string;
  severity: OntologyConstraintSeverity;
  auditSeverity: OntologyConstraintAuditSeverity;
  evidence?: unknown;
  metadata?: unknown;
}

export interface OntologyConstraintValidationCounts {
  total: number;
  violation: number;
  warning: number;
  info: number;
}

export interface OntologyConstraintValidationInput {
  findings?: readonly OntologyConstraintFindingInput[];
  maxResults?: number;
  maxRenderedBytes?: number;
}

export interface OntologyConstraintValidationTruncation {
  resultsOmitted: number;
  renderedTextTruncated: boolean;
  renderedBytes: number;
  renderedBytesLimit?: number;
}

export interface OntologyConstraintValidationReport {
  conforms: boolean;
  results: readonly OntologyConstraintValidationResult[];
  counts: OntologyConstraintValidationCounts;
  truncation: OntologyConstraintValidationTruncation;
  renderedText?: string;
}

const SEVERITY_RANK: Record<OntologyConstraintSeverity, number> = {
  violation: 0,
  warning: 1,
  info: 2,
};

export function mapOntologyConstraintSeverityToAuditSeverity(
  severity: OntologyConstraintSeverity,
): OntologyConstraintAuditSeverity {
  switch (severity) {
    case 'violation':
      return 'HIGH';
    case 'warning':
      return 'MEDIUM';
    case 'info':
      return 'LOW';
  }
}

function asNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function normalizeRequiredString(
  value: unknown,
  field: 'focusNode' | 'sourceShape' | 'message',
): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${field} to be a string.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Expected ${field} to be a non-empty string.`);
  }

  return normalized;
}

function normalizeOptionalString(
  value: unknown,
  field: 'resultPath',
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`Expected ${field} to be a string.`);
  }

  return value.trim();
}

function isKnownSeverity(value: unknown): value is OntologyConstraintSeverity {
  if (typeof value !== 'string') {
    return false;
  }

  return value === 'violation' || value === 'warning' || value === 'info';
}

function truncateUtf8(value: string, maxBytes: number): {
  truncated: boolean;
  rendered: string;
  renderedBytes: number;
  truncatedBytes: number;
} {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    return {
      truncated: false,
      rendered: value,
      renderedBytes: Buffer.byteLength(value, 'utf8'),
      truncatedBytes: 0,
    };
  }

  const fullBytes = Buffer.byteLength(value, 'utf8');
  if (fullBytes <= maxBytes) {
    return {
      truncated: false,
      rendered: value,
      renderedBytes: fullBytes,
      truncatedBytes: 0,
    };
  }

  let rendered = '';
  let renderedBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (renderedBytes + charBytes > maxBytes) {
      break;
    }
    rendered += char;
    renderedBytes += charBytes;
  }

  return {
    truncated: true,
    rendered,
    renderedBytes,
    truncatedBytes: fullBytes - renderedBytes,
  };
}

function formatRenderedText(results: readonly OntologyConstraintValidationResult[]): string {
  return results
    .map(
      (result, index) =>
        `${index + 1}. ${result.severity.toUpperCase()} [${result.focusNode}] ${result.sourceShape} ${result.message}`,
    )
    .join('\n');
}

export function buildOntologyValidationReport(
  input: OntologyConstraintValidationInput = {},
): OntologyConstraintValidationReport {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const resolvedMaxResults = asNonNegativeInteger(input.maxResults);
  const resolvedMaxRenderedBytes =
    typeof input.maxRenderedBytes === 'number' && input.maxRenderedBytes >= 0
      ? Math.floor(input.maxRenderedBytes)
      : undefined;

  const counts: OntologyConstraintValidationCounts = {
    total: 0,
    violation: 0,
    warning: 0,
    info: 0,
  };

  const normalizedResults: OntologyConstraintValidationResult[] = [];

  for (const finding of findings) {
    const focusNode = normalizeRequiredString(finding.focusNode, 'focusNode');
    const sourceShape = normalizeRequiredString(finding.sourceShape, 'sourceShape');
    const resultPath = normalizeOptionalString(finding.resultPath, 'resultPath');
    const message = normalizeRequiredString(finding.message, 'message');
    const severity =
      finding.severity === undefined
        ? 'violation'
        : isKnownSeverity(finding.severity)
          ? finding.severity
          : (() => {
              throw new Error(`Unknown ontology constraint severity: ${String(finding.severity)}`);
            })();

    const result: OntologyConstraintValidationResult = {
      focusNode,
      sourceShape,
      message,
      severity,
      auditSeverity: mapOntologyConstraintSeverityToAuditSeverity(severity),
      evidence: finding.evidence,
      metadata: finding.metadata,
    };

    if (resultPath !== undefined) {
      result.resultPath = resultPath;
    }

    counts.total += 1;
    if (severity === 'violation') {
      counts.violation += 1;
    } else if (severity === 'warning') {
      counts.warning += 1;
    } else {
      counts.info += 1;
    }

    normalizedResults.push(result);
  }

  const sortedResults = [...normalizedResults].sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }

    const byFocusNode = left.focusNode.localeCompare(right.focusNode);
    if (byFocusNode !== 0) {
      return byFocusNode;
    }

    const bySourceShape = left.sourceShape.localeCompare(right.sourceShape);
    if (bySourceShape !== 0) {
      return bySourceShape;
    }

    const byResultPath = (left.resultPath ?? '').localeCompare(right.resultPath ?? '');
    if (byResultPath !== 0) {
      return byResultPath;
    }

    return left.message.localeCompare(right.message);
  });

  const emittedResults =
    resolvedMaxResults === undefined
      ? sortedResults
      : sortedResults.slice(0, resolvedMaxResults);

  const rendered = formatRenderedText(sortedResults);
  const renderedTextTruncation =
    resolvedMaxRenderedBytes === undefined
      ? {
          truncated: false,
          rendered,
          renderedBytes: Buffer.byteLength(rendered, 'utf8'),
          truncatedBytes: 0,
        }
      : truncateUtf8(rendered, resolvedMaxRenderedBytes);

  return {
    conforms: counts.violation === 0,
    results: emittedResults,
    counts,
    truncation: {
      resultsOmitted: sortedResults.length - emittedResults.length,
      renderedTextTruncated: renderedTextTruncation.truncated,
      renderedBytes: renderedTextTruncation.renderedBytes,
      renderedBytesLimit: resolvedMaxRenderedBytes,
    },
    renderedText: renderedTextTruncation.rendered,
  };
}
