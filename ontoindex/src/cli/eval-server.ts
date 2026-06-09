/**
 * Eval Server — Lightweight HTTP server for SWE-bench evaluation
 *
 * Keeps LadybugDB warm in memory so tool calls from the agent are near-instant.
 * Designed to run inside Docker containers during SWE-bench evaluation.
 *
 * KEY DESIGN: Returns LLM-friendly text, not raw JSON.
 * Raw JSON wastes tokens and is hard for models to parse. The text formatter
 * converts structured results into compact, readable output that models
 * can immediately act on. Next-step hints guide the agent through a
 * productive tool-chaining workflow (query → context → impact → fix).
 *
 * Architecture:
 *   Agent bash cmd → curl localhost:PORT/tool/query → eval-server → LocalBackend → format → text
 *
 * Usage:
 *   ontoindex eval-server                    # default port 4848
 *   ontoindex eval-server --port 4848        # explicit port
 *   ontoindex eval-server --idle-timeout 300 # auto-shutdown after 300s idle
 *
 * API:
 *   POST /tool/:name   — Call a tool. Body is JSON arguments. Returns formatted text.
 *   GET  /health       — Health check. Returns {"status":"ok","repos":[...]}
 *   POST /shutdown     — Graceful shutdown.
 */

import http from 'http';
import { writeSync } from 'node:fs';
import { LocalBackend } from '../mcp/local/local-backend.js';

interface EvalServerOptions {
  port?: string;
  idleTimeout?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function asFormatterArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asFormatterRecord<T extends Record<string, unknown>>(value: unknown): T | undefined {
  return isRecord(value) ? (value as T) : undefined;
}

function formatError(value: unknown): string | undefined {
  const error = recordField(value, 'error');
  return error ? `Error: ${error}` : undefined;
}

function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (!isRecord(err)) return undefined;

  const message = err.message;
  return message ? String(message) : undefined;
}

// ─── Text Formatters ──────────────────────────────────────────────────
// Convert structured JSON results into compact, LLM-friendly text.
// Design: minimize tokens, maximize actionability.

interface QueryProcessFormat {
  id?: unknown;
  summary?: unknown;
  step_count?: unknown;
  symbol_count?: unknown;
}

interface QuerySymbolFormat {
  process_id?: unknown;
  type?: unknown;
  name?: unknown;
  filePath?: unknown;
  startLine?: unknown;
}

interface DefinitionFormat {
  type?: unknown;
  name?: unknown;
  filePath?: unknown;
}

export function formatQueryResult(result: unknown): string {
  const error = formatError(result);
  if (error) return error;

  const lines: string[] = [];
  const processes = asFormatterArray<QueryProcessFormat>(recordField(result, 'processes'));
  const symbols = asFormatterArray<QuerySymbolFormat>(recordField(result, 'process_symbols'));
  const defs = asFormatterArray<DefinitionFormat>(recordField(result, 'definitions'));

  if (processes.length === 0 && defs.length === 0) {
    return 'No matching execution flows found. Try a different search term or use grep.';
  }

  lines.push(`Found ${processes.length} execution flow(s):\n`);

  for (let i = 0; i < processes.length; i++) {
    const p = processes[i];
    lines.push(`${i + 1}. ${p.summary} (${p.step_count} steps, ${p.symbol_count} symbols)`);

    // Show symbols belonging to this process
    const procSymbols = symbols.filter((s) => s.process_id === p.id);
    for (const s of procSymbols.slice(0, 6)) {
      const loc = s.startLine ? `:${s.startLine}` : '';
      lines.push(`   ${s.type} ${s.name} → ${s.filePath}${loc}`);
    }
    if (procSymbols.length > 6) {
      lines.push(`   ... and ${procSymbols.length - 6} more`);
    }
    lines.push('');
  }

  if (defs.length > 0) {
    lines.push(`Standalone definitions:`);
    for (const d of defs.slice(0, 8)) {
      lines.push(`  ${d.type || 'Symbol'} ${d.name} → ${d.filePath || '?'}`);
    }
    if (defs.length > 8) lines.push(`  ... and ${defs.length - 8} more`);
  }

  return lines.join('\n').trim();
}

interface ContextCandidateFormat {
  name?: unknown;
  kind?: unknown;
  filePath?: unknown;
  line?: unknown;
  uid?: unknown;
}

interface ContextSymbolFormat extends Record<string, unknown> {
  kind?: unknown;
  name?: unknown;
  filePath?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  content?: string;
}

interface ContextProcessFormat {
  name?: unknown;
  step_index?: unknown;
  step_count?: unknown;
}

