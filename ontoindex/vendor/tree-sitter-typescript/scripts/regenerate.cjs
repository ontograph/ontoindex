const { spawnSync } = require('node:child_process');
const { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

if (process.platform !== 'linux') {
  throw new Error('Grammar regeneration is supported on Linux only.');
}

const root = path.resolve(__dirname, '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'tree-sitter-typescript-'));
const dialects = ['typescript', 'tsx'];
const generatedFiles = [
  'parser.c',
  'grammar.json',
  'node-types.json',
  'tree_sitter/alloc.h',
  'tree_sitter/array.h',
  'tree_sitter/parser.h',
];

function npm(args, cwd) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm failed (${result.signal || result.status}).`);
  }
}

try {
  writeFileSync(path.join(temporary, 'package.json'), '{"private":true}\n');
  cpSync(path.join(root, 'common'), path.join(temporary, 'common'), { recursive: true });
  copyFileSync(path.join(root, 'tree-sitter.json'), path.join(temporary, 'tree-sitter.json'));
  for (const dialect of dialects) {
    const directory = path.join(temporary, dialect);
    mkdirSync(path.join(directory, 'src'), { recursive: true });
    copyFileSync(path.join(root, dialect, 'grammar.js'), path.join(directory, 'grammar.js'));
    copyFileSync(path.join(root, dialect, 'src/scanner.c'), path.join(directory, 'src/scanner.c'));
  }

  npm([
    'install', '--prefix', temporary, '--ignore-scripts', '--no-package-lock',
    '--no-audit', '--no-fund', 'tree-sitter-javascript@0.23.1',
  ], temporary);
  for (const dialect of dialects) {
    npm([
      'exec', '--yes', '--package=tree-sitter-cli@0.24.7', '--',
      'tree-sitter', 'generate', '--abi', '14',
    ], path.join(temporary, dialect));
  }

  for (const dialect of dialects) {
    for (const file of generatedFiles) {
      const destination = path.join(root, dialect, 'src', file);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(temporary, dialect, 'src', file), destination);
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
