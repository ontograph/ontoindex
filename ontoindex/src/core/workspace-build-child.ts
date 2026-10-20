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

let options: Parameters<typeof runFullAnalysis>[1] = {
  workspaceGraph: true,
  skipNativeClose: true,
};
if (process.argv[3] !== undefined) {
  try {
    const paths: unknown = JSON.parse(process.argv[4] ?? 'null');
    if (
      process.argv[3] !== '--symbols' ||
      process.argv.length !== 5 ||
      !Array.isArray(paths) ||
      paths.length > 50 ||
      paths.some(
        (item) =>
          typeof item !== 'string' ||
          !item ||
          item.includes('\\') ||
          item.startsWith('/') ||
          item.split('/').some((part) => part === '..' || part === '.'),
      )
    ) {
      throw new Error('invalid bounded symbols paths');
    }
    options = { dirtyOverlay: true, overlayPaths: paths, skipNativeClose: true };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

runFullAnalysis(repoPath, options, { onProgress() {} }).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
