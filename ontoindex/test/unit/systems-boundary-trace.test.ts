import { describe, expect, it } from 'vitest';

import { traceBoundary } from '../../src/core/systems-audit/boundary-trace.js';

describe('systems boundary trace', () => {
  it('traces SCM_RIGHTS through a shared resource instance', () => {
    const report = traceBoundary({
      resource: 'socket:alpha',
      kind: 'SCM_RIGHTS',
      facts: [
        {
          kind: 'send',
          mechanism: 'SCM_RIGHTS',
          resourceInstanceId: 'socket:alpha',
          senderProcessId: 'parent',
          senderHandle: 5,
        },
        {
          kind: 'receive',
          mechanism: 'SCM_RIGHTS',
          resourceInstanceId: 'socket:alpha',
          receiverProcessId: 'child',
          receiverHandle: 9,
        },
      ],
    });

    expect(report.status).toBe('ok');
    expect(report.segments).toHaveLength(1);
    expect(report.segments[0]).toMatchObject({
      mechanism: 'SCM_RIGHTS',
      resourceInstanceId: 'socket:alpha',
      senderHandle: 5,
      receiverHandle: 9,
      confidence: 0.9,
      unresolvedGaps: [],
    });
  });

  it('does not treat equal fd numbers as identity proof when receive side is missing', () => {
    const report = traceBoundary({
      resource: 'socket:beta',
      kind: 'SCM_RIGHTS',
      facts: [
        {
          kind: 'send',
          mechanism: 'SCM_RIGHTS',
          resourceInstanceId: 'socket:beta',
          senderProcessId: 'parent',
          senderHandle: 4,
        },
        {
          kind: 'receive',
          mechanism: 'SCM_RIGHTS',
          receiverProcessId: 'child',
          receiverHandle: 4,
        },
      ],
    });

    expect(report.status).toBe('unresolved');
    expect(report.segments[0].receiverHandle).toBeUndefined();
    expect(report.segments[0].unresolvedGaps.join(' ')).toContain('FD number equality');
  });

  it('returns fork inheritance and exec close-on-exec filtering segments', () => {
    const report = traceBoundary({
      facts: [
        { kind: 'open', resourceInstanceId: 'fd:one', processId: 'p1', handle: 3 },
        {
          kind: 'open',
          resourceInstanceId: 'fd:two',
          processId: 'p1',
          handle: 4,
          closeOnExec: true,
        },
        { kind: 'fork', processId: 'p1', childProcessId: 'p2' },
        { kind: 'exec', processId: 'p1' },
      ],
    });

    const fork = report.segments.find(
      (segment) => segment.mechanism === 'fork' && segment.resourceInstanceId === 'fd:one',
    );
    const filtered = report.segments.find(
      (segment) =>
        segment.mechanism === 'exec-close-on-exec' && segment.resourceInstanceId === 'fd:two',
    );

    expect(fork).toMatchObject({ senderHandle: 3, receiverHandle: 3, receiverProcessId: 'p2' });
    expect(filtered?.receiverHandle).toBeUndefined();
    expect(filtered?.unresolvedGaps.join(' ')).toContain('close-on-exec');
  });

  it('traces pidfd_getfd without relying on target fd equality', () => {
    const report = traceBoundary({
      kind: 'pidfd_getfd',
      facts: [
        {
          kind: 'pidfd_getfd',
          resourceInstanceId: 'fd:remote',
          sourceHandle: 11,
          targetHandle: 11,
          processId: 'source',
          targetProcessId: 'target',
        },
      ],
    });

    expect(report.status).toBe('ok');
    expect(report.segments[0]).toMatchObject({
      mechanism: 'pidfd_getfd',
      resourceInstanceId: 'fd:remote',
      senderHandle: 11,
      receiverHandle: 11,
    });
  });
});
