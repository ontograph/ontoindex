import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helperDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(helperDir, '..', '..');
const bridgeDbImportUrl = pathToFileURL(path.resolve(repoRoot, 'src/core/group/bridge-db.ts')).href;
const fixturesImportUrl = pathToFileURL(path.resolve(repoRoot, 'test/unit/group/fixtures.ts')).href;

const require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

export function runNativeBridgeScenario(body: string, timeoutMs = 25000): void {
  const successMarker = `__ONTOINDEX_NATIVE_BRIDGE_OK__${Math.random().toString(36).slice(2)}__`;
  const code = `
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const bridge = await import(${JSON.stringify(bridgeDbImportUrl)});
const fixtures = await import(${JSON.stringify(fixturesImportUrl)});
const {
  openBridgeDb,
  ensureBridgeSchema,
  queryBridge,
  closeBridgeDb,
  writeBridge,
  openBridgeDbReadOnly,
  readBridgeMeta,
  bridgeExists,
} = bridge;
const { makeContract } = fixtures;

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-native-child-'));
try {
${body}
} finally {
  await fsp.rm(tmpDir, { recursive: true, force: true });
}
process.stdout.write(${JSON.stringify(`${successMarker}\\n`)}, () => {
  process.reallyExit(0);
});
`;

  const result = spawnSync(
    process.execPath,
    ['--import', tsxImportUrl, '--input-type=module', '-e', code],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        `native bridge scenario exited with ${result.status}`,
        `signal: ${result.signal ?? ''}`,
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`,
      ].join('\n'),
    );
  }
}
