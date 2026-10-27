/**
 * Child entry for a supervised working-tree graph build. The server runs this in its own process
 * group so a deadline can kill the build and reclaim its memory. The parent holds the analyze lock.
 */
import { startParentWatchdog } from './parent-watchdog.js';
import { workspaceBuildExitCode } from '../mcp/local/workspace-build-supervisor.js';

(async () => {
  const repoPath = process.argv[2];
  if (!repoPath) {
    console.error('workspace build child requires a repository path');
    process.exit(2);
    return;
  }

  startParentWatchdog(process.ppid);

  let options: Parameters<typeof runFullAnalysis>[1] = {
    workspaceGraph: true,
    skipNativeClose: true,
  };
  let scopeRetention:
    | { deadline: number; artifactAllowance: { remainingBytes: number } }
    | undefined;
  if (process.argv[3] !== undefined) {
    try {
      const value: unknown = JSON.parse(process.argv[4] ?? 'null');
      if (process.argv[3] === '--scope-retention') {
        if (
          process.argv.length !== 5 ||
          value === null ||
          typeof value !== 'object' ||
          Array.isArray(value)
        ) {
          throw new Error('invalid bounded scope retention');
        }
        const request = value as Record<string, unknown>;
        const { timeoutMs, maxBytes } = request;
        if (
          Object.keys(request).length !== 2 ||
          typeof timeoutMs !== 'number' ||
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 120_000 ||
          typeof maxBytes !== 'number' ||
          !Number.isSafeInteger(maxBytes) ||
          maxBytes < 1 ||
          maxBytes > 64 * 1024 * 1024
        ) {
          throw new Error('invalid bounded scope retention');
        }
        scopeRetention = {
          deadline: Date.now() + timeoutMs,
          artifactAllowance: { remainingBytes: maxBytes },
        };
      } else {
        const paths = value;
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
      }
    } catch {
      console.error(
        process.argv[3] === '--scope-retention'
          ? 'invalid bounded scope retention'
          : 'invalid bounded symbols paths',
      );
      process.exit(2);
      return;
    }
  }

  const { initializeWorkspaceParserRuntime, workspaceParserIdentity } =
    await import('./tree-sitter/parser-identity.js');
  await initializeWorkspaceParserRuntime();
  const { runFullAnalysis } = await import('./run-analyze.js');
  await workspaceParserIdentity();
  if (scopeRetention) {
    await runFullAnalysis(repoPath, options, { onProgress() {} }, { scopeRetention });
  } else {
    await runFullAnalysis(repoPath, options, { onProgress() {} });
  }
  process.exit(0);
})().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(workspaceBuildExitCode(error));
});
