import fs from 'node:fs/promises';
import path from 'node:path';

const unsupportedDirectorySyncCodes = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP']);

export async function syncPath(
  target: string,
  { bestEffort = false }: { bestEffort?: boolean } = {},
): Promise<void> {
  try {
    const handle = await fs.open(target, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      !bestEffort ||
      !unsupportedDirectorySyncCodes.has((error as NodeJS.ErrnoException).code ?? '')
    ) {
      throw error;
    }
  }
}

export async function syncTree(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await syncTree(target);
    else if (entry.isFile()) await syncPath(target);
  }
  await syncPath(root, { bestEffort: true });
}
