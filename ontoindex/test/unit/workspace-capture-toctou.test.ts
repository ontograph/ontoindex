import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  captureWorkspaceInputs,
  workspaceConfigurationIdentity,
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
    // The persistent symlink is rejected by the path recheck. O_NOFOLLOW protects only the
    // leaf; this schedule does not prove containment under an ancestor swap-and-restore.
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

async function makeRepo(): Promise<string> {
  const root = await fs.realpath(await tempDir('ontoindex-identity-root-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/main.ts'), 'export const inside = 1;\n');
  await fs.writeFile(path.join(root, 'tsconfig.json'), '{}');
  return root;
}

async function pendingCaptures(root: string): Promise<string[]> {
  return fs.readdir(path.join(root, '.ontoindex/workspace-inputs')).catch(() => []);
}

function observeInput(target: string, editStat?: (stat: Stats, openNumber: number) => Stats) {
  const reads: { mock: { calls: unknown[][] } }[] = [];
  const closes: { mock: { calls: unknown[][] } }[] = [];
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
    const handle = await realOpen(file, ...args);
    if (String(file) !== target) return handle;
    reads.push(vi.spyOn(handle, 'read'));
    closes.push(vi.spyOn(handle, 'close'));
    const openNumber = reads.length;
    if (editStat) {
      const realStat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async () =>
        editStat(await realStat(), openNumber),
      );
    }
    return handle;
  });
  return { reads, closes };
}

const readers = [
  { reader: 'capture', relativePath: 'src/main.ts', opens: 2 },
  { reader: 'configuration', relativePath: 'tsconfig.json', opens: 1 },
] as const;

async function readInputs(root: string, reader: (typeof readers)[number]['reader']) {
  if (reader === 'configuration')
    return workspaceConfigurationIdentity(root, { includePaths: ['src/main.ts'] });
  const capture = await captureWorkspaceInputs(root, {
    includePaths: ['src/main.ts'],
    parserIdentity: 'identity-test',
  });
  captures.push(capture);
  return capture;
}

