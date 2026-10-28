import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  captureWorkspaceInputs,
  type WorkspaceInputCapture,
} from '../../src/core/analyze-delta.js';

const roots: string[] = [];
const captures: WorkspaceInputCapture[] = [];

afterEach(async () => {
  await Promise.all(captures.splice(0).map((capture) => capture.dispose()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it.each(['file', 'directory'])(
  'excludes nested repository configuration with a .git %s',
  async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-nested-repo-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'top'));
    await fs.mkdir(path.join(root, 'sub/inner'), { recursive: true });
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, 'src/main.ts'), 'export const value = 1;\n');
    await fs.writeFile(path.join(root, 'top/App.csproj'), '<Project />');
    await fs.writeFile(path.join(root, 'sub/inner/App.csproj'), '<Project />');
    if (kind === 'directory') await fs.mkdir(path.join(root, 'sub/inner/.git'));
    else await fs.writeFile(path.join(root, 'sub/inner/.git'), 'gitdir: elsewhere\n');

    const capture = await captureWorkspaceInputs(root, {
      parserIdentity: 'test-parser-v1',
      includePaths: ['src/main.ts'],
    });
    captures.push(capture);
    expect(capture.capturedPaths).toContain('top/App.csproj');
    expect(capture.capturedPaths).not.toContain('sub/inner/App.csproj');
  },
);
