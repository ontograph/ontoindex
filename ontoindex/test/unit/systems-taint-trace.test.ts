import { describe, expect, it } from 'vitest';

import { traceTaint } from '../../src/core/systems-audit/taint-trace.js';

describe('systems taint trace analyzer', () => {
  it('traces source names to sink through simple assignments and calls', () => {
    const report = traceTaint({
      filePath: 'handler.ts',
      sourceName: 'req.body',
      sinkName: 'query',
      source: `
        const raw = req.body;
        const copied = raw;
        const sql = buildSql(copied);
        query(sql);
      `,
    });

    expect(report.status).toBe('ok');
    expect(report.sidecarRecord).toMatchObject({
      kind: 'systems.taint_trace',
      analyzerId: 'gn_taint_trace',
      provenance: { filePath: 'handler.ts', mode: 'bounded-static-heuristic' },
    });
    expect(report.paths).toHaveLength(1);
    expect(report.paths[0]).toMatchObject({
      status: 'tainted',
      reasonCodes: expect.arrayContaining([
        'SOURCE_MATCHED',
        'CALL_PROPAGATION',
        'NO_SANITIZER_PATH',
      ]),
      falsePositiveNotes: expect.arrayContaining([
        'call propagation assumes return value may derive from tainted arguments',
      ]),
    });
    expect(report.systemsEvidence.map((step) => step.kind)).toContain('sink');
  });

  it('detects sanitizer names and avoids no-sanitizer classification', () => {
    const report = traceTaint({
      sourceName: 'input',
      sinkName: 'exec',
      sanitizers: ['escapeShell'],
      source: `
        const raw = input();
        const safe = escapeShell(raw);
        exec(safe);
      `,
    });

    expect(report.paths[0]).toMatchObject({
      status: 'sanitized',
      sanitizer: 'escapeShell',
      reasonCodes: expect.arrayContaining(['SANITIZER_APPLIED']),
    });
    expect(report.paths[0].reasonCodes).not.toContain('NO_SANITIZER_PATH');
  });

  it('applies response limits and reports truncation', () => {
    const report = traceTaint({
      sourceName: 'request',
      sinkName: 'send',
      maxPaths: 1,
      source: `
        const a = request();
        send(a);
        send(a);
      `,
    });

    expect(report.limits).toMatchObject({ truncated: true, maxPaths: 1, emitted: 1, total: 2 });
    expect(report.status).toBe('partial');
    expect(report.warnings[0]).toContain('truncated');
  });
});
