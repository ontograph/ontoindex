/**
 * Cross-Doc Drift MCP Tool
 *
 * Detects contradictions between project plan docs and audit JSON
 * files: a task marked as "done" / "resolved" / "completed" / "✅" /
 * "[x]" in a plan while the same task id still shows an open status
 * (or no status) in an audit file is a drift entry.
 *
 * Task id pattern is the canonical OntoIndex style — an uppercase
 * prefix, a dash, and a digit-group that may carry dots or dashes
 * (e.g. `T-1.2.03`, `REQ-001`, `MCP-A.04`). The check is symmetric:
 * any id that appears in both a plan (done) and an audit (open) is
 * reported, regardless of which file was scanned first.
 *
 * The tool does not follow globs in its default mode. It walks the
 * obvious default locations (`docs/` for plans, `audits/` and `audit/`
 * for audits) and honours explicit file lists supplied by the caller
 * after path-escape checks.
 */
import fs from 'fs/promises';
import path from 'path';
import { resolveContainedRepoPath } from './backend-repo-paths.js';
import { AnalysisResult, DiagnosticFinding } from 'ontoindex-shared';

// Local RepoHandle alias — see backend-route.ts note.
type RepoHandle = { readonly name: string; readonly repoPath: string };

/**
 * Maps internal DriftEntry to normalized DiagnosticFinding (Phase D).
 */
function mapDriftToFindings(entries: DriftEntry[]): DiagnosticFinding[] {
  return entries.map((e) => {
    return {
      ruleId: 'GND-301',
      ruleName: 'Cross-Doc Drift',
      severity: 'warning',
      confidence: 1.0,
      message: `Task '${e.id}' is marked as DONE in plan doc, but remains OPEN in audit record.`,
      location: {
        filePath: e.plan_file,
        startLine: e.plan_line,
      },
      properties: {
        taskId: e.id,
        planSnippet: e.plan_snippet,
        auditFile: e.audit_file,
        auditStatus: e.audit_status,
      },
      suggestion:
        'Synchronize the documentation by either closing the audit finding or reverting the plan status.',
    };
  });
}

interface DriftEntry {
  id: string;
  plan_file: string;
  plan_line: number;
  plan_snippet: string;
  audit_file: string;
  audit_status: string;
}

interface CrossDocDriftResult {
  status: 'success' | 'error';
  tool: 'cross_doc_drift';
  repo: string;
  plan_files_scanned: string[];
  audit_files_scanned: string[];
  drift_count: number;
  drifts: DriftEntry[];
  error?: string;
}

const TASK_ID_REGEX = /\b([A-Z][A-Z0-9_]*-\d+(?:[.\-][0-9A-Za-z]+)*)\b/g;
const DONE_MARKER_REGEX =
  /(\bdone\b|\bresolved\b|\bcompleted?\b|\bfixed\b|\bclosed\b|✅|\[x\]|\[X\])/;

// Statuses that mean "the audit finding is still live".
const OPEN_STATUSES = new Set([
  'open',
  'in_progress',
  'in-progress',
  'pending',
  'active',
  'unresolved',
  'todo',
  'new',
]);

// Explicit closed-status set — anything outside both sets is treated
// as open (i.e. we fail open rather than hiding potential drift).
const CLOSED_STATUSES = new Set(['done', 'resolved', 'fixed', 'closed', 'complete', 'completed']);
const MAX_SCAN_FILES = 2_000;
const MAX_PLAN_FILE_BYTES = 512 * 1024;
const MAX_AUDIT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_MENTIONS = 20_000;
const MAX_AUDIT_RECORDS = 50_000;
const MAX_DRIFTS = 20_000;
const MAX_JSON_VISIT_DEPTH = 20;

async function walkDir(root: string, extension: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && results.length < MAX_SCAN_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        results.push(full);
        if (results.length >= MAX_SCAN_FILES) break;
      }
    }
  }
  return results;
}

