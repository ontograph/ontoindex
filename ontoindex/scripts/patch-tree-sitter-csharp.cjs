#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'tree-sitter-c-sharp',
  'package.json',
);

try {
  if (!fs.existsSync(packageJsonPath)) {
    process.exit(0);
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  let changed = false;

  if (pkg.main === 'bindings/node') {
    pkg.main = 'bindings/node/index.js';
    changed = true;
  }

  if (pkg.types === 'bindings/node') {
    pkg.types = 'bindings/node/index.d.ts';
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log('[tree-sitter-c-sharp] Patched package.json entrypoints');
  }
} catch (err) {
  console.warn('[tree-sitter-c-sharp] Could not patch package.json:', err.message);
  process.exit(0);
}
