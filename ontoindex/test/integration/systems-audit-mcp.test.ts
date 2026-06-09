import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { dispatchSuper, SUPER_NAMES } from '../../src/mcp/super/dispatch.js';
import { gnAuditLogic } from '../../src/mcp/super/audit-logic.js';
import { gnTraceBoundary } from '../../src/mcp/super/trace-boundary.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';

describe('systems audit MCP MVP modules', () => {
  it('registers all systems-audit frontier tools in definitions and dispatch', () => {
    const definitionNames = new Set(ONTOINDEX_SUPER_TOOLS.map((tool) => tool.name));
    for (const name of [
      'gn_audit_logic',
      'gn_trace_boundary',
      'gn_resource_trace',
      'gn_path_verify',
      'gn_test_suggestions',
      'gn_extract_fsm',
      'gn_error_topology',
      'gn_concurrency_audit',
      'gn_pressure_impact',
      'gn_taint_trace',
      'gn_abi_diff',
      'gn_simulate_fault',
    ]) {
      expect(definitionNames.has(name)).toBe(true);
      expect(SUPER_NAMES.has(name as never)).toBe(true);
    }
  });

  it('gnAuditLogic returns the systems-audit MCP envelope without lifecycle status changes', async () => {
    const report = await gnAuditLogic('fixture', {
      source: 'int fd = open(path, O_RDONLY);\n',
      category: 'resource-leaks',
    });

    expect(report).toMatchObject({
      version: 1,
      tool: 'gn_audit_logic',
      status: 'ok',
      primaryGraphFacts: [],
      freshness: { status: 'not-applicable' },
    });
    expect(report.systemsEvidence.length).toBeGreaterThan(0);
    expect(report.findings[0]).toMatchObject({
      category: 'resource-leaks',
      lifecycleStatusEffect: 'none',
    });
    expect(report.nextTools).toContain('gn_trace_boundary');
  });

  it('gnAuditLogic resolves relative paths against the repo root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ontoindex-systems-audit-'));
    await writeFile(join(repo, 'sample.cpp'), 'int fd = open(path, O_RDONLY);\n', 'utf8');

    const report = await gnAuditLogic(repo, {
      path: 'sample.cpp',
      category: 'resource-leaks',
    });

    expect(report.skipReasons).not.toContain('no source or systems facts supplied');
    expect(report.warnings).toEqual([]);
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('gnTraceBoundary returns unresolved gaps instead of guessing missing receive side', async () => {
    const report = await gnTraceBoundary('fixture', {
      resource: 'fd:handoff',
      kind: 'SCM_RIGHTS',
      facts: [
        {
          kind: 'send',
          mechanism: 'SCM_RIGHTS',
          resourceInstanceId: 'fd:handoff',
          senderProcessId: 'p1',
          senderHandle: 8,
        },
      ],
    });

    expect(report).toMatchObject({
      version: 1,
      tool: 'gn_trace_boundary',
      status: 'unresolved',
      primaryGraphFacts: [],
      findings: [],
      freshness: { status: 'not-applicable' },
    });
    expect(report.segments[0].unresolvedGaps.join(' ')).toContain('missing receive side');
    expect(report.nextTools).toContain('gn_audit_logic');
  });

  it('dispatches S6 systems analyzers through MCP frontier wrappers', async () => {
    const fsm = (await dispatchSuper(
      'gn_extract_fsm',
      {
        sourceText:
          'enum State { ACTIVE, CRASHED };\\nif (state == ACTIVE) { state = CRASHED; }\\n',
        stateVariable: 'state',
      },
      'fixture',
    )) as Record<string, any>;
    expect(fsm.tool).toBe('gn_extract_fsm');
    expect(fsm.transitions[0]).toMatchObject({ toState: 'CRASHED' });

    const taint = (await dispatchSuper(
      'gn_taint_trace',
      {
        sourceText: `
          const name = req.body;
          duckdb_query(name);
        `,
        source: 'req.body',
        sink: 'duckdb_query',
      },
      'fixture',
    )) as Record<string, any>;
    expect(taint.tool).toBe('gn_taint_trace');
    expect(taint.findings[0].reasonCodes).toContain('NO_SANITIZER_PATH');

    const fault = (await dispatchSuper(
      'gn_simulate_fault',
      {
        sourceText: `
          int fd = pidfd_open(pid, 0);
          if (fd == -1) { return; }
          state = ready;
        `,
        target: 'pidfd_open',
        returnValue: '-1',
      },
      'fixture',
    )) as Record<string, any>;
    expect(fault.analyzerId).toBe('gn_simulate_fault');
    expect(fault.earlyReturns.length).toBeGreaterThan(0);

    const resources = (await dispatchSuper(
      'gn_resource_trace',
      {
        sourceText: `
          int pipes[2];
          pipe(pipes);
          close(pipes[0]);
        `,
      },
      'fixture',
    )) as Record<string, any>;
    expect(resources.analyzerId).toBe('cpp-posix-resource-extractor');
    expect(resources.records.length).toBeGreaterThan(0);

    const pathVerify = (await dispatchSuper(
      'gn_path_verify',
      {
        sourceText: 'if (fork() < 0) { close(stdinPipe[0]); return false; }',
        when: 'fork() < 0',
        must: ['close(stdinPipe[0])'],
        mustNot: ['return true'],
      },
      'fixture',
    )) as Record<string, any>;
    expect(pathVerify.status).toBe('PASS');

    const testSuggestion = (await dispatchSuper(
      'gn_test_suggestions',
      { symbol: 'SidecarManager::_spawn', risk: 'fd-leak-across-fork' },
      'fixture',
    )) as Record<string, any>;
    expect(testSuggestion.suggestions[0].case).toContain('fd_leak_across_fork');
  });

  it('gn_resource_trace accepts an absolute path under the repo root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ontoindex-resource-trace-'));
    const filePath = join(repo, 'sample.cpp');
    await writeFile(filePath, 'int fds[2];\npipe(fds);\nclose(fds[0]);\n', 'utf8');

    const report = (await dispatchSuper('gn_resource_trace', { path: filePath }, repo)) as Record<
      string,
      any
    >;

    expect(report.filePath).toBe('sample.cpp');
    expect(report.records.length).toBeGreaterThan(0);
  });

  it('gn_resource_trace accepts a repo-relative path under the repo root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ontoindex-resource-trace-'));
    await writeFile(
      join(repo, 'sample.cpp'),
      'int fd = open(path, O_RDONLY);\nclose(fd);\n',
      'utf8',
    );

    const report = (await dispatchSuper(
      'gn_resource_trace',
      { path: 'sample.cpp' },
      repo,
    )) as Record<string, any>;

    expect(report.filePath).toBe('sample.cpp');
    expect(report.records.length).toBeGreaterThan(0);
  });

  it('gn_resource_trace rejects paths outside the repo root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ontoindex-resource-trace-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(join(root, 'outside.cpp'), 'int fd = open(path, O_RDONLY);\n', 'utf8');

    await expect(
      dispatchSuper('gn_resource_trace', { path: '../outside.cpp' }, repo),
    ).rejects.toThrow(/Path is outside repository: \.\.\/outside\.cpp\. Use a path under /);
  });

  it('gn_resource_trace rejects unresolved repo names instead of joining them to paths', async () => {
    await expect(
      dispatchSuper('gn_resource_trace', { path: 'c2FtcGxl.cpp' }, 'unregistered-repo-c2FtcGxl'),
    ).rejects.toThrow(/Repository not found for path resolution: unregistered-repo-c2FtcGxl/);
  });
});