async function resolveInputList(
  repoPath: string,
  rawList: unknown,
  defaultDirs: string[],
  extension: string,
): Promise<string[]> {
  const resolved: string[] = [];
  if (Array.isArray(rawList) && rawList.length > 0) {
    for (const raw of rawList) {
      const abs = resolveContainedRepoPath(repoPath, raw as string);
      if (!abs) continue;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const inner = await walkDir(abs, extension);
        resolved.push(...inner);
        if (resolved.length >= MAX_SCAN_FILES) break;
      } else if (stat.isFile()) {
        resolved.push(abs);
        if (resolved.length >= MAX_SCAN_FILES) break;
      }
    }
  } else {
    for (const dir of defaultDirs) {
      const abs = resolveContainedRepoPath(repoPath, dir);
      if (!abs) continue;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const inner = await walkDir(abs, extension);
        resolved.push(...inner);
        if (resolved.length >= MAX_SCAN_FILES) break;
      }
    }
  }
  return Array.from(new Set(resolved)).slice(0, MAX_SCAN_FILES);
}

interface PlanMention {
  id: string;
  file: string;
  line: number;
  snippet: string;
}

function scanPlanContent(content: string, rel: string): PlanMention[] {
  const mentions: PlanMention[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (mentions.length >= MAX_PLAN_MENTIONS) break;
    const line = lines[i];
    if (!DONE_MARKER_REGEX.test(line)) continue;
    // matchAll returns all non-overlapping matches for the global regex.
    for (const match of line.matchAll(TASK_ID_REGEX)) {
      mentions.push({
        id: match[1],
        file: rel,
        line: i + 1,
        snippet: line.trim().slice(0, 240),
      });
      if (mentions.length >= MAX_PLAN_MENTIONS) break;
    }
  }
  return mentions;
}

interface AuditRecord {
  id: string;
  file: string;
  status: string;
}

function extractAuditRecords(parsed: unknown, rel: string): AuditRecord[] {
  const records: AuditRecord[] = [];
  const visit = (node: unknown, depth = 0): void => {
    if (records.length >= MAX_AUDIT_RECORDS || depth > MAX_JSON_VISIT_DEPTH) return;
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
        if (records.length >= MAX_AUDIT_RECORDS) break;
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    const rawId = obj.id ?? obj.task_id ?? obj.taskId;
    if (typeof rawId === 'string' && rawId.length > 0) {
      const rawStatus = obj.status;
      const status =
        typeof rawStatus === 'string' && rawStatus.length > 0 ? rawStatus : 'unspecified';
      records.push({ id: rawId, file: rel, status });
    }
    // Recurse into nested findings arrays / children.
    for (const value of Object.values(obj)) {
      if (records.length >= MAX_AUDIT_RECORDS) break;
      if (Array.isArray(value) || (value && typeof value === 'object')) visit(value, depth + 1);
    }
  };
  visit(parsed);
  return records;
}

function isOpenStatus(status: string): boolean {
  const normalized = status.toLowerCase().trim();
  if (OPEN_STATUSES.has(normalized)) return true;
  if (CLOSED_STATUSES.has(normalized)) return false;
  // Unknown status -> treat as open so drift is surfaced, not hidden.
  return true;
}

function formatCaughtMessage(err: unknown): unknown {
  const message =
    err !== null && err !== undefined && (typeof err === 'object' || typeof err === 'function')
      ? (err as { message?: unknown }).message
      : undefined;
  return message ?? String(err);
}

