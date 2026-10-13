import { afterEach, expect, it, vi } from 'vitest';
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { findOversizedArgument } from '../../src/mcp/shared/arg-limits.js';

afterEach(() => vi.unstubAllEnvs());

it.each([
  [100, 32],
  [0, 1],
  [NaN, undefined],
  ['12', undefined],
  [Infinity, undefined],
])('normalizes declared maxDepth %s to %s', async (maxDepth, expected) => {
  const callTool = vi.fn().mockResolvedValue({});
  await dispatchFacade('impact', 'symbol', { maxDepth, extra: 999 }, {
    callTool,
  } as unknown as LocalBackend);
  const args = callTool.mock.calls[0][1];
  expect(args.maxDepth).toBe(expected);
  if (expected === undefined) expect(args).not.toHaveProperty('maxDepth');
  expect(args.extra).toBe(999);
});

it('rejects arrays above the default item cap and accepts its boundary', () => {
  expect(findOversizedArgument({ targets: Array(257).fill('x') })).toBe(
    'targets: array longer than 256 items',
  );
  expect(findOversizedArgument({ targets: Array(256).fill('x') })).toBeUndefined();
});

it('rejects aggregate JSON above one MiB', () => {
  expect(findOversizedArgument({ a: 'x'.repeat(600_000), b: 'x'.repeat(600_000) })).toBe(
    'arguments: JSON larger than 1048576 bytes',
  );
  expect(findOversizedArgument({ a: 'é'.repeat(600_000) })).toBe(
    'arguments: JSON larger than 1048576 bytes',
  );
});

it('honors bounded item cap overrides and ignores invalid ones', () => {
  vi.stubEnv('ONTOINDEX_MAX_ARG_ITEMS', '2');
  expect(findOversizedArgument({ targets: ['a', 'b'] })).toBeUndefined();
  expect(findOversizedArgument({ targets: ['a', 'b', 'c'] })).toBe(
    'targets: array longer than 2 items',
  );
  vi.stubEnv('ONTOINDEX_MAX_ARG_ITEMS', '0');
  expect(findOversizedArgument({ targets: Array(256).fill('x') })).toBeUndefined();
});
