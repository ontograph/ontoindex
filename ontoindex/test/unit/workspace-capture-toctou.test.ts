import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureWorkspaceInputs,
  type WorkspaceInputCapture,
} from '../../src/core/analyze-delta.js';

const roots: string[] = [];
const captures: WorkspaceInputCapture[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(captures.splice(0).map((c) => c.dispose().catch(() => {})));
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

/*
 * The ADW-2 audit asked whether an ancestor swapped to a symlink between the path check
 * (checkCapturePath) and fs.open can make capture read bytes from outside the repository.
 * This drives that exact interval: the first open of the target file swaps `src` for a
 * symlink to an outside tree immediately before the real open runs.
 */
describe('capture ancestor swap between path check and open', () => {
  it('never returns bytes from outside the repository', async () => {
    const root = await fs.realpath(await tempDir('ontoindex-toctou-root-'));
    const outside = await tempDir('ontoindex-toctou-outside-');
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/main.ts'), 'export const inside = 1;\n');
    await fs.mkdir(path.join(outside, 'src'));
    await fs.writeFile(path.join(outside, 'src/main.ts'), 'export const OUTSIDE_SECRET = 2;\n');

    const realOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
      if (!swapped && String(file).endsWith(`${path.basename(root)}/src/main.ts`)) {
        swapped = true;
        await fs.rename(path.join(root, 'src'), path.join(root, 'src-real'));
        await fs.symlink(path.join(outside, 'src'), path.join(root, 'src'));
      }
      return realOpen(file as never, ...(rest as []));
    });

    let result: WorkspaceInputCapture | undefined;
    let error: unknown;
    try {
      result = await captureWorkspaceInputs(root, { includePaths: ['src/main.ts'] });
      captures.push(result);
    } catch (caught) {
      error = caught;
    }

    expect(swapped).toBe(true);
    // The swap must be rejected outright. Three layers each catch it on their own today (the
    // post-read path recheck, O_NOFOLLOW on the leaf, and the final manifest comparison), so
    // this test pins the outcome, not one layer.
    expect(result).toBeUndefined();
    expect(error).toMatchObject({ code: 'unsupported' });
    // Whatever happened, no capture directory may be left behind with outside bytes.
    const leftovers = await fs
      .readdir(path.join(root, '.ontoindex/workspace-inputs'))
      .catch(() => [] as string[]);
    for (const name of leftovers) {
      const file = path.join(root, '.ontoindex/workspace-inputs', name, 'src/main.ts');
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      expect(text).not.toContain('OUTSIDE_SECRET');
    }
  });
});
