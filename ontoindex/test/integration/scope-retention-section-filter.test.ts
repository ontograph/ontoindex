import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('scope retention Markdown section filtering', () => {
  const directories: string[] = [];

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps TypeScript declarations without retaining oversized Markdown sections or their edges', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-retention-section-filter-'));
    directories.push(directory);
    fs.writeFileSync(
      path.join(directory, 'a.ts'),
      'export function make() { return 1; }\nmake();\n',
    );
    fs.writeFileSync(
      path.join(directory, 'notes.md'),
      [
        '# Notes',
        '## Large section',
        'Section body. '.repeat(26_000),
        '## Small section',
        'A short ending.',
      ].join('\n'),
    );

    let consumed = false;
    const result = await runPipelineFromRepo(directory, () => {}, {
      // The default profile still runs Markdown before parse; only later graph
      // summary phases are skipped. A symbols profile would omit Markdown.
      skipGraphPhases: true,
      skipWorkers: true,
      scopeRetention: {
        deadline: Date.now() + 60_000,
        artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
        consume: async (handle) => {
          consumed = true;
          let retainedMake = false;
          for await (const batch of handle.iterateGraphNodes()) {
            for (const node of batch) {
              expect(node.label).not.toBe('Section');
              if (
                node.label === 'Function' &&
                node.properties.filePath === 'a.ts' &&
                node.properties.name === 'make'
              )
                retainedMake = true;
            }
          }
          expect(retainedMake).toBe(true);
          for await (const batch of handle.iterateGraphRelationships()) {
            for (const edge of batch) {
              expect(edge.sourceId).not.toMatch(/^Section:/);
              expect(edge.targetId).not.toMatch(/^Section:/);
            }
          }
          // A Markdown file has no parse outcome, so the handle stays incomplete for that reason.
          expect(handle.reasons.filter((reason) => reason.startsWith('graph-'))).toEqual([]);
        },
      },
    });

    expect(consumed).toBe(true);
    expect(result.usedWorkerPool).toBe(false);
    // Prove the producer actually created sections exceeding the 256 KiB
    // retention record cap, so the exclusion assertions cannot pass vacuously.
    const sections = result.graph.nodes.filter((node) => node.label === 'Section');
    expect(sections).toHaveLength(3);
    expect(
      sections.some(
        (node) =>
          typeof node.properties.content === 'string' &&
          Buffer.byteLength(node.properties.content, 'utf8') > 300 * 1024,
      ),
    ).toBe(true);
    expect(result.graph.relationships.some((edge) => edge.sourceId.startsWith('Section:'))).toBe(
      true,
    );
    expect(result.graph.relationships.some((edge) => edge.targetId.startsWith('Section:'))).toBe(
      true,
    );
  }, 90_000);
});
