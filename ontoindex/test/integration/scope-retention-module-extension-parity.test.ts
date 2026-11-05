import { describe, expect, it } from 'vitest';
import { graphSnapshot, runRetainedReplayParity } from '../helpers/scope-retention-replay.js';

describe.sequential('retained replay with module extensions', () => {
  it('matches the live graph', async () => {
    const files = {
      'lib.mjs': 'export function kill() {}\nexport function run() { kill(); }\n',
      'tool.cjs': 'function helper() {}\nmodule.exports = { helper };\nhelper();\n',
      'types.mts': 'export function mtsHelper() {}\n',
      'a.ts':
        "import { kill } from './lib.mjs';\nimport { mtsHelper } from './types.mts';\nexport function entry() { kill(); mtsHelper(); }\n",
      'b.js': 'export function jsHelper() {}\nexport function jsEntry() { jsHelper(); }\n',
    };
    const result = await runRetainedReplayParity({
      files,
      options: (repo) => ({
        profile: 'full' as const,
        skipGraphPhases: true,
        skipWorkers: true,
        capturedWorkspace: { captureRoot: repo, canonicalRepoPath: repo },
      }),
      onRetained: async (handle) => {
        expect(handle.status).toBe('retained');
        expect(handle.inputEvidence.complete).toBe(true);
      },
    });
    try {
      const { full, replay, preserve } = result;
      expect(full.parseMode).toBe('full');
      expect(replay.parseMode).toBe('retained-replay');
      expect(preserve).toHaveBeenCalledTimes(1);
      expect(graphSnapshot(replay.graph)).toEqual(graphSnapshot(full.graph));
      const calls = replay.graph.relationships
        .filter((edge) => edge.type === 'CALLS')
        .map((edge) => [edge.sourceId, edge.targetId]);
      expect(calls).toContainEqual([
        expect.stringContaining('a.ts'),
        expect.stringContaining('lib.mjs'),
      ]);
      expect(calls).toContainEqual([
        expect.stringContaining('lib.mjs:run'),
        expect.stringContaining('lib.mjs:kill'),
      ]);
    } finally {
      result.cleanup();
    }
  }, 120_000);
});