export function formatContextResult(result: unknown): string {
  const error = formatError(result);
  if (error) return error;

  const candidates = asFormatterArray<ContextCandidateFormat>(recordField(result, 'candidates'));
  if (recordField(result, 'status') === 'ambiguous') {
    const lines = [
      `Multiple symbols named '${candidates[0]?.name || '?'}'. Disambiguate with file path:\n`,
    ];
    for (const c of candidates) {
      lines.push(`  ${c.kind} ${c.name} → ${c.filePath}:${c.line || '?'}  (uid: ${c.uid})`);
    }
    lines.push(`\nRe-run: ontoindex-context "${candidates[0]?.name}" "<file_path>"`);
    return lines.join('\n');
  }

  const sym = asFormatterRecord<ContextSymbolFormat>(recordField(result, 'symbol'));
  if (!sym) return 'Symbol not found.';

  const lines: string[] = [];
  const loc = sym.startLine ? `:${sym.startLine}-${sym.endLine}` : '';
  lines.push(`${sym.kind} ${sym.name} → ${sym.filePath}${loc}`);
  lines.push('');

  // Incoming refs (who calls/imports/extends this)
  const incomingValue = recordField(result, 'incoming');
  const incoming = isRecord(incomingValue) ? incomingValue : {};
  const incomingCount = Object.values(incoming).reduce<number>(
    (sum, refs) => sum + asUnknownArray(refs).length,
    0,
  );
  if (incomingCount > 0) {
    lines.push(`Called/imported by (${incomingCount}):`);
    for (const [relType, refs] of Object.entries(incoming)) {
      for (const ref of asUnknownArray(refs).slice(0, 10)) {
        lines.push(
          `  ← [${relType}] ${recordField(ref, 'kind')} ${recordField(ref, 'name')} → ${recordField(ref, 'filePath')}`,
        );
      }
    }
    lines.push('');
  }

  // Outgoing refs (what this calls/imports)
  const outgoingValue = recordField(result, 'outgoing');
  const outgoing = isRecord(outgoingValue) ? outgoingValue : {};
  const outgoingCount = Object.values(outgoing).reduce<number>(
    (sum, refs) => sum + asUnknownArray(refs).length,
    0,
  );
  if (outgoingCount > 0) {
    lines.push(`Calls/imports (${outgoingCount}):`);
    for (const [relType, refs] of Object.entries(outgoing)) {
      for (const ref of asUnknownArray(refs).slice(0, 10)) {
        lines.push(
          `  → [${relType}] ${recordField(ref, 'kind')} ${recordField(ref, 'name')} → ${recordField(ref, 'filePath')}`,
        );
      }
    }
    lines.push('');
  }

  // Processes
  const procs = asFormatterArray<ContextProcessFormat>(recordField(result, 'processes'));
  if (procs.length > 0) {
    lines.push(`Participates in ${procs.length} execution flow(s):`);
    for (const p of procs) {
      lines.push(`  • ${p.name} (step ${p.step_index}/${p.step_count})`);
    }
  }

  if (sym.content) {
    lines.push('');
    lines.push(`Source:`);
    lines.push(sym.content);
  }

  return lines.join('\n').trim();
}

interface ImpactTargetFormat extends Record<string, unknown> {
  kind?: unknown;
  name?: unknown;
}

interface ImpactItemFormat {
  type?: unknown;
  name?: unknown;
  filePath?: unknown;
  relationType?: unknown;
  confidence?: number;
}

