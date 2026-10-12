import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readResource } from '../../src/mcp/resources.js';
import { runDocsMcpAction } from '../../src/mcp/super/docs.js';

describe('memory consumer coverage', () => {
  let root: string;
  let directory: string;
  let repo: any;
  let backend: any;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-consumers-'));
    directory = path.join(root, '.ontoindex/memories');
    await fs.mkdir(directory, { recursive: true });
    repo = {
      id: 'fixture',
      name: 'fixture',
      repoPath: root,
      path: root,
      storagePath: path.join(root, '.ontoindex'),
      lastCommit: 'abc',
    };
    backend = { resolveRepo: async () => repo };
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports exact candidate total and partial acquired counts without bodies', async () => {
    for (let i = 0; i < 129; i++) {
      await fs.writeFile(
        path.join(directory, `${String(i).padStart(3, '0')}.md`),
        'private-body-marker',
      );
    }
    const list = await readResource('ontoindex://repo/fixture/memories', backend);
    expect(list).toContain('truncated: true');
    expect(list).toContain('total: 129');
    expect(list).toContain('emitted: 128');
    expect(list).not.toContain('private-body-marker');
    const baseline = await runDocsMcpAction(repo, { action: 'readiness' });
    const docs = await runDocsMcpAction(repo, {
      action: 'readiness',
      includeMemories: true,
      format: 'both',
    });
    expect(docs.advisoryMemories).toMatchObject({
      availability: { status: 'partial', total: 129 },
      coverage: { truncated: true, emitted: 128, countsScope: 'acquired-memories' },
      validity: { invalid: 128 },
    });
    expect(docs.summary).toEqual(baseline.summary);
    expect(docs.sidecar).toEqual(baseline.sidecar);
    expect(baseline).not.toHaveProperty('advisoryMemories');
    expect(await readResource('ontoindex://repo/fixture/onboarding', backend)).toContain(
      'fallback requires a complete',
    );
    await fs.writeFile(path.join(directory, 'onboarding.md'), '# preferred-marker');
    const onboarding = await readResource('ontoindex://repo/fixture/onboarding', backend);
    expect(onboarding).toContain('preferred-marker');
    expect(onboarding).toContain('invalid_memory: true');
  });

  it('keeps unknown directory totals explicit in JSON and inline docs', async () => {
    for (let i = 0; i < 1025; i++) await fs.writeFile(path.join(directory, `${i}.txt`), '');
    const list = await readResource('ontoindex://repo/fixture/memories', backend);
    expect(list).toContain('total: null');
    expect(list).not.toContain('No advisory memories found');
    const docs = await runDocsMcpAction(repo, {
      action: 'context',
      includeMemories: true,
      format: 'both',
    });
    expect(docs.advisoryMemories).toMatchObject({
      availability: { status: 'partial', total: null },
      coverage: { emitted: 0, truncated: true },
    });
    expect(docs.inlineContext?.text).toContain('total=unknown');
    expect(docs.inlineContext?.text).toContain('truncated=true');
  });

  it('preserves normal missing-directory onboarding and docs status', async () => {
    await fs.rm(directory, { recursive: true });
    expect(await readResource('ontoindex://repo/fixture/onboarding', backend)).toContain(
      'No advisory memories found',
    );
    const docs = await runDocsMcpAction(repo, { action: 'context', includeMemories: true });
    expect(docs.advisoryMemories?.availability).toMatchObject({ status: 'missing', total: 0 });
  });
});
