import { describe, expect, it } from 'vitest';
import { RepoIdleTracker } from '../../src/mcp/local/repo-idle-tracker.js';

describe('RepoIdleTracker', () => {
  const make = (maxIdle = 8) => {
    let now = 0;
    const tracker = new RepoIdleTracker({ maxIdle, idleMs: 60_000, now: () => now });
    return { tracker, advance: (ms: number) => (now += ms) };
  };
  const use = (t: RepoIdleTracker, id: string) => {
    t.begin(id);
    t.end(id);
  };

  it('keeps a repo that was used recently', () => {
    const { tracker, advance } = make();
    use(tracker, 'a');
    advance(59_000);
    expect(tracker.candidates()).toEqual([]);
  });

  it('evicts a repo idle for 60 seconds', () => {
    const { tracker, advance } = make();
    use(tracker, 'a');
    advance(60_000);
    expect(tracker.candidates()).toEqual(['a']);
  });

  it('never evicts a repo with an open request, however long it runs', () => {
    const { tracker, advance } = make();
    tracker.begin('a');
    tracker.begin('a');
    advance(10 * 60_000);
    expect(tracker.candidates()).toEqual([]);
    tracker.end('a');
    expect(tracker.candidates()).toEqual([]);
    tracker.end('a');
    advance(60_000);
    expect(tracker.candidates()).toEqual(['a']);
  });

  it('evicts the oldest idle repos beyond eight, before they are 60 seconds old', () => {
    const { tracker, advance } = make();
    for (let i = 0; i < 10; i++) {
      use(tracker, `r${i}`);
      advance(1000);
    }
    expect(tracker.candidates().sort()).toEqual(['r0', 'r1']);
  });

  it('does not count busy repos toward the idle cap', () => {
    const { tracker, advance } = make();
    for (let i = 0; i < 9; i++) {
      tracker.begin(`r${i}`);
      advance(1000);
    }
    expect(tracker.candidates()).toEqual([]);
    tracker.end('r0');
    expect(tracker.candidates()).toEqual([]);
  });

  it('forgets an evicted repo until it is used again', () => {
    const { tracker, advance } = make();
    use(tracker, 'a');
    advance(60_000);
    tracker.forget('a');
    expect(tracker.candidates()).toEqual([]);
    use(tracker, 'a');
    advance(60_000);
    expect(tracker.candidates()).toEqual(['a']);
  });
});
