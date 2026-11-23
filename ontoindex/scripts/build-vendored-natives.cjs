#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const vendor = path.join(__dirname, '..', 'vendor');

for (const entry of fs.readdirSync(vendor, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(vendor, entry.name);
  if (!fs.existsSync(path.join(dir, 'binding.gyp'))) continue;
  const requirePackage = createRequire(path.join(dir, 'package.json'));
  const rebuildRuntime = process.platform === 'linux' && entry.name === 'tree-sitter';
  const rebuildTypeScript =
    entry.name === 'tree-sitter-typescript' &&
    ((process.platform === 'darwin' && process.arch === 'arm64') ||
      (process.platform === 'linux' && process.arch === 'x64'));
  // The vendored PHP grammar differs from the distributed upstream prebuilds.
  const rebuildPhp = entry.name === 'tree-sitter-php';
  const rebuildRequired = rebuildRuntime || rebuildTypeScript || rebuildPhp;

  if (!rebuildRequired) {
    try {
      requirePackage('node-gyp-build')(dir);
      continue;
    } catch {
      // File dependencies can be linked without running their install scripts.
    }
  }

  try {
    let nodeGyp = process.env.npm_config_node_gyp;
    if (!nodeGyp) {
      try {
        nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
      } catch {
        // npm's lifecycle environment normally supplies its bundled node-gyp.
      }
    }
    const buildDescription = rebuildRuntime
      ? 'Rebuilding required native runtime'
      : rebuildTypeScript
        ? 'Rebuilding required TypeScript parser'
        : 'Building missing native binary';
    console.error(`[${entry.name}] ${buildDescription}`);
    const result = spawnSync(
      nodeGyp ? process.execPath : process.platform === 'win32' ? 'npx.cmd' : 'npx',
      nodeGyp
        ? [nodeGyp, 'rebuild', '--jobs=4']
        : ['--no-install', 'node-gyp', 'rebuild', '--jobs=4'],
      {
        cwd: dir,
        env: { ...process.env, JOBS: '4', npm_config_jobs: '4' },
        stdio: ['ignore', 2, 2],
        shell: !nodeGyp && process.platform === 'win32',
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal) {
      throw new Error(`node-gyp exited with ${result.signal || result.status}`);
    }
    if (rebuildRequired) {
      // A fresh process cannot reuse a previously loaded native module from Node's cache.
      const verification = spawnSync(
        process.execPath,
        [
          '-e',
          `
        const fs = require('node:fs');
        const path = require('node:path');
        const { createRequire } = require('node:module');
        const dir = process.argv[1];
        const dependency = ${JSON.stringify(entry.name)};
        const binding = ${JSON.stringify(
          entry.name === 'tree-sitter'
            ? 'tree_sitter_runtime_binding.node'
            : entry.name === 'tree-sitter-php'
              ? 'tree_sitter_php_binding.node'
              : 'tree_sitter_typescript_binding.node',
        )};
        const prebuildEnv = dependency.toUpperCase().replace(/-/g, '_') + '_PREBUILD';
        const requireApp = createRequire(path.join(dir, '..', '..', 'package.json'));
        const installed = path.dirname(requireApp.resolve(dependency + '/package.json'));
        if (fs.realpathSync(installed) !== fs.realpathSync(dir)) {
          const kind = dependency === 'tree-sitter' ? 'runtime' : 'parser';
          throw new Error('Application ' + dependency + ' must resolve to rebuilt vendor ' + kind + ': ' + dir);
        }
        const requirePackage = createRequire(path.join(dir, 'package.json'));
        const load = requirePackage('node-gyp-build');
        const selected = load.resolve(dir);
        const expected = path.join(dir, 'build', 'Release', binding);
        if (fs.realpathSync(selected) !== fs.realpathSync(expected)) {
          throw new Error(dependency + ' selected ' + selected + ' instead of ' + expected +
            '; unset ' + prebuildEnv + ' and PREBUILDS_ONLY so the rebuilt parser is loaded');
        }
        load(dir);
      `,
          dir,
        ],
        { cwd: dir, env: process.env, stdio: ['ignore', 2, 2] },
      );
      if (verification.error) throw verification.error;
      if (verification.status !== 0 || verification.signal) {
        throw new Error(
          `Runtime verification exited with ${verification.signal || verification.status}`,
        );
      }
    } else {
      requirePackage('node-gyp-build')(dir);
    }
  } catch (err) {
    console.error(`[${entry.name}] Native build failed: ${err.message}`);
    console.error(`Repair manually: cd ${JSON.stringify(dir)} && node-gyp rebuild --jobs=4`);
    if (rebuildRequired) process.exitCode = 1;
  }
}
