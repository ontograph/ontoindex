'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const outDir = path.join(root, 'native');
const output = execFileSync('cargo', ['build', '--release', '--message-format=json-render-diagnostics'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 16 * 1024 * 1024,
});
const extension = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
const candidates = new Set();
for (const line of output.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (
    message.reason === 'compiler-artifact' &&
    message.manifest_path === path.join(root, 'Cargo.toml') &&
    message.target?.name === 'ontoindex_native' &&
    message.target.crate_types?.includes('cdylib')
  ) {
    for (const filename of message.filenames || []) {
      if (path.extname(filename) === extension) candidates.add(filename);
    }
  }
}

if (candidates.size !== 1) {
  throw new Error(`Expected one Cargo native artifact, found ${candidates.size}: ${[...candidates].join(', ')}`);
}
const [artifact] = candidates;
if (!fs.statSync(artifact).isFile()) throw new Error(`Native artifact is not a file: ${artifact}`);

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(artifact, path.join(outDir, 'ontoindex_native.node'));