describe.each(readers)('$reader descriptor identity', ({ reader, relativePath, opens }) => {
  it.each(['dev', 'ino'] as const)(
    'rejects equal-content %s mismatch before reading or copying, with bounded cleanup',
    async (field) => {
      const root = await makeRepo();
      const borrowed = await captureWorkspaceInputs(root, { includePaths: ['src/main.ts'] });
      captures.push(borrowed);
      const observations = observeInput(path.join(root, relativePath), (stat) =>
        Object.assign(stat, { [field]: stat[field] + 1 }),
      );
      const writes = vi.spyOn(fs, 'writeFile');

      await expect(readInputs(root, reader)).rejects.toMatchObject({ code: 'changed-input' });

      expect(observations.reads.map((read) => read.mock.calls.length)).toEqual(
        Array(opens).fill(0),
      );
      expect(observations.closes.map((close) => close.mock.calls.length)).toEqual(
        Array(opens).fill(1),
      );
      expect(
        writes.mock.calls.filter(
          ([file]) => String(file).includes('/capture-') && String(file).endsWith(relativePath),
        ),
      ).toEqual([]);
      expect(await pendingCaptures(root)).toEqual([path.basename(borrowed.captureRoot)]);
    },
  );

  it.each(['dev', 'ino'] as const)(
    'rejects pathname %s mismatch after reading before accepting equal-content copies',
    async (field) => {
      const root = await makeRepo();
      const target = path.join(root, relativePath);
      const observations = observeInput(target);
      const realLstat = fs.lstat.bind(fs);
      vi.spyOn(fs, 'lstat').mockImplementation(async (file, ...args) => {
        const stat = await realLstat(file, ...args);
        if (
          String(file) === target &&
          observations.reads.some(
            (read, index) =>
              read.mock.calls.length > 0 && observations.closes[index].mock.calls.length === 0,
          )
        ) {
          Object.assign(stat, { [field]: Number(stat[field]) + 1 });
        }
        return stat;
      });
      const writes = vi.spyOn(fs, 'writeFile');

      await expect(readInputs(root, reader)).rejects.toMatchObject({ code: 'changed-input' });

      expect(observations.reads).toHaveLength(opens);
      expect(observations.reads.every((read) => read.mock.calls.length > 0)).toBe(true);
      expect(observations.closes.map((close) => close.mock.calls.length)).toEqual(
        Array(opens).fill(1),
      );
      expect(
        writes.mock.calls.filter(
          ([file]) => String(file).includes('/capture-') && String(file).endsWith(relativePath),
        ),
      ).toEqual([]);
      expect(await pendingCaptures(root)).toEqual([]);
    },
  );

  it('rejects an unsupported descriptor without reading or retrying', async () => {
    const root = await makeRepo();
    const observations = observeInput(path.join(root, relativePath), (stat) =>
      Object.assign(stat, { isFile: () => false }),
    );

    await expect(readInputs(root, reader)).rejects.toMatchObject({ code: 'unsupported' });

    expect(observations.reads.map((read) => read.mock.calls.length)).toEqual([0]);
    expect(observations.closes.map((close) => close.mock.calls.length)).toEqual([1]);
    expect(await pendingCaptures(root)).toEqual([]);
  });

  it('accepts matching owned regular-file identities', async () => {
    const root = await makeRepo();
    const observations = observeInput(path.join(root, relativePath));

    const result = await readInputs(root, reader);

    expect(result.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(observations.reads).toHaveLength(opens);
    expect(observations.reads.every((read) => read.mock.calls.length > 0)).toBe(true);
    expect(observations.closes.map((close) => close.mock.calls.length)).toEqual(
      Array(opens).fill(1),
    );
    if (reader === 'capture') {
      const capture = result as WorkspaceInputCapture;
      expect(await fs.readFile(path.join(capture.captureRoot, relativePath), 'utf8')).toBe(
        await fs.readFile(path.join(root, relativePath), 'utf8'),
      );
      await capture.dispose();
    }
    expect(await pendingCaptures(root)).toEqual([]);
  });
});

it('retries a transient descriptor mismatch once and retains only the accepted capture', async () => {
  const root = await makeRepo();
  const observations = observeInput(path.join(root, 'src/main.ts'), (stat, openNumber) =>
    openNumber === 1 ? Object.assign(stat, { ino: stat.ino + 1 }) : stat,
  );

  const result = (await readInputs(root, 'capture')) as WorkspaceInputCapture;

  expect(observations.reads).toHaveLength(3);
  expect(observations.reads[0].mock.calls).toEqual([]);
  expect(observations.reads.slice(1).every((read) => read.mock.calls.length > 0)).toBe(true);
  expect(observations.closes.map((close) => close.mock.calls.length)).toEqual([1, 1, 1]);
  expect(await pendingCaptures(root)).toEqual([path.basename(result.captureRoot)]);
});

const ancestorSwapReaders = [
  { reader: 'capture', relativePath: 'src/main.ts', opens: 2 },
  { reader: 'configuration', relativePath: 'src/tsconfig.json', opens: 1 },
] as const;

async function ancestorSwapFixture(equalContent: boolean) {
  const root = await makeRepo();
  const outside = await fs.realpath(await tempDir('ontoindex-swap-owned-'));
  await fs.mkdir(path.join(outside, 'src'));
  const original = {
    'src/main.ts': 'export const ownedSentinel = 1;\n',
    'src/tsconfig.json': '{"compilerOptions":{"strict":true}}\n',
  };
  for (const [relativePath, content] of Object.entries(original)) {
    await fs.writeFile(path.join(root, relativePath), content);
    const alternate = relativePath.endsWith('.ts')
      ? 'export const ownedSentinel = 2;\n'
      : '{"compilerOptions":{"strict":false}}\n';
    await fs.writeFile(path.join(outside, relativePath), equalContent ? content : alternate);
    const [insideStat, outsideStat] = await Promise.all([
      fs.stat(path.join(root, relativePath)),
      fs.stat(path.join(outside, relativePath)),
    ]);
    expect(insideStat.isFile()).toBe(true);
    expect(outsideStat.isFile()).toBe(true);
    expect([insideStat.dev, insideStat.ino]).not.toEqual([outsideStat.dev, outsideStat.ino]);
  }
  const borrowed = await captureWorkspaceInputs(root, { includePaths: ['src/main.ts'] });
  captures.push(borrowed);
  const borrowedBytes = await Promise.all(
    Object.keys(original).map((relativePath) =>
      fs.readFile(path.join(borrowed.captureRoot, relativePath)),
    ),
  );
  return { root, outside, original, borrowed, borrowedBytes };
}

function swapAncestorAtOpen(
  root: string,
  outside: string,
  relativePath: string,
  persistent: boolean,
) {
  const realOpen = fs.open.bind(fs);
  const reads: { mock: { calls: unknown[][] } }[] = [];
  const closes: { mock: { calls: unknown[][] } }[] = [];
  let swaps = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
    if (String(file) !== path.join(root, relativePath)) return realOpen(file, ...args);
    if (!persistent && swaps > 0) {
      const handle = await realOpen(file, ...args);
      reads.push(vi.spyOn(handle, 'read'));
      closes.push(vi.spyOn(handle, 'close'));
      return handle;
    }
    swaps++;
    const ancestor = path.join(root, 'src');
    const saved = path.join(root, 'src-swap-reserved');
    let linked = false;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    await fs.rename(ancestor, saved);
    try {
      await fs.symlink(path.join(outside, 'src'), ancestor);
      linked = true;
      handle = await realOpen(file, ...args);
      reads.push(vi.spyOn(handle, 'read'));
      closes.push(vi.spyOn(handle, 'close'));
    } finally {
      try {
        if (linked) await fs.unlink(ancestor);
        await fs.rename(saved, ancestor);
      } catch (error) {
        await handle?.close();
        throw error;
      }
    }
    return handle!;
  });
  return { reads, closes, swaps: () => swaps };
}

