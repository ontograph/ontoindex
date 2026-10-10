import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDebouncedWatcher } from '../../src/cli/watch.js';

const DEBOUNCE_MS = 150;
const IS_DARWIN = process.platform === 'darwin';
// FSEvents can take longer to deliver/coalesce notifications than inotify.
const SETTLE_MS = DEBOUNCE_MS + (IS_DARWIN ? 2000 : 450);
const WATCHER_WARMUP_MS = IS_DARWIN ? 300 : 0;

describe('real fs.watch editor save patterns', () => {
  let parent: string;
  let root: string;
  let file: string;
  let observedFile: string;
  let watcher: ReturnType<typeof createDebouncedWatcher>;
  let refreshes: { content: string; at: number }[];
  let logs: string[];

  beforeEach(async () => {
    parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-watch-save-')));
    root = path.join(parent, 'root');
    fs.mkdirSync(root);
    root = fs.realpathSync(root);
    file = path.join(root, 'a.ts');
    observedFile = file;
    fs.writeFileSync(file, 'initial');
    refreshes = [];
    logs = [];
    watcher = createDebouncedWatcher({
      root,
      debounceMs: DEBOUNCE_MS,
      isLockHeld: () => false,
      refresh: async () => {
        refreshes.push({ content: fs.readFileSync(observedFile, 'utf8'), at: performance.now() });
      },
      log: (message) => logs.push(message),
    });
    watcher.start();
    if (WATCHER_WARMUP_MS) await delay(WATCHER_WARMUP_MS);
  });

  afterEach(() => {
    watcher?.stop();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  async function expectOneRefresh(save: () => void, content: string) {
    const count = refreshes.length;
    const started = performance.now();
    if (WATCHER_WARMUP_MS) await delay(WATCHER_WARMUP_MS);
    save();
    await delay(SETTLE_MS);
    const observed = refreshes.slice(count);
    expect(observed, JSON.stringify(observed)).toHaveLength(1);
    expect(observed[0].content).toBe(content);
    expect(observed[0].at - started).toBeGreaterThanOrEqual(DEBOUNCE_MS - 10);
    expect(logs).toEqual([]);
  }

  const saves = [
    {
      name: 'in-place truncate and write',
      save: (filename: string, content: string) => fs.writeFileSync(filename, content),
    },
    {
      name: 'temporary file renamed over the original',
      save: (filename: string, content: string) => {
        fs.writeFileSync(`${filename}.tmp`, content);
        fs.renameSync(`${filename}.tmp`, filename);
      },
    },
    {
      name: 'delete then create',
      save: (filename: string, content: string) => {
        fs.unlinkSync(filename);
        fs.writeFileSync(filename, content);
      },
    },
    {
      name: 'Vim backup rename then new original',
      save: (filename: string, content: string) => {
        fs.renameSync(filename, `${filename}~`);
        fs.writeFileSync(filename, content);
      },
    },
  ];

  it.each(saves)(
    '$name produces one refresh with new content and keeps watching',
    async ({ save }) => {
      await expectOneRefresh(() => save(file, 'saved'), 'saved');
      await expectOneRefresh(() => fs.writeFileSync(file, 'later'), 'later');
    },
  );

  it('coalesces 20 writes within 100 ms and reads the final content', async () => {
    await expectOneRefresh(() => {
      const started = performance.now();
      for (let i = 0; i < 20; i++) fs.writeFileSync(file, `burst-${i}`);
      expect(performance.now() - started).toBeLessThan(100);
    }, 'burst-19');
  });

  it.each(['a.ts~', '.a.ts.swp', 'a.ts.tmp', '4913'])(
    'does not refresh for editor artifact %s alone',
    async (name) => {
      const artifact = path.join(root, name);
      fs.writeFileSync(artifact, 'created');
      await delay(SETTLE_MS);
      expect(refreshes).toEqual([]);
      fs.writeFileSync(artifact, 'changed');
      await delay(SETTLE_MS);
      expect(refreshes).toEqual([]);
      fs.unlinkSync(artifact);
      await delay(SETTLE_MS);
      expect(refreshes).toEqual([]);
      await expectOneRefresh(() => fs.writeFileSync(file, 'source save'), 'source save');
      expect(refreshes).toHaveLength(1);
    },
  );

  it('coalesces nested directory and file creation and keeps watching the nested file', async () => {
    observedFile = path.join(root, 'nested', 'deeper', 'new.ts');
    await expectOneRefresh(() => {
      fs.mkdirSync(path.dirname(observedFile), { recursive: true });
      fs.writeFileSync(observedFile, 'nested');
    }, 'nested');
    await expectOneRefresh(() => fs.writeFileSync(observedFile, 'nested later'), 'nested later');
  });

  it('handles atomic replacement followed by delete/create on the same watcher', async () => {
    for (const { save, name } of saves) {
      await expectOneRefresh(() => save(file, name), name);
    }
    await expectOneRefresh(() => {
      for (let i = 0; i < 20; i++) fs.writeFileSync(file, `final-${i}`);
    }, 'final-19');
  });

  it.each([0, SETTLE_MS])(
    'logs and stops cleanly when root is deleted and recreated after %i ms',
    async (gap) => {
      fs.rmSync(root, { recursive: true });
      if (gap) await delay(gap);
      fs.mkdirSync(root);
      fs.writeFileSync(file, 'recreated');
      await delay(SETTLE_MS);
      expect(logs).toEqual([expect.stringContaining('Watcher stopped:')]);
      expect(refreshes).toEqual([]);

      // Root replacement is terminal, not automatic recovery: stop/start are safe no-ops.
      watcher.stop();
      watcher.start();
      fs.writeFileSync(file, 'after stop');
      await delay(SETTLE_MS);
      expect(refreshes).toEqual([]);
      expect(logs).toHaveLength(1);
    },
  );
});
