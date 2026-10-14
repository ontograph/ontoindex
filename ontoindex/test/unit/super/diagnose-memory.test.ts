import { describe, expect, it } from 'vitest';
import { buildProcessMemory } from '../../../src/mcp/super/diagnose.js';

const MB = 1024 * 1024;
const usage: NodeJS.MemoryUsage = {
  rss: 600 * MB,
  heapUsed: 32 * MB,
  heapTotal: 36 * MB,
  external: 2 * MB,
  arrayBuffers: 0,
};

describe('buildProcessMemory', () => {
  it('reports the default buffer pool and disabled idle exit', () => {
    expect(buildProcessMemory(usage, {}, 0)).toMatchObject({
      bufferPoolMB: 64,
      idleExitMs: null,
    });
  });

  it('reports explicit buffer and idle-exit settings', () => {
    expect(
      buildProcessMemory(
        usage,
        { ONTOINDEX_LBUG_BUFFER_MB: '128', ONTOINDEX_MCP_IDLE_EXIT_MS: '600000' },
        2,
      ),
    ).toEqual({
      rssMB: 600,
      heapUsedMB: 32,
      heapTotalMB: 36,
      externalMB: 2,
      nativeMB: 564,
      openRepositoryPools: 2,
      bufferPoolMB: 128,
      idleExitMs: 600_000,
    });
  });

  it.each(['invalid', '1.5', '-1', '16385'])(
    'uses the default for invalid buffer setting %s',
    (value) => {
      expect(buildProcessMemory(usage, { ONTOINDEX_LBUG_BUFFER_MB: value }, 0).bufferPoolMB).toBe(
        64,
      );
    },
  );

  it.each([undefined, '', '0'])('uses the default for unset buffer setting %s', (value) => {
    expect(buildProcessMemory(usage, { ONTOINDEX_LBUG_BUFFER_MB: value }, 0).bufferPoolMB).toBe(64);
  });

  it('never reports negative native memory', () => {
    expect(buildProcessMemory({ ...usage, rss: 10 * MB, heapTotal: 20 * MB }, {}, 0).nativeMB).toBe(
      0,
    );
  });
});
