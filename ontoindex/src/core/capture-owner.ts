import fs from 'node:fs/promises';
import path from 'node:path';
import { readProcessStartIdentity } from '../storage/repo-manager.js';

/** The marker sits beside the capture root: the root itself is re-read as a repository to verify the copy. */
const ownerPath = (captureRoot: string): string => `${captureRoot}.owner.json`;

export async function writeCaptureOwner(captureRoot: string): Promise<void> {
  await fs.writeFile(
    ownerPath(captureRoot),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      startTicks: readProcessStartIdentity(process.pid) ?? null,
    }),
    { flag: 'wx', mode: 0o600 },
  );
}

export async function removeCaptureOwner(captureRoot: string): Promise<void> {
  await fs.unlink(ownerPath(captureRoot)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function sweepDeadCaptures(
  workspaceInputsDir: string,
  { uid = process.getuid?.() }: { uid?: number } = {},
): Promise<void> {
  if (uid === undefined) return;
  const entries = await fs.readdir(workspaceInputsDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.startsWith('capture-') || entry.endsWith('.owner.json')) continue;
    try {
      const captureRoot = path.join(workspaceInputsDir, entry);
      const directory = await fs.lstat(captureRoot);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid) continue;
      const markerPath = ownerPath(captureRoot);
      const marker = await fs.lstat(markerPath);
      if (!marker.isFile() || marker.isSymbolicLink() || marker.uid !== uid) continue;
      const raw = await fs.readFile(markerPath, 'utf8');
      const owner: unknown = JSON.parse(raw);
      if (typeof owner !== 'object' || owner === null || Array.isArray(owner)) continue;
      const { version, pid, startTicks } = owner as Record<string, unknown>;
      if (
        version !== 1 ||
        typeof pid !== 'number' ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        pid === process.pid ||
        !(startTicks === null || (typeof startTicks === 'string' && /^\d+$/.test(startTicks)))
      ) {
        continue;
      }
      let dead = false;
      try {
        process.kill(pid, 0);
        const currentStartTicks = readProcessStartIdentity(pid);
        dead =
          startTicks !== null &&
          currentStartTicks !== undefined &&
          currentStartTicks !== startTicks;
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
      if (!dead) continue;
      const current = await fs.lstat(captureRoot);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.uid !== uid ||
        current.dev !== directory.dev ||
        current.ino !== directory.ino ||
        (await fs.readFile(markerPath, 'utf8')) !== raw
      ) {
        continue;
      }
      await fs.rm(captureRoot, { recursive: true, force: true });
      await removeCaptureOwner(captureRoot);
    } catch {
      // Unreadable or concurrently changed captures are never cleanup authority.
    }
  }
}
