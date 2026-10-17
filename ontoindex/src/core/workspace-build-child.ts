/**
 * Child entry for a supervised working-tree graph build. The server runs this in its own process
 * group so a deadline can kill the build and reclaim its memory. The parent holds the analyze lock.
 */
import { startParentWatchdog } from './parent-watchdog.js';
import { runFullAnalysis } from './run-analyze.js';

const repoPath = process.argv[2];
if (!repoPath) {
  console.error('workspace build child requires a repository path');
  process.exit(2);
}

startParentWatchdog(process.ppid);

runFullAnalysis(
  repoPath,
  { workspaceGraph: true, skipNativeClose: true },
  { onProgress() {} },
).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
