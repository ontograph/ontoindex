/**
 * Normalized diagnostic finding from an OntoIndex detector.
 *
 * Provides a stable schema for reporting issues across all analysis backends
 * (dead code, technical debt, boundary violations, etc.).
 */
export interface DiagnosticFinding {
  /** Stable ID for this specific rule/violation (e.g. 'dead_code', 'circular_dependency') */
  ruleId: string;

  /** Human-readable name of the rule */
  ruleName: string;

  /** Brief description of the finding */
  message: string;

  /** Severity of the issue */
  severity: 'critical' | 'warning' | 'advisory' | 'info';

  /** 0.0 - 1.0 confidence score from the analyzer */
  confidence: number;

  /** Location of the finding */
  location: {
    filePath: string;
    startLine?: number;
    endLine?: number;
    symbolName?: string;
  };

  /** Arbitrary properties specific to this finding type */
  properties: Record<string, unknown>;

  /** Optional suggested remediation */
  suggestion?: string;
}

/**
 * Consolidated result from an OntoIndex analysis run.
 */
export interface AnalysisResult {
  /** Name of the analyzer/tool that produced this result */
  tool: string;

  /** Status of the run */
  status: 'success' | 'error' | 'degraded';

  /** Findings produced by the analysis */
  findings: DiagnosticFinding[];

  /** Summary markdown or prose describing the overall result */
  summary: string;

  /** Statistics about the run */
  stats: {
    totalFindings: number;
    durationMs: number;
    [key: string]: unknown;
  };

  /** Any errors or warnings encountered during the run */
  errors?: string[];
  warnings?: string[];
}
