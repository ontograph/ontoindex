import { describe, expect, it } from 'vitest';

import { analyzeErrorTopology } from '../../src/core/systems-audit/error-topology.js';

describe('error topology MVP', () => {
  it('scans syscall checks and logging/user-facing sinks with provenance', () => {
    const report = analyzeErrorTopology({
      filePath: 'worker.c',
      symbol: 'start',
      source: `
        int fd = open(path, O_RDONLY);
        if (fd < 0) {
          perror("open");
          return -1;
        }
        sendError("failed");
      `,
    });

    expect(report).toMatchObject({
      version: 1,
      tool: 'gn_error_topology',
      status: 'ok',
      primaryGraphFacts: [],
      target: { path: 'worker.c', symbol: 'start' },
    });
    expect(report.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'systems-error-topology-node',
          nodeKind: 'source',
          mechanism: 'errno',
          label: 'open',
          provenance: expect.objectContaining({
            recordKind: 'systems.error_topology',
            analyzerId: 'gn_error_topology',
            promotedToPrimaryGraph: false,
          }),
        }),
        expect.objectContaining({ nodeKind: 'check', mechanism: 'errno' }),
        expect.objectContaining({ nodeKind: 'sink', reasonCodes: ['logging-sink'] }),
      ]),
    );
    expect(report.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ relation: 'checked-by' })]),
    );
    expect(report.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'unchecked-error-source' })]),
    );
    expect(report.warnings[0]).toContain('bounded static heuristic');
  });

  it('flags swallowed catch blocks and generic exit codes', () => {
    const report = analyzeErrorTopology({
      filePath: 'cli.ts',
      source: `
        try {
          run();
        } catch (err) {
          metrics.count('ignored');
        }
        process.exit(1);
      `,
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'swallowed-error',
          severity: 'medium',
          reasonCodes: ['catch-block', 'no-observed-sink'],
          whyMayBeFalsePositive: expect.stringContaining('middleware'),
        }),
        expect.objectContaining({
          category: 'generic-exit-code',
          reasonCodes: ['generic-exit-code'],
        }),
      ]),
    );
    expect(report.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeKind: 'swallow' })]),
    );
  });

  it('flags unchecked error-return sources and enforces response limits', () => {
    const report = analyzeErrorTopology({
      maxRecords: 2,
      source: `
        int fd = open(path, O_RDONLY);
        int rc = write(fd, buf, len);
        return rc;
      `,
    });

    expect(report.status).toBe('partial');
    expect(report.limits).toMatchObject({ maxRecords: 2, emitted: 2, truncated: true });
    expect(report.findings).toHaveLength(0);
    expect(report.systemsEvidence).toHaveLength(2);

    const full = analyzeErrorTopology({
      source: `
        int fd = open(path, O_RDONLY);
        int rc = write(fd, buf, len);
        return rc;
      `,
    });
    expect(full.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'unchecked-error-source',
          confidence: 0.58,
          reasonCodes: ['unchecked-error-source'],
        }),
      ]),
    );
  });
});
