'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targetDir = path.join(root, 'target', 'release');
const outDir = path.join(root, 'native');
const candidates = [
  path.join(targetDir, 'libontoindex_native.so'),
  path.join(targetDir, 'libontoindex_native.dylib'),
  path.join(targetDir, 'ontoindex_native.dll'),
];
const artifact = candidates.find((candidate) => fs.existsSync(candidate));

if (!artifact) {
  throw new Error(`Native artifact not found. Checked: ${candidates.join(', ')}`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(artifact, path.join(outDir, 'ontoindex_native.node'));