describe.each(ancestorSwapReaders)(
  '$reader real ancestor swap-and-restore',
  ({ reader, relativePath, opens }) => {
    it.each([true, false])(
      'rejects persistent redirected descriptors before reading (equal content: %s)',
      async (equalContent) => {
        for (let repetition = 0; repetition < 3; repetition++) {
          const fixture = await ancestorSwapFixture(equalContent);
          const { root, outside, original, borrowed, borrowedBytes } = fixture;
          const observations = swapAncestorAtOpen(root, outside, relativePath, true);
          try {
            await expect(readInputs(root, reader)).rejects.toMatchObject({ code: 'changed-input' });
            expect(observations.swaps()).toBe(opens);
            expect(observations.reads.map((read) => read.mock.calls.length)).toEqual(
              Array(opens).fill(0),
            );
            expect(observations.closes.map((close) => close.mock.calls.length)).toEqual(
              Array(opens).fill(1),
            );
            expect(await pendingCaptures(root)).toEqual([path.basename(borrowed.captureRoot)]);
            expect((await fs.lstat(path.join(root, 'src'))).isDirectory()).toBe(true);
            await expect(fs.lstat(path.join(root, 'src-swap-reserved'))).rejects.toMatchObject({
              code: 'ENOENT',
            });
            expect(
              await Promise.all(
                Object.keys(original).map((input) =>
                  fs.readFile(path.join(borrowed.captureRoot, input)),
                ),
              ),
            ).toEqual(borrowedBytes);
          } finally {
            vi.restoreAllMocks();
          }
        }
      },
    );
  },
);

