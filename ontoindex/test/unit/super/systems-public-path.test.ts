import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn().mockResolvedValue({
    scope: 'global',
    repoLabel: 'fixture',
    status: 'ok',
  }),
}));

import { gnPathVerify, type PathVerifyParams } from '../../../src/mcp/super/systems-public.js';

const verify = (sourceText: string, params: Partial<PathVerifyParams> = {}) =>
  gnPathVerify('fixture', {
    sourceText,
    when: 'fork() < 0',
    must: ['close(fd)'],
    mustNot: ['return true'],
    ...params,
  });

describe('gn_path_verify procedure and branch scope', () => {
  it.each(['worker.c', 'worker.cpp'])('recognizes multiline consequences in %s', async (path) => {
    const report = await verify(
      `bool worker() {
      if (
        fork() < 0
      ) {
        close(
          fd
        );
        return false;
      }
      return true;
    }`,
      { path, symbol: 'worker' },
    );
    expect(report).toMatchObject({ status: 'NEEDS-VERIFY', missing: [], violations: [] });
    expect(report.evidence).toHaveLength(2);
    expect(report.warnings).toContainEqual(expect.stringContaining('no execution proof'));
  });

  it('selects an exact later procedure without borrowing from neighbors or else', async () => {
    const report = await verify(
      `bool neighbor() { if (fork() < 0) { close(fd); return true; } }
      bool worker() { if (fork() < 0) { report_error(); } else { close(fd); return true; } }
      bool later() { close(fd); return true; }`,
      { symbol: 'worker' },
    );
    expect(report).toMatchObject({
      status: 'NEEDS-VERIFY',
      missing: ['close(fd)'],
      violations: [],
    });
    expect(report.evidence).toEqual([{ line: 2, text: 'report_error ( ) ;' }]);
  });

  it.each([
    ['missing', 'bool worker() { if (fork() < 0) close(fd); }', 'other'],
    [
      'overloaded',
      'void worker() { if (fork() < 0) close(fd); } void worker(int fd) { if (fork() < 0) close(fd); }',
      'worker',
    ],
    [
      'unselected neighbors',
      'void a() { if (fork() < 0) close(fd); } void b() { if (fork() < 0) close(fd); }',
      undefined,
    ],
    [
      'repeated triggers',
      'void worker() { if (fork() < 0) close(fd); if (fork() < 0) close(fd); }',
      'worker',
    ],
    ['no trigger', 'void worker() { close(fd); }', 'worker'],
  ])('fails closed for %s', async (_label, source, symbol) => {
    const report = await verify(source, { symbol });
    expect(report).toMatchObject({ status: 'NEEDS-VERIFY', evidence: [], violations: [] });
    expect(report.missing).toEqual(['fork() < 0', 'close(fd)']);
    expect(report.skipReasons).not.toEqual([]);
  });

  it.each([
    ['namespace net { void worker() { if (fork() < 0) close(fd); } }', 'net::worker'],
    ['class Worker { void spawn() { if (fork() < 0) close(fd); } };', 'Worker::spawn'],
    [
      'namespace net { class Worker { void spawn() { if (fork() < 0) close(fd); } }; }',
      'net::Worker::spawn',
    ],
    ['void Worker::spawn() { if (fork() < 0) close(fd); }', 'Worker::spawn'],
  ])('matches qualified procedure %s', async (source, symbol) => {
    expect(await verify(source, { symbol })).toMatchObject({ missing: [], status: 'NEEDS-VERIFY' });
    expect(await verify(source, { symbol: symbol.split('::').at(-1) })).toMatchObject({
      evidence: [],
    });
  });

  it.each([
    'if (ready) close(fd);',
    'while (ready) { close(fd); }',
    'auto cleanup = [&]() { close(fd); return true; };',
    'ready ? close(fd) : ignore();',
    'ready && close(fd);',
    'return false; close(fd);',
    'throw failure; close(fd);',
    'goto finish; close(fd);',
  ])('does not observe nested or unreachable statements: %s', async (statement) => {
    const report = await verify(`void worker() { if (fork() < 0) { ${statement} } finish: ; }`);
    expect(report).toMatchObject({
      status: 'NEEDS-VERIFY',
      missing: ['close(fd)'],
      violations: [],
    });
  });

  it('ignores comments and literals in observations', async () => {
    const report = await verify(
      `void worker() { if (fork() < 0) {
      // close(fd); return true;
      /* close(fd); */
      log("close(fd); return true;");
      auto raw = R"(close(fd); return true;)";
      char letter = 'x';
    } }`,
      { mustNot: ['return true', 'close(fd)', 'x'] },
    );
    expect(report).toMatchObject({
      missing: ['close(fd)'],
      violations: [],
      status: 'NEEDS-VERIFY',
    });
  });

  it('ignores fake triggers in comments, strings and nested lambdas', async () => {
    const report = await verify(`void worker() {
      // if (fork() < 0) close(fd);
      log("if (fork() < 0) close(fd);");
      auto nested = []() { if (fork() < 0) close(fd); };
    }`);
    expect(report).toMatchObject({ evidence: [], missing: ['fork() < 0', 'close(fd)'] });
  });

  it('requires the complete condition rather than a substring', async () => {
    expect(await verify('void worker() { if (fork() < 0 && ready) close(fd); }')).toMatchObject({
      evidence: [],
      missing: ['fork() < 0', 'close(fd)'],
    });
  });

  it.each(['"x"', "'x'", 'R"(x)"'])(
    'preserves literal argument presence in conditions: %s',
    async (literal) => {
      const report = await verify(`void worker() { if (check(${literal})) close(fd); }`, {
        when: 'check()',
      });
      expect(report).toMatchObject({ evidence: [], missing: ['check()', 'close(fd)'] });
    },
  );

  it.each(['"fd"', "'f'", 'R"(fd)"'])(
    'preserves literal argument presence in observations: %s',
    async (literal) => {
      const report = await verify(`void worker() { if (fork() < 0) close(${literal}); }`, {
        must: ['close()'],
        mustNot: ['close()'],
      });
      expect(report).toMatchObject({
        status: 'NEEDS-VERIFY',
        missing: ['close()'],
        violations: [],
      });
    },
  );

  it('rejects caller patterns containing the opaque literal marker', async () => {
    const report = await verify('void worker() { if (fork() < 0) close("fd"); }', {
      must: ['close(\uFFFC)'],
      mustNot: ['close(\uFFFC)'],
    });
    expect(report).toMatchObject({ missing: ['close(\uFFFC)'], violations: [] });
    expect(
      await verify('void worker() { if (check("fd")) close(fd); }', { when: 'check(\uFFFC)' }),
    ).toMatchObject({ evidence: [], missing: ['check(\uFFFC)', 'close(fd)'] });
  });

  it('preserves inline fragment source lines and accepts if condition syntax', async () => {
    const report = await verify('if (fork() < 0) {\n close(fd);\n return false;\n}', {
      when: 'if ((fork() < 0))',
    });
    expect(report).toMatchObject({ missing: [], violations: [], status: 'NEEDS-VERIFY' });
    expect(report.evidence).toEqual([
      { line: 2, text: 'close ( fd ) ;' },
      { line: 3, text: 'return false ;' },
    ]);
  });

  it('reports observed forbidden patterns without claiming FAIL', async () => {
    expect(
      await verify('void worker() { if (fork() < 0) { close(fd); return true; } }'),
    ).toMatchObject({ status: 'NEEDS-VERIFY', missing: [], violations: ['return true'] });
  });

  it.each([
    ['malformed', 'void worker() { if (fork() < 0) { close(fd);', {}],
    ['unsupported path', 'void worker() { if (fork() < 0) close(fd); }', { path: 'worker.ts' }],
    ['byte limit', ' '.repeat(256 * 1024 + 1), {}],
    ['node limit', `void worker() { ${'noop();'.repeat(1000)} if (fork() < 0) close(fd); }`, {}],
  ])('returns no observations for %s', async (_label, source, params) => {
    const report = await verify(source, params);
    expect(report).toMatchObject({
      status: 'NEEDS-VERIFY',
      evidence: [],
      missing: ['fork() < 0', 'close(fd)'],
    });
    expect(report.skipReasons).not.toEqual([]);
  });

  it('computes missing independently of the evidence display cap and the old 80-line window', async () => {
    const report = await verify(
      `void worker() { if (fork() < 0) {
      noop(); ${'\n'.repeat(85)} close(fd); return false;
    } }`,
      { maxEvidence: 1 },
    );
    expect(report).toMatchObject({ missing: [], violations: [], status: 'NEEDS-VERIFY' });
    expect(report.evidence).toHaveLength(1);
  });

  it('preserves source alias, legacy fields and envelope advisory status', async () => {
    const params = {
      source: 'if (fork() < 0) { close(fd); }',
      when: 'fork() < 0',
      must: ['close(fd)'],
    };
    const legacy = await gnPathVerify('fixture', params);
    const envelope = await gnPathVerify('fixture', { ...params, legacyResponse: false });
    expect(legacy).toMatchObject({ missing: [], violations: [], status: 'NEEDS-VERIFY' });
    expect(envelope).toMatchObject({
      status: 'NEEDS-VERIFY',
      results: { missing: [], violations: [] },
    });
    expect(envelope.evidence).toEqual(legacy.evidence);
  });
});
