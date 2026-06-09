import { describe, expect, it } from 'vitest';

import { runSystemsRuleEngine } from '../../src/core/systems-audit/systems-rule-engine.js';

describe('systems rule engine', () => {
  it('emits bounded findings with required rationale and suppression metadata', () => {
    const report = runSystemsRuleEngine({
      source:
        'int fd = open(path, O_RDONLY);\nfork();\nif (access(path, R_OK) == 0) open(path, O_RDONLY);\n',
      filePath: 'src/demo.c',
      facts: [
        {
          kind: 'open',
          operation: 'open',
          resourceInstanceId: 'fd:alpha',
          handle: 3,
          filePath: 'src/demo.c',
          line: 1,
        },
        {
          kind: 'signal-handler',
          category: 'signals',
          operation: 'unsafe-handler-call',
          filePath: 'src/demo.c',
          line: 10,
        },
        {
          kind: 'lock',
          category: 'concurrency',
          operation: 'blocking-under-lock',
          filePath: 'src/demo.c',
          line: 20,
        },
      ],
      maxFindings: 3,
    });

    expect(report.version).toBe(1);
    expect(report.tool).toBe('gn_audit_logic');
    expect(report.limits.truncated).toBe(true);
    expect(report.findings).toHaveLength(3);
    for (const finding of report.findings) {
      expect(finding.whyFired).toBeTruthy();
      expect(finding.whyMayBeFalsePositive).toBeTruthy();
      expect(finding.suppressionKey).toMatch(/^systems-audit:/);
      expect(finding.platformScope).toBeTruthy();
      expect(finding.severity).toBeTruthy();
      expect(finding.confidence).toBeGreaterThan(0);
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.lifecycleStatusEffect).toBe('none');
    }
  });

  it('supports every initial category without changing lifecycle status', () => {
    const report = runSystemsRuleEngine({
      source:
        'signal(SIGINT, handler);\nprintf("x");\npthread_mutex_lock(&m);\nstat(path, &st);\nopen(path, O_RDONLY);\nfork();\nsocket(AF_INET, SOCK_STREAM, 0);',
      facts: [
        { kind: 'open', operation: 'open', resourceInstanceId: 'fd:1' },
        { kind: 'fork' },
        { kind: 'signal-handler', category: 'signals', operation: 'unsafe-handler-call' },
        { kind: 'lock', category: 'concurrency', operation: 'blocking-under-lock' },
      ],
    });

    const categories = new Set(report.findings.map((finding) => finding.category));
    expect(categories).toEqual(
      new Set(['resource-leaks', 'fork-safety', 'signals', 'toctou', 'concurrency']),
    );
    expect(report.findings.every((finding) => finding.lifecycleStatusEffect === 'none')).toBe(true);
  });

  it('uses stable suppression keys for the same evidence', () => {
    const params = {
      facts: [
        {
          kind: 'open',
          operation: 'open',
          resourceInstanceId: 'fd:stable',
          filePath: 'src/stable.c',
          line: 7,
        },
      ],
      categories: ['resource-leaks' as const],
    };

    const first = runSystemsRuleEngine(params).findings[0].suppressionKey;
    const second = runSystemsRuleEngine(params).findings[0].suppressionKey;
    expect(first).toBe(second);
  });
});