it.each([true, false])(
  'retries a transient real ancestor swap and captures original bytes (equal content: %s)',
  async (equalContent) => {
    const { root, outside, original, borrowed } = await ancestorSwapFixture(equalContent);
    const observations = swapAncestorAtOpen(root, outside, 'src/main.ts', false);

    const capture = (await readInputs(root, 'capture')) as WorkspaceInputCapture;

    expect(observations.swaps()).toBe(1);
    expect(observations.reads).toHaveLength(3);
    expect(observations.reads[0].mock.calls).toEqual([]);
    expect(observations.reads.slice(1).every((read) => read.mock.calls.length > 0)).toBe(true);
    expect(observations.closes.map((close) => close.mock.calls.length)).toEqual([1, 1, 1]);
    expect((await pendingCaptures(root)).sort()).toEqual(
      [path.basename(borrowed.captureRoot), path.basename(capture.captureRoot)].sort(),
    );
    for (const [relativePath, content] of Object.entries(original)) {
      expect(await fs.readFile(path.join(capture.captureRoot, relativePath), 'utf8')).toBe(content);
    }
  },
);

it('accepts an independent configuration read after a transient real ancestor swap', async () => {
  const { root, outside, original, borrowed, borrowedBytes } = await ancestorSwapFixture(true);
  const baseline = await workspaceConfigurationIdentity(root, { includePaths: ['src/main.ts'] });
  const observations = swapAncestorAtOpen(root, outside, 'src/tsconfig.json', false);

  await expect(readInputs(root, 'configuration')).rejects.toMatchObject({ code: 'changed-input' });

  expect(observations.swaps()).toBe(1);
  expect(observations.reads.map((read) => read.mock.calls.length)).toEqual([0]);
  expect(observations.closes.map((close) => close.mock.calls.length)).toEqual([1]);
  expect(await readInputs(root, 'configuration')).toEqual(baseline);
  expect(observations.swaps()).toBe(1);
  expect(observations.reads).toHaveLength(2);
  expect(observations.reads[1].mock.calls.length).toBeGreaterThan(0);
  expect(observations.closes.map((close) => close.mock.calls.length)).toEqual([1, 1]);
  expect(await pendingCaptures(root)).toEqual([path.basename(borrowed.captureRoot)]);
  for (const [relativePath, content] of Object.entries(original)) {
    expect(await fs.readFile(path.join(root, relativePath), 'utf8')).toBe(content);
  }
  expect(
    await Promise.all(
      Object.keys(original).map((input) => fs.readFile(path.join(borrowed.captureRoot, input))),
    ),
  ).toEqual(borrowedBytes);
});

it('rejects real equal-content pathname replacement after reading on both capture attempts', async () => {
  const root = await makeRepo();
  const target = path.join(root, 'src/main.ts');
  const original = await fs.readFile(target);
  const borrowed = await captureWorkspaceInputs(root, { includePaths: ['src/main.ts'] });
  captures.push(borrowed);
  const borrowedInput = path.join(borrowed.captureRoot, 'src/main.ts');
  const borrowedBytes = await fs.readFile(borrowedInput);
  const realOpen = fs.open.bind(fs);
  const closes: { mock: { calls: unknown[][] } }[] = [];
  let replacements = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
    const handle = await realOpen(file, ...args);
    if (String(file) !== target) return handle;
    closes.push(vi.spyOn(handle, 'close'));
    const realRead = handle.read.bind(handle);
    let replaced = false;
    vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
      const result = await realRead(...readArgs);
      if (!replaced) {
        replaced = true;
        const replacement = path.join(root, `replacement-${replacements++}.ts`);
        await fs.writeFile(replacement, original, { flag: 'wx' });
        const [openedStat, replacementStat] = await Promise.all([
          handle.stat(),
          fs.stat(replacement),
        ]);
        expect([replacementStat.dev, replacementStat.ino]).not.toEqual([
          openedStat.dev,
          openedStat.ino,
        ]);
        await fs.rename(replacement, target);
      }
      return result;
    });
    return handle;
  });
  const attempts = vi.spyOn(fs, 'mkdtemp');

  await expect(readInputs(root, 'capture')).rejects.toMatchObject({ code: 'changed-input' });

  expect(replacements).toBe(2);
  expect(closes.map((close) => close.mock.calls.length)).toEqual([1, 1]);
  expect(
    attempts.mock.calls.filter(([prefix]) => String(prefix).includes('/capture-')),
  ).toHaveLength(2);
  expect(await fs.readFile(target)).toEqual(original);
  expect(await pendingCaptures(root)).toEqual([path.basename(borrowed.captureRoot)]);
  expect(await fs.readFile(borrowedInput)).toEqual(borrowedBytes);
});