export function formatImpactResult(result: unknown): string {
  const error = recordField(result, 'error');
  if (error) {
    const suggestion = recordField(result, 'suggestion')
      ? `\nSuggestion: ${recordField(result, 'suggestion')}`
      : '';
    return `Error: ${error}${suggestion}`;
  }

  const target = asFormatterRecord<ImpactTargetFormat>(recordField(result, 'target'));
  const direction = recordField(result, 'direction');
  const byDepth = (recordField(result, 'byDepth') || {}) as Record<number, ImpactItemFormat[]>;
  const total = (recordField(result, 'impactedCount') as number | undefined) || 0;

  if (total === 0) {
    return `${target?.name || '?'}: No ${direction} dependencies found. This symbol appears isolated.`;
  }

  const lines: string[] = [];
  const dirLabel =
    direction === 'upstream' ? 'depends on this (will break if changed)' : 'this depends on';
  lines.push(
    `Blast radius for ${target?.kind || ''} ${target?.name} (${direction}): ${total} symbol(s) ${dirLabel}`,
  );
  if (recordField(result, 'partial')) {
    lines.push('⚠️  Partial results — graph traversal was interrupted. Deeper impacts may exist.');
  }
  lines.push('');

  const depthLabels: Record<number, string> = {
    1: 'WILL BREAK (direct)',
    2: 'LIKELY AFFECTED (indirect)',
    3: 'MAY NEED TESTING (transitive)',
  };

  for (const depth of [1, 2, 3]) {
    const items = asFormatterArray<ImpactItemFormat>(byDepth[depth]);
    if (!items || items.length === 0) continue;

    lines.push(`d=${depth}: ${depthLabels[depth] || ''} (${items.length})`);
    for (const item of items.slice(0, 12)) {
      const conf = item.confidence < 1 ? ` (conf: ${item.confidence})` : '';
      lines.push(`  ${item.type} ${item.name} → ${item.filePath} [${item.relationType}]${conf}`);
    }
    if (items.length > 12) {
      lines.push(`  ... and ${items.length - 12} more`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function formatCypherResult(result: unknown): string {
  const error = formatError(result);
  if (error) return error;

  if (Array.isArray(result)) {
    if (result.length === 0) return 'Query returned 0 rows.';
    // Format as simple table
    const keys = Object.keys(Object(result[0]));
    const lines: string[] = [`${result.length} row(s):\n`];
    for (const row of result.slice(0, 30)) {
      const rowRecord = row as Record<string, unknown>;
      const parts = keys.map((k) => `${k}: ${rowRecord[k]}`);
      lines.push(`  ${parts.join(' | ')}`);
    }
    if (result.length > 30) {
      lines.push(`  ... ${result.length - 30} more rows`);
    }
    return lines.join('\n');
  }

  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

interface DetectChangesSummaryFormat {
  changed_files?: unknown;
  changed_count?: unknown;
  affected_count?: unknown;
  risk_level?: unknown;
}

interface ChangedSymbolFormat {
  type?: unknown;
  name?: unknown;
  filePath?: unknown;
}

interface ChangedStepFormat {
  symbol?: unknown;
}

interface AffectedProcessFormat {
  name?: unknown;
  step_count?: unknown;
  changed_steps?: ChangedStepFormat[];
}

export function formatDetectChangesResult(result: unknown): string {
  const error = formatError(result);
  if (error) return error;

  const summary = (recordField(result, 'summary') || {}) as DetectChangesSummaryFormat;
  const lines: string[] = [];

  if (summary.changed_count === 0) {
    return 'No changes detected.';
  }

  lines.push(`Changes: ${summary.changed_files || 0} files, ${summary.changed_count || 0} symbols`);
  lines.push(`Affected processes: ${summary.affected_count || 0}`);
  lines.push(`Risk level: ${summary.risk_level || 'unknown'}\n`);

  const changed = asFormatterArray<ChangedSymbolFormat>(recordField(result, 'changed_symbols'));
  if (changed.length > 0) {
    lines.push(`Changed symbols:`);
    for (const s of changed.slice(0, 15)) {
      lines.push(`  ${s.type} ${s.name} → ${s.filePath}`);
    }
    if (changed.length > 15) lines.push(`  ... and ${changed.length - 15} more`);
    lines.push('');
  }

  const affected = asFormatterArray<AffectedProcessFormat>(
    recordField(result, 'affected_processes'),
  );
  if (affected.length > 0) {
    lines.push(`Affected execution flows:`);
    for (const p of affected.slice(0, 10)) {
      const steps = asFormatterArray<ChangedStepFormat>(p.changed_steps)
        .map((s) => s.symbol)
        .join(', ');
      lines.push(`  • ${p.name} (${p.step_count} steps) — changed: ${steps}`);
    }
  }

  return lines.join('\n').trim();
}

interface ListRepoStatsFormat {
  nodes?: unknown;
  edges?: unknown;
  processes?: unknown;
}

interface ListRepoFormat {
  name?: unknown;
  path?: unknown;
  indexedAt?: unknown;
  stats?: ListRepoStatsFormat;
}

export function formatListReposResult(result: unknown): string {
  if (!Array.isArray(result) || result.length === 0) {
    return 'No indexed repositories.';
  }

  const lines = ['Indexed repositories:\n'];
  for (const r of result as ListRepoFormat[]) {
    const stats = r.stats || {};
    lines.push(
      `  ${r.name} — ${stats.nodes || '?'} symbols, ${stats.edges || '?'} relationships, ${stats.processes || '?'} flows`,
    );
    lines.push(`    Path: ${r.path}`);
    lines.push(`    Indexed: ${r.indexedAt}`);
  }
  return lines.join('\n');
}

/**
 * Format a tool result as compact, LLM-friendly text.
 */
function formatToolResult(toolName: string, result: unknown): string {
  switch (toolName) {
    case 'query':
      return formatQueryResult(result);
    case 'context':
      return formatContextResult(result);
    case 'impact':
      return formatImpactResult(result);
    case 'cypher':
      return formatCypherResult(result);
    case 'detect_changes':
      return formatDetectChangesResult(result);
    case 'list_repos':
      return formatListReposResult(result);
    default:
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }
}

// ─── Next-Step Hints ──────────────────────────────────────────────────
// Guide the agent to the logical next tool call.
// Critical for tool chaining: query → context → impact → fix.

function getNextStepHint(toolName: string): string {
  switch (toolName) {
    case 'query':
      return '\n---\nNext: Pick a symbol above and run ontoindex-context "<name>" to see all its callers, callees, and execution flows.';

    case 'context':
      return '\n---\nNext: To check what breaks if you change this, run ontoindex-impact "<name>" upstream';

    case 'impact':
      return '\n---\nNext: Review d=1 items first (WILL BREAK). Read the source with cat to understand the code, then make your fix.';

    case 'cypher':
      return '\n---\nNext: To explore a result symbol in depth, run ontoindex-context "<name>"';

    case 'detect_changes':
      return '\n---\nNext: Run ontoindex-context "<symbol>" on high-risk changed symbols to check their callers.';

    default:
      return '';
  }
}

// ─── Server ───────────────────────────────────────────────────────────

export async function evalServerCommand(options?: EvalServerOptions): Promise<void> {
  const port = parseInt(options?.port || '4848');
  const idleTimeoutSec = parseInt(options?.idleTimeout || '0');

  const backend = new LocalBackend();
  const ok = await backend.init();

  if (!ok) {
    console.error('OntoIndex eval-server: No indexed repositories found. Run: ontoindex analyze');
    process.exit(1);
  }

  const repos = await backend.listRepos();
  console.error(
    `OntoIndex eval-server: ${repos.length} repo(s) loaded: ${repos.map((r) => r.name).join(', ')}`,
  );

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer() {
    if (idleTimeoutSec <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      console.error('OntoIndex eval-server: Idle timeout reached, shutting down');
      await backend.dispose();
      process.exit(0);
    }, idleTimeoutSec * 1000);
  }

  const server = http.createServer(async (req, res) => {
    resetIdleTimer();

    try {
      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', repos: repos.map((r) => r.name) }));
        return;
      }

      // Shutdown
      if (req.method === 'POST' && req.url === '/shutdown') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'shutting_down' }));
        setTimeout(async () => {
          await backend.dispose();
          server.close();
          process.exit(0);
        }, 100);
        return;
      }

      // Tool calls: POST /tool/:name
      const toolMatch = req.url?.match(/^\/tool\/(\w+)$/);
      if (req.method === 'POST' && toolMatch) {
        const toolName = toolMatch[1];

        const body = await readBody(req);
        let args: unknown = {};
        if (body.trim()) {
          try {
            args = JSON.parse(body);
          } catch {
            res.setHeader('Content-Type', 'text/plain');
            res.writeHead(400);
            res.end('Error: Invalid JSON body');
            return;
          }
        }

        // Call tool, format result as text, append next-step hint
        const result = await backend.callTool(toolName, args);
        const formatted = formatToolResult(toolName, result);
        const hint = getNextStepHint(toolName);

        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(200);
        res.end(formatted + hint);
        return;
      }

      // 404
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(404);
      res.end('Not found. Use POST /tool/:name or GET /health');
    } catch (err: unknown) {
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(500);
      res.end(`Error: ${errorMessage(err) || 'Internal error'}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.error(`OntoIndex eval-server: listening on http://127.0.0.1:${port}`);
    console.error(`  POST /tool/query    — search execution flows`);
    console.error(`  POST /tool/context  — 360-degree symbol view`);
    console.error(`  POST /tool/impact   — blast radius analysis`);
    console.error(`  POST /tool/cypher   — raw Cypher query`);
    console.error(`  GET  /health        — health check`);
    console.error(`  POST /shutdown      — graceful shutdown`);
    if (idleTimeoutSec > 0) {
      console.error(`  Auto-shutdown after ${idleTimeoutSec}s idle`);
    }
    try {
      // Use fd 1 directly — LadybugDB captures process.stdout (#324)
      writeSync(1, `ONTOINDEX_EVAL_SERVER_READY:${port}\n`);
    } catch {
      // stdout may not be available (e.g., broken pipe)
    }
  });

  resetIdleTimer();

  const shutdown = async () => {
    console.error('OntoIndex eval-server: shutting down...');
    await backend.dispose();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy(new Error('Request body too large (max 1MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
