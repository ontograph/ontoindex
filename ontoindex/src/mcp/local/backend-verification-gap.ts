/**
 * Verification Gap MCP Tool
 *
 * Thin adapter over src/audit/verification-gap.ts:auditVerificationGap.
 * Compares source files changed since base_ref against test files on
 * disk + VERIFIES graph edges, and reports per-file coverage status
 * (covered / weakly_covered / uncovered).
 */
import { auditVerificationGap } from '../../audit/verification-gap.js';
import { AnalysisResult, DiagnosticFinding } from 'ontoindex-shared';

// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly id: string; readonly name: string; readonly repoPath: string };

type VerificationGapResult = AnalysisResult & {
  repo: string;
  base_ref: string;
  coverage: unknown[];
  uncovered_count: number;
  error?: string;
};

/**
 * Maps core verification gaps to normalized DiagnosticFinding (Phase D).
 */
function mapGapToFindings(gaps: any[]): DiagnosticFinding[] {
  return gaps.map((g) => {
    return {
      ruleId: 'GNV-201',
      ruleName: 'Verification Gap',
      severity: g.status === 'uncovered' ? 'critical' : 'warning',
      confidence: 0.95,
      message: `File '${g.file}' has a verification gap: ${g.gap}. Status: ${g.status}.`,
      location: {
        filePath: g.file,
      },
      properties: {
        ...g,
      },
      suggestion: 'Add corresponding tests or update documentation to bridge the verification gap.',
    };
  });
}

function caughtErrorMessage(err: unknown): unknown {
  return (err as { readonly message?: unknown } | null | undefined)?.message ?? String(err);
}

export async function runVerificationGap(
  repo: RepoHandle,
  params: { base_ref?: string },
): Promise<VerificationGapResult> {
  const start = Date.now();
  const baseRef =
    typeof params?.base_ref === 'string' && params.base_ref.trim().length > 0
      ? params.base_ref
      : 'HEAD~1';

  try {
    const response = await auditVerificationGap({
      repoId: repo.id,
      repoPath: repo.repoPath,
      baseRef,
    });
    const coverage = response.coverage ?? [];
    const findings = mapGapToFindings(coverage);

    return {
      status: 'success',
      tool: 'verification_gap',
      repo: repo.name,
      base_ref: baseRef,
      coverage,
      uncovered_count: coverage.filter((c) => c.status === 'uncovered').length,
      findings,
      summary: response.summary,
      stats: {
        totalFindings: findings.length,
        durationMs: Date.now() - start,
        baseRef,
        uncoveredCount: coverage.filter((c) => c.status === 'uncovered').length,
      },
    } as VerificationGapResult;
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'verification_gap',
      repo: repo.name,
      base_ref: baseRef,
      coverage: [],
      uncovered_count: 0,
      error: `Verification gap audit failed: ${caughtErrorMessage(err)}`,
      findings: [],
      summary: '',
      stats: { totalFindings: 0, durationMs: Date.now() - start },
      errors: [`Verification gap audit failed: ${caughtErrorMessage(err)}`],
    } as VerificationGapResult;
  }
}
