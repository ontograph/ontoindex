import { Worker } from 'node:worker_threads';

/**
 * Kill this process group when `parentPid` disappears. A worker thread does the polling so the
 * check still runs while the main thread is blocked in native work. The build child holds no lock
 * of its own, so it must never outlive the server that does.
 */
export function startParentWatchdog(parentPid: number, intervalMs = 1000): Worker {
  const source = `
    const { workerData } = require('node:worker_threads');
    setInterval(() => {
      try { process.kill(workerData.parentPid, 0); }
      catch (error) {
        if (error && error.code === 'EPERM') return;
        try { process.kill(-process.pid, 'SIGKILL'); } catch {}
        process.kill(process.pid, 'SIGKILL');
      }
    }, workerData.intervalMs);
  `;
  const worker = new Worker(source, { eval: true, workerData: { parentPid, intervalMs } });
  worker.unref();
  return worker;
}
