import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIndexGeneration,
  publishIndexGenerationTransaction,
  resolveActiveIndexGeneration,
} from '../../src/storage/repo-manager.js';

describe('plain analysis publication retention', () => {
  let storage: string;
  beforeEach(async () => {
    storage = await fs.mkdtemp(path.join(os.tmpdir(), 'analyze-retention-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(storage, { recursive: true, force: true });
  });

  async function publish(id: string) {
    const generation = await createIndexGeneration(storage, id);
    await Promise.all(
      ['meta.json', 'snapshot.json', 'lbug'].map((file) =>
        fs.writeFile(path.join(generation.generationPath, file), '{}'),
      ),
    );
    return (await publishIndexGenerationTransaction(storage, generation, async () => undefined))
      .activeGeneration;
  }

  it('marks publications in order and retains active plus two newest managed generations and legacy data', async () => {
    const legacy = path.join(storage, 'generations', 'legacy');
    await fs.mkdir(legacy, { recursive: true });
    let previous = 0;
    for (const id of ['one', 'two', 'three', 'four']) {
      const generation = await publish(id);
      const marker = Number(
        await fs.readFile(path.join(generation.generationPath, '.retention-managed'), 'utf8'),
      );
      expect(Number.isSafeInteger(marker)).toBe(true);
      expect(marker).toBeGreaterThan(previous);
      previous = marker;
    }
    expect((await fs.readdir(path.join(storage, 'generations'))).sort()).toEqual([
      'four',
      'legacy',
      'three',
      'two',
    ]);
    expect((await resolveActiveIndexGeneration(storage))?.generationId).toBe('four');
  });

  it('retains a managed generation pinned by a live reader', async () => {
    const first = await publish('one');
    await fs.writeFile(path.join(first.generationPath, `.reader-${process.pid}-test`), '');
    for (const id of ['two', 'three', 'four']) await publish(id);
    expect(await fs.stat(first.generationPath)).toBeDefined();
  });

  it('keeps publication successful when writing the retention marker fails', async () => {
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(((
      file: Parameters<typeof fs.writeFile>[0],
      ...args: any[]
    ) => {
      if (String(file).endsWith('/.retention-managed'))
        return Promise.reject(new Error('marker unavailable'));
      return (writeFile as any)(file, ...args);
    }) as typeof fs.writeFile);
    await publish('one');
    expect((await resolveActiveIndexGeneration(storage))?.generationId).toBe('one');
  });

  it('routes plain analysis through retention-aware publication', async () => {
    const source = await fs.readFile(
      new URL('../../src/core/run-analyze.ts', import.meta.url),
      'utf8',
    );
    expect(
      source.includes(
        'publishIndexGenerationTransaction(storagePath, stagedGeneration, async () => undefined)',
      ),
    ).toBe(true);
    expect(source.includes('activateIndexGeneration(storagePath, stagedGeneration)')).toBe(false);
  });
});
