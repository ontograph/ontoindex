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

  try {
    requirePackage('node-gyp-build')(dir);
    continue;
  } catch {
    // File dependencies can be linked without running their install scripts.
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
    console.error(`[${entry.name}] Building missing native binary`);
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
    if (result.status !== 0) {
      throw new Error(`node-gyp exited with ${result.status ?? result.signal}`);
    }
    requirePackage('node-gyp-build')(dir);
  } catch (err) {
    console.error(`[${entry.name}] Native build failed: ${err.message}`);
    console.error(`Repair manually: cd ${JSON.stringify(dir)} && node-gyp rebuild --jobs=4`);
    if (entry.name === 'tree-sitter') process.exitCode = 1;
  }
}
