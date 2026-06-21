import { describe, expect, it } from 'vitest';
import { projectReadFirstFiles } from '../../src/mcp/shared/read-first-projection.js';

describe('projectReadFirstFiles', () => {
  it('orders files by read-first priority, dedupes paths, and counts omissions', () => {
    const report = projectReadFirstFiles(
      [
        { filePath: 'src/main.ts', reason: 'entrypoint', source: 'definition' },
        { filePath: 'src/worker.ts', reason: 'direct caller', source: 'caller' },
        { filePath: 'src/main.ts', reason: 'duplicate mention', source: 'docs' },
        { filePath: 'docs/notes.md', reason: 'supporting context', source: 'docs' },
        { filePath: ' ', reason: 'invalid path', source: 'docs' },
      ],
      { maxFiles: 2 },
    );

    expect(report.readFirstFiles).toEqual([
      { filePath: 'src/main.ts', reason: 'entrypoint', source: 'definition' },
      { filePath: 'src/worker.ts', reason: 'direct caller', source: 'caller' },
    ]);
    expect(report.omittedCounts).toEqual({
      invalid: 1,
      duplicate: 1,
      truncated: 1,
      total: 3,
    });
  });

  it('returns an empty-safe projection for empty input', () => {
    expect(projectReadFirstFiles()).toEqual({
      readFirstFiles: [],
      omittedCounts: {
        invalid: 0,
        duplicate: 0,
        truncated: 0,
        total: 0,
      },
    });
  });
});
