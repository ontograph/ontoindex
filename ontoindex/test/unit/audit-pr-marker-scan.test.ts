import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  scanPrMarkersInSource,
  scanPrMarkersNearPath,
} from '../../src/core/audit-lifecycle/index.js';

describe('audit PR marker scan', () => {
  it('detects all supported marker classes in nearby comments', () => {
    const sourceText = [
      'function run() {',
      '  // PR-123: intentionally gated pending API decision',
      '  // TODO: replace compatibility path',
      '  // FIXME: remove fallback after migration',
      '  // follow-up: add stress coverage',
      '  // known limitation: parser cannot prove this branch',
      '  // deferred until tool contract is stable',
      '  return legacyFallback();',
      '}',
    ].join('\n');

    const result = scanPrMarkersInSource({
      file: 'src/example.ts',
      sourceText,
      evidenceLine: 8,
      windowBefore: 6,
      windowAfter: 0,
    });

    expect(result.markers.map((marker) => marker.markerKind)).toEqual([
      'PR_REFERENCE',
      'TODO',
      'FIXME',
      'FOLLOW_UP',
      'KNOWN_LIMITATION',
      'DEFERRED',
    ]);
    expect(result.markers[0]).toMatchObject({
      file: 'src/example.ts',
      line: 2,
      matchedText: 'PR-123',
      suggestedTag: 'DECISION-GATED',
      evidenceWindow: {
        file: 'src/example.ts',
        evidenceLine: 8,
        startLine: 2,
        endLine: 8,
        before: 6,
        after: 0,
      },
    });
    expect(
      result.markers.slice(1).every((marker) => marker.suggestedTag === 'KNOWN-DEFERRED'),
    ).toBe(true);
  });

  it('only scans comments inside the requested evidence window', () => {
    const sourceText = [
      '// TODO: outside before',
      'const before = 1;',
      'const target = 2;',
      '// FIXME: inside after',
      '// PR-77: outside after',
    ].join('\n');

    const result = scanPrMarkersInSource({
      file: 'src/window.ts',
      sourceText,
      evidenceLine: 3,
      windowBefore: 0,
      windowAfter: 1,
    });

    expect(result.evidenceWindow).toMatchObject({
      startLine: 3,
      endLine: 4,
      lineCount: 5,
    });
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0]).toMatchObject({
      line: 4,
      markerKind: 'FIXME',
      text: 'FIXME: inside after',
    });
  });

  it('returns an empty marker set when nearby comments have no PR markers', () => {
    const result = scanPrMarkersInSource({
      file: 'src/clean.ts',
      sourceText: ['// regular explanatory comment', 'doWork();'].join('\n'),
      evidenceLine: 2,
    });

    expect(result.markers).toEqual([]);
    expect(result.evidenceWindow).toMatchObject({
      evidenceLine: 2,
      startLine: 1,
      endLine: 2,
    });
  });

  it('reads a path and scans around a requested evidence line', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ontoindex-pr-marker-'));
    const filePath = path.join(dir, 'sample.ts');

    try {
      await writeFile(filePath, ['const a = 1;', '# deferred for rollout', 'target();'].join('\n'));

      const result = await scanPrMarkersNearPath({
        filePath,
        displayFile: 'src/sample.ts',
        evidenceLine: 3,
        windowBefore: 1,
        windowAfter: 0,
      });

      expect(result.file).toBe('src/sample.ts');
      expect(result.markers).toEqual([
        expect.objectContaining({
          file: 'src/sample.ts',
          line: 2,
          markerKind: 'DEFERRED',
          suggestedTag: 'KNOWN-DEFERRED',
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