describe.each(readers)('$reader static nonregular input', ({ reader, relativePath }) => {
  it.each(['fifo', 'socket'] as const)(
    'rejects a real %s and preserves a borrowed capture',
    async (kind) => {
      const root = await makeRepo();
      const target = path.join(root, relativePath);
      const original = await fs.readFile(target);
      const borrowed = await captureWorkspaceInputs(root, { includePaths: ['src/main.ts'] });
      captures.push(borrowed);
      const borrowedInput = path.join(borrowed.captureRoot, relativePath);
      const borrowedBytes = await fs.readFile(borrowedInput);
      let server: net.Server | undefined;

      try {
        await fs.unlink(target);
        if (kind === 'fifo') {
          execFileSync('mkfifo', [target], { timeout: 5000 });
        } else {
          const socket = net.createServer();
          server = socket;
          await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.listen(target, resolve);
          });
        }
        const stat = await fs.lstat(target);
        expect(stat.isFIFO()).toBe(kind === 'fifo');
        expect(stat.isSocket()).toBe(kind === 'socket');
        expect(stat.isFile()).toBe(false);
        if (server) expect(server.listening).toBe(true);
        const observations = observeInput(target);
        const attempts = vi.spyOn(fs, 'mkdtemp');
        const writes = vi.spyOn(fs, 'writeFile');

        await expect(readInputs(root, reader)).rejects.toMatchObject({ code: 'unsupported' });

        const expectedHandles = reader === 'capture' && kind === 'fifo' ? 1 : 0;
        expect(observations.reads).toHaveLength(expectedHandles);
        expect(observations.reads.map((read) => read.mock.calls.length)).toEqual(
          Array(expectedHandles).fill(0),
        );
        expect(observations.closes.map((close) => close.mock.calls.length)).toEqual(
          Array(expectedHandles).fill(1),
        );
        expect(
          attempts.mock.calls.filter(([prefix]) => String(prefix).includes('/capture-')),
        ).toHaveLength(reader === 'capture' ? 1 : 0);
        expect(
          writes.mock.calls.filter(([file]) =>
            String(file).startsWith(path.join(root, '.ontoindex/workspace-inputs') + path.sep),
          ),
        ).toEqual([]);
        expect(await pendingCaptures(root)).toEqual([path.basename(borrowed.captureRoot)]);
        expect(await fs.readFile(borrowedInput)).toEqual(borrowedBytes);
      } finally {
        vi.restoreAllMocks();
        try {
          if (server?.listening) {
            const socket = server;
            await new Promise<void>((resolve, reject) => {
              socket.close((error) => (error ? reject(error) : resolve()));
            });
          }
        } finally {
          await fs.rm(target, { force: true });
          await fs.writeFile(target, original);
        }
      }

      expect(server?.listening ?? false).toBe(false);
      expect((await fs.lstat(target)).isFile()).toBe(true);
      const control = await readInputs(root, reader);
      expect(control.configurationDigest).toBe(borrowed.configurationDigest);
      if (reader === 'capture') await (control as WorkspaceInputCapture).dispose();
      expect(await pendingCaptures(root)).toEqual([path.basename(borrowed.captureRoot)]);
      expect(await fs.readFile(borrowedInput)).toEqual(borrowedBytes);
    },
  );
});
