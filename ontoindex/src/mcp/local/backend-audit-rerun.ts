/**
 * Audit Rerun MCP Tool
 *
 * Takes a saved audit findings file (typically produced by a prior
 * pattern_audit / build_residue_audit run, or hand-authored) and
 * re-verifies each finding against the current filesystem.
 *
 * For each finding we open the referenced file once and classify the
 * result against the recorded line:
 *   - still_open: the recorded line still matches (or the file no
 *                 longer has any occurrences of the snippet — see
 *                 below for the snippet-fallback rule).
 *   - moved:     the pattern/snippet shows up elsewhere in the file
 *                but no longer at the recorded line.
 *   - fixed:     no occurrence anywhere in the file (the recorded
 *                snippet is the authoritative marker).
 *   - missing_file: the referenced file can no longer be opened.
 *   - invalid:   the finding entry was unreadable (no file path).
 *
 * This tool deliberately does not re-run the whole pattern ruleset —
 * its job is to answer "are these specific findings still live?", not
 * "are there new findings?". For fresh scans use pattern_audit.
 */
import fs from 'fs/promises';
import { resolveContainedRepoPath } from './backend-repo-paths.js';
// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly name: string; readonly repoPath: string };

interface AuditFinding {
  id?: string;
  pattern?: string;
  file: string;
  line?: number;
  snippet?: string;
  status?: string;
  [k: string]: unknown;
}

interface AuditFindingResult {
  id?: string;
  file: string;
  pattern?: string;
  recorded_line?: number;
  status: 'still_open' | 'moved' | 'fixed' | 'missing_file' | 'invalid';
  current_line?: number;
  detail?: string;
}

function legacyErrorMessage(err: unknown): string {
  return (err as { readonly message: string }).message;
}

function parseAuditBody(raw: string): AuditFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`Audit file is not valid JSON: ${legacyErrorMessage(err)}`);
  }
  if (Array.isArray(parsed)) return parsed as AuditFinding[];
  if (parsed && typeof parsed === 'object') {
    const findings = (parsed as { findings?: unknown }).findings;
    if (Array.isArray(findings)) return findings as AuditFinding[];
  }
  throw new Error(
    'Audit file must be either a JSON array of findings or an object with a "findings" array.',
  );
}

/**
 * Resolve an audit_file arg to an absolute path. Accepts both absolute
 * and repo-relative paths; rejects anything that escapes the repo root
 * so the tool can't be coerced into reading arbitrary filesystem
 * locations outside the indexed repo.
 */
function resolveAuditPath(repoPath: string, rawPath: string): string {
  const abs = resolveContainedRepoPath(repoPath, rawPath);
  if (!abs) throw new Error('audit_file must resolve inside the indexed repo root.');
  return abs;
}

function resolveFindingFile(repoPath: string, filePath: string): string | null {
  return resolveContainedRepoPath(repoPath, filePath);
}

function classifyFinding(
  finding: AuditFinding,
  fileContent: string,
): { status: AuditFindingResult['status']; currentLine?: number; detail?: string } {
  const lines = fileContent.split('\n');
  const snippet = typeof finding.snippet === 'string' ? finding.snippet.trim() : '';
  const recordedLine = typeof finding.line === 'number' ? finding.line : undefined;

  // Strategy 1: exact snippet match on the recorded line.
  if (snippet && recordedLine && recordedLine >= 1 && recordedLine <= lines.length) {
    if (lines[recordedLine - 1].includes(snippet)) {
      return { status: 'still_open', currentLine: recordedLine };
    }
  }

  // Strategy 2: snippet exists elsewhere in the file -> moved.
  if (snippet) {
    const idx = lines.findIndex((l) => l.includes(snippet));
    if (idx >= 0) return { status: 'moved', currentLine: idx + 1 };
    return { status: 'fixed' };
  }

  // Strategy 3: no snippet recorded — fall back to the pattern literal.
  const pattern = typeof finding.pattern === 'string' ? finding.pattern : '';
  if (pattern) {
    if (recordedLine && recordedLine >= 1 && recordedLine <= lines.length) {
      if (lines[recordedLine - 1].includes(pattern)) {
        return { status: 'still_open', currentLine: recordedLine };
      }
    }
    const idx = lines.findIndex((l) => l.includes(pattern));
    if (idx >= 0) return { status: 'moved', currentLine: idx + 1 };
    return { status: 'fixed' };
  }

  return { status: 'invalid', detail: 'finding has neither snippet nor pattern to match on.' };
}

