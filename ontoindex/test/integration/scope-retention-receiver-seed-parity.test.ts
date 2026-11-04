import { describe, expect, it } from 'vitest';
import { graphSnapshot, runRetainedReplayParity } from '../helpers/scope-retention-replay.js';

describe.sequential('retained worker replay receiver seeding', () => {
  it('preserves indexed receiver calls without guessing methods for imported receivers', async () => {
    const result = await runRetainedReplayParity({
      files: {
        'helpers.ts': "export const CONTAINERS = new Set(['a', 'b']);\n",
        'env.ts':
          "import { CONTAINERS } from './helpers';\nexport class Env { has(name: string): boolean { return false; } }\nexport function find(x: string) { return CONTAINERS.has(x); }\nexport function check(env: Env, x: string) { return env.has(x); }\n",
      },
      options: (repo) => ({
        profile: 'full' as const,
        skipGraphPhases: true,
        workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
        capturedWorkspace: { captureRoot: repo, canonicalRepoPath: repo },
      }),
    });
    try {
      const { full, replay, preserve } = result;
      expect(full.usedWorkerPool).toBe(true);
      const calls = full.graph.relationships
        .filter((edge) => edge.type === 'CALLS')
        .map((edge) => [edge.sourceId, edge.targetId]);
      expect(calls).not.toContainEqual([
        expect.stringContaining('env.ts:find'),
        expect.stringContaining('env.ts:Env.has'),
      ]);
      expect(calls).toContainEqual([
        expect.stringContaining('env.ts:check'),
        expect.stringContaining('env.ts:Env.has'),
      ]);
      expect(full.parseMode).toBe('full');
      expect(replay.parseMode).toBe('retained-replay');
      expect(preserve).toHaveBeenCalledTimes(1);
      expect(graphSnapshot(replay.graph)).toEqual(graphSnapshot(full.graph));
    } finally {
      result.cleanup();
    }
  }, 120_000);
});
