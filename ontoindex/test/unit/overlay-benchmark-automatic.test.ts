import { describe, expect, it } from 'vitest';
import {
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

  it('turns --pilot into one cold size-1 read', () => {
    const opts = parseAutomaticArgs(['--automatic', '--pilot', '--output', '/tmp/x.json']);
    expect(opts.sizes).toEqual([1]);
    expect(opts.repetitions).toBe(1);
    expect(opts.pilot).toBe(true);
  });

  it.each([
    [['--sizes', '0,52'], '--sizes'],
    [['--sizes', '1,1'], '--sizes'],
    [['--repetitions', '0'], '--repetitions'],
    [['--bogus', 'x'], 'Unknown argument'],
  ])('rejects invalid arguments %j', (extra, message) => {
    expect(() => parseAutomaticArgs(['--automatic', '--output', '/tmp/x.json', ...extra])).toThrow(
      message,
    );
  });
});