export async function runAuditRerun(
  repo: RepoHandle,
  params: { audit_file?: string },
): Promise<{
  status: 'success' | 'error';
  tool: 'audit_rerun';
  repo: string;
  audit_file?: string;
  total?: number;
  still_open?: number;
  moved?: number;
  fixed?: number;
  missing_file?: number;
  invalid?: number;
  findings?: AuditFindingResult[];
  error?: string;
}> {
  if (!params?.audit_file || typeof params.audit_file !== 'string') {
    return {
      status: 'error',
      tool: 'audit_rerun',
      repo: repo.name,
      error: 'audit_file (string) is required.',
    };
  }

  let auditAbs: string;
  try {
    auditAbs = resolveAuditPath(repo.repoPath, params.audit_file);
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'audit_rerun',
      repo: repo.name,
      error: legacyErrorMessage(err),
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(auditAbs, 'utf8');
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'audit_rerun',
      repo: repo.name,
      audit_file: params.audit_file,
      error: `Unable to read audit file: ${legacyErrorMessage(err)}`,
    };
  }

  let findings: AuditFinding[];
  try {
    findings = parseAuditBody(raw);
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'audit_rerun',
      repo: repo.name,
      audit_file: params.audit_file,
      error: legacyErrorMessage(err),
    };
  }

  // Group by file so each file is read from disk once.
  const byFile = new Map<string, AuditFinding[]>();
  const invalidEntries: AuditFinding[] = [];
  for (const f of findings) {
    if (!f || typeof f.file !== 'string' || f.file.length === 0) {
      invalidEntries.push(f);
      continue;
    }
    const abs = resolveFindingFile(repo.repoPath, f.file);
    if (!abs) {
      invalidEntries.push(f);
      continue;
    }
    if (!byFile.has(abs)) byFile.set(abs, []);
    byFile.get(abs)!.push(f);
  }

  const results: AuditFindingResult[] = [];
  const counts = { still_open: 0, moved: 0, fixed: 0, missing_file: 0, invalid: 0 };

  for (const f of invalidEntries) {
    results.push({
      id: f?.id,
      file: typeof f?.file === 'string' ? f.file : '',
      pattern: typeof f?.pattern === 'string' ? f.pattern : undefined,
      recorded_line: typeof f?.line === 'number' ? f.line : undefined,
      status: 'invalid',
      detail: 'Missing or out-of-repo file path.',
    });
    counts.invalid++;
  }

  for (const [abs, group] of byFile) {
    let content: string | null = null;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      content = null;
    }

    if (content === null) {
      for (const f of group) {
        results.push({
          id: f.id,
          file: f.file,
          pattern: f.pattern,
          recorded_line: f.line,
          status: 'missing_file',
        });
        counts.missing_file++;
      }
      continue;
    }

    for (const f of group) {
      const { status, currentLine, detail } = classifyFinding(f, content);
      results.push({
        id: f.id,
        file: f.file,
        pattern: f.pattern,
        recorded_line: f.line,
        status,
        current_line: currentLine,
        detail,
      });
      counts[status]++;
    }
  }

  results.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    const la = a.recorded_line ?? 0;
    const lb = b.recorded_line ?? 0;
    return la - lb;
  });

  return {
    status: 'success',
    tool: 'audit_rerun',
    repo: repo.name,
    audit_file: params.audit_file,
    total: results.length,
    still_open: counts.still_open,
    moved: counts.moved,
    fixed: counts.fixed,
    missing_file: counts.missing_file,
    invalid: counts.invalid,
    findings: results,
  };
}