export async function runCrossDocDrift(
  repo: RepoHandle,
  params: { plan_files?: string[]; audit_files?: string[] },
): Promise<AnalysisResult & CrossDocDriftResult> {
  const start = Date.now();
  try {
    const planAbs = await resolveInputList(repo.repoPath, params?.plan_files, ['docs'], '.md');
    const auditAbs = await resolveInputList(
      repo.repoPath,
      params?.audit_files,
      ['audits', 'audit'],
      '.json',
    );

    const planRel = planAbs.map((abs) => path.relative(repo.repoPath, abs));
    const auditRel = auditAbs.map((abs) => path.relative(repo.repoPath, abs));

    // Collect plan mentions.
    const planMentions = new Map<string, PlanMention[]>();
    let totalPlanMentions = 0;
    for (let i = 0; i < planAbs.length; i++) {
      if (totalPlanMentions >= MAX_PLAN_MENTIONS) break;
      let content: string;
      try {
        const stat = await fs.stat(planAbs[i]);
        if (stat.size > MAX_PLAN_FILE_BYTES) continue;
        content = await fs.readFile(planAbs[i], 'utf8');
      } catch {
        continue;
      }
      const hits = scanPlanContent(content, planRel[i]);
      for (const hit of hits) {
        if (totalPlanMentions >= MAX_PLAN_MENTIONS) break;
        if (!planMentions.has(hit.id)) planMentions.set(hit.id, []);
        planMentions.get(hit.id)!.push(hit);
        totalPlanMentions++;
      }
    }

    // Collect audit records.
    const auditRecords = new Map<string, AuditRecord[]>();
    let totalAuditRecords = 0;
    for (let i = 0; i < auditAbs.length; i++) {
      if (totalAuditRecords >= MAX_AUDIT_RECORDS) break;
      let raw: string;
      try {
        const stat = await fs.stat(auditAbs[i]);
        if (stat.size > MAX_AUDIT_FILE_BYTES) continue;
        raw = await fs.readFile(auditAbs[i], 'utf8');
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // skip malformed audit files — scanning is best-effort.
      }
      const records = extractAuditRecords(parsed, auditRel[i]);
      for (const record of records) {
        if (totalAuditRecords >= MAX_AUDIT_RECORDS) break;
        if (!auditRecords.has(record.id)) auditRecords.set(record.id, []);
        auditRecords.get(record.id)!.push(record);
        totalAuditRecords++;
      }
    }

    // Cross-reference: plan claims done, audit has an open record.
    const drifts: DriftEntry[] = [];
    for (const [id, mentions] of planMentions) {
      if (drifts.length >= MAX_DRIFTS) break;
      const records = auditRecords.get(id);
      if (!records) continue;
      for (const record of records) {
        if (drifts.length >= MAX_DRIFTS) break;
        if (!isOpenStatus(record.status)) continue;
        // Only report the first plan mention per (id, audit) pair so
        // the report stays compact; callers can look up the plan file
        // themselves for additional context.
        const mention = mentions[0];
        drifts.push({
          id,
          plan_file: mention.file,
          plan_line: mention.line,
          plan_snippet: mention.snippet,
          audit_file: record.file,
          audit_status: record.status,
        });
      }
    }

    drifts.sort((a, b) => {
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      if (a.audit_file !== b.audit_file) return a.audit_file < b.audit_file ? -1 : 1;
      return a.audit_status < b.audit_status ? -1 : 1;
    });

    const summary = `Scanned ${planRel.length} plan docs and ${auditRel.length} audit files. Detected ${drifts.length} contradictions between claimed task status and audit records.`;

    return {
      status: 'success',
      tool: 'cross_doc_drift',
      repo: repo.name,
      plan_files_scanned: planRel,
      audit_files_scanned: auditRel,
      drift_count: drifts.length,
      drifts,
      findings: mapDriftToFindings(drifts),
      summary,
      stats: {
        totalFindings: drifts.length,
        durationMs: Date.now() - start,
        planFilesScanned: planRel.length,
        auditFilesScanned: auditRel.length,
      },
    } as AnalysisResult & CrossDocDriftResult;
  } catch (err: unknown) {
    return {
      status: 'error',
      tool: 'cross_doc_drift',
      repo: repo.name,
      plan_files_scanned: [],
      audit_files_scanned: [],
      drift_count: 0,
      drifts: [],
      error: `Cross-doc drift check failed: ${formatCaughtMessage(err)}`,
      findings: [],
      summary: '',
      stats: { totalFindings: 0, durationMs: Date.now() - start },
      errors: [`Cross-doc drift check failed: ${formatCaughtMessage(err)}`],
    } as AnalysisResult & CrossDocDriftResult;
  }
}
