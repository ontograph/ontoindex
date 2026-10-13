import { afterEach, expect, it, vi } from 'vitest';
import {
  findOversizedArgument,
  resolveMaxArgItems,
  resolveMaxArgTotalBytes,
} from '../../src/mcp/shared/arg-limits.js';

afterEach(() => vi.unstubAllEnvs());

it('allows a 1.5 MiB string within the default per-string and aggregate caps', () => {
  expect(findOversizedArgument({ sourceText: 'x'.repeat(1.5 * 1024 * 1024) })).toBeUndefined();
});

it('rejects a string over the configured per-string cap', () => {
  expect(findOversizedArgument({ sourceText: 'x'.repeat(2_097_153) })).toBe(
    'sourceText: string longer than 2097152 characters',
  );
});

it('defaults to 1024 array items and rejects the next item', () => {
  expect(resolveMaxArgItems()).toBe(1024);
  expect(findOversizedArgument({ changedFiles: Array(1024).fill('file.ts') })).toBeUndefined();
  expect(findOversizedArgument({ changedFiles: Array(1025).fill('file.ts') })).toBe(
    'changedFiles: array longer than 1024 items (raise ONTOINDEX_MAX_ARG_ITEMS)',
  );
});

it('honors total-byte and item overrides', () => {
  vi.stubEnv('ONTOINDEX_MAX_ARG_TOTAL_BYTES', '1024');
  vi.stubEnv('ONTOINDEX_MAX_ARG_ITEMS', '2');
  expect(resolveMaxArgTotalBytes()).toBe(1024);
  expect(resolveMaxArgItems()).toBe(2);
  expect(findOversizedArgument({ text: 'x'.repeat(1024) })).toBe(
    'arguments: JSON larger than 1024 bytes (raise ONTOINDEX_MAX_ARG_TOTAL_BYTES)',
  );
  expect(findOversizedArgument({ files: ['a', 'b', 'c'] })).toBe(
    'files: array longer than 2 items (raise ONTOINDEX_MAX_ARG_ITEMS)',
  );
});

it('falls back to defaults for invalid environment values', () => {
  vi.stubEnv('ONTOINDEX_MAX_ARG_TOTAL_BYTES', '1023');
  vi.stubEnv('ONTOINDEX_MAX_ARG_ITEMS', '0');
  expect(resolveMaxArgTotalBytes()).toBe(Math.max(4 * 1024 * 1024, 2 * 2_097_152 + 1024 * 1024));
  expect(resolveMaxArgItems()).toBe(1024);
});
