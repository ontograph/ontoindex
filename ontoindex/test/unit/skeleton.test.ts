import { describe, expect, it, vi } from 'vitest';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { getFileSkeleton } from '../../src/core/search/skeleton.js';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({ executeParameterized: vi.fn() }));

describe('getFileSkeleton source lines', () => {
  it.each([
    ['src/a.ts', 'Function', '1-4'],
    ['notes.md', 'Function', '0-3'],
    ['README', 'Section', '0-3'],
    ['program.cob', 'Function', '0-3'],
  ])('renders %s coordinates once', async (filePath, type, expected) => {
    const row = { name: 'example', type, startLine: 0, endLine: 3 };
    vi.mocked(executeParameterized).mockResolvedValue([row]);
    expect(await getFileSkeleton('repo', filePath)).toBe(
      `Symbols in ${filePath}:\n  - ${type.toLowerCase()} example (lines ${expected})`,
    );
    expect(row.startLine).toBe(0);
  });
});
