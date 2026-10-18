import { describe, expect, it } from 'vitest';
import {
  contextFingerprint,
  diffFingerprints,
  parseAutomaticArgs,
  selfCheck,
  // @ts-expect-error plain .mjs script without declarations
} from '../../scripts/overlay-benchmark-automatic.mjs';

describe('automatic overlay benchmark', () => {
  it('rejects every missing or failed measurement kind in its self-check', () => {
    const result = selfCheck();
    expect(result.pass).toBe(true);
    expect(Object.keys(result.rejected).sort()).toEqual([
      'missingMetric',
      'nativeError',
      'nonZeroExit',
      'truncatedStderr',
      'unreapedChild',
    ]);
  });

  it('defaults to the ADR matrix and requires an output path', () => {
    expect(() => parseAutomaticArgs(['--automatic'])).toThrow('--output is required');
    const opts = parseAutomaticArgs(['--automatic', '--output', '/tmp/x.json']);
    expect(opts.sizes).toEqual([0, 1, 50, 51]);
    expect(opts.repetitions).toBe(20);
    expect(opts.pilot).toBe(false);
  });

  describe('same-input parity comparison', () => {
    const answer = (incoming: string[], status = 'found') =>
      JSON.stringify({
        status,
        symbol: { uid: 'Function:a.ts:f' },
        incoming: { calls: incoming.map((uid) => ({ uid })) },
        outgoing: { calls: [] },
      }) + '\n\n---\n**Next:** hint';

    it('ignores the hint and caller order', () => {
      const a = contextFingerprint(answer(['b', 'a']));
      const b = contextFingerprint(answer(['a', 'b']));
      expect(diffFingerprints(a, b)).toEqual([]);
      expect(a.incoming).toEqual(['a', 'b']);
    });

    it('reports a missing caller, an extra caller and a status change', () => {
      const reference = contextFingerprint(answer(['a', 'probe']));
      expect(diffFingerprints(contextFingerprint(answer(['a'])), reference)).toEqual([
        'incoming missing probe',
      ]);
      expect(diffFingerprints(contextFingerprint(answer(['a', 'probe', 'z'])), reference)).toEqual([
        'incoming extra z',
      ]);
      expect(
        diffFingerprints(contextFingerprint(answer(['a', 'probe'], 'ambiguous')), reference),
      ).toEqual(['status ambiguous != found']);
    });
  });

  it('includes the parity workload by default and rejects unknown extras', () => {
    const base = ['--automatic', '--output', '/tmp/x.json'];
    expect(parseAutomaticArgs(base).extras).toContain('parity');
    expect(() => parseAutomaticArgs([...base, '--extras', 'nope'])).toThrow('--extras');
  });

  it('turns --pilot into one cold size-1 read', () => {
    const opts = parseAutomaticArgs(['--automatic', '--pilot', '--output', '/tmp/x.json']);
    expect(opts.sizes).toEqual([1]);
    expect(opts.repetitions).toBe(1);
    expect(opts.pilot).toBe(true);
  });

  it('includes the config and contention workloads by default and lets each be dropped', () => {
    const base = ['--automatic', '--output', '/tmp/x.json'];
    expect(parseAutomaticArgs(base).extras).toEqual(['config', 'contention', 'parity']);
    expect(parseAutomaticArgs([...base, '--extras', 'none']).extras).toEqual([]);
    expect(parseAutomaticArgs([...base, '--extras', 'contention']).extras).toEqual(['contention']);
    expect(parseAutomaticArgs([...base, '--sizes', 'none']).sizes).toEqual([]);
    expect(
      parseAutomaticArgs(['--automatic', '--pilot', '--output', '/tmp/x.json']).extras,
    ).toEqual([]);
  });

  it.each([
    [['--sizes', '0,52'], '--sizes'],
    [['--sizes', '1,1'], '--sizes'],
    [['--extras', 'config,config'], '--extras'],
    [['--extras', 'throughput'], '--extras'],
    [['--repetitions', '0'], '--repetitions'],
    [['--bogus', 'x'], 'Unknown argument'],
  ])('rejects invalid arguments %j', (extra, message) => {
    expect(() => parseAutomaticArgs(['--automatic', '--output', '/tmp/x.json', ...extra])).toThrow(
      message,
    );
  });
});
