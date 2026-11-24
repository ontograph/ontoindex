#!/usr/bin/env node
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const RUNTIME_ROOT = path.join(VENDOR, 'tree-sitter');
const PHP_ROOT = path.join(VENDOR, 'tree-sitter-php');
const TARGETS = [
  { key: 'darwin-arm64', platform: 'darwin', arch: 'arm64', bun: 'bun-darwin-arm64' },
  { key: 'darwin-x64', platform: 'darwin', arch: 'x64', bun: 'bun-darwin-x64' },
  { key: 'linux-arm64', platform: 'linux', arch: 'arm64', bun: 'bun-linux-arm64' },
  { key: 'linux-x64', platform: 'linux', arch: 'x64', bun: 'bun-linux-x64' },
  { key: 'win32-arm64', platform: 'win32', arch: 'arm64', bun: 'bun-windows-arm64' },
  { key: 'win32-x64', platform: 'win32', arch: 'x64', bun: 'bun-windows-x64' },
];
const PHP_CASES = [
  { grammar: 'php', name: 'php-open-tag-echo', source: '<?php echo "hello";' },
  {
    grammar: 'php',
    name: 'php-typed-function',
    source: '<?php function answer(): int { return 42; }',
  },
  {
    grammar: 'php',
    name: 'php-class-method',
    source: '<?php class Box { public function get(): string { return "x"; } }',
  },
  {
    grammar: 'php',
    name: 'php-namespace-import',
    source: '<?php namespace App; use Vendor\\Thing; $value = new Thing();',
  },
  { grammar: 'php_only', name: 'php-only-echo', source: 'echo "hello";' },
  {
    grammar: 'php_only',
    name: 'php-only-typed-function',
    source: 'function answer(): int { return 42; }',
  },
  {
    grammar: 'php_only',
    name: 'php-only-class-method',
    source: 'class Box { public function get(): string { return "x"; } }',
  },
  {
    grammar: 'php_only',
    name: 'php-only-namespace-import',
    source: 'namespace App; use Vendor\\Thing; $value = new Thing();',
  },
];

function usage() {
  console.log(`Usage: node scripts/build-bun-prebuild.cjs [options]

Build both native addons for the current host, verify them with Node and Bun,
then compile and run a Bun executable against eight PHP parser cases.

Options:
  --target <target>        Bun target (default: current host)
  --no-build               Use prebuilt files already under --prebuild-root
  --prebuild-root <dir>    Root for paired native prebuilds (default: vendor)
  --out <file>             Keep the compiled smoke executable at this path
  --help                   Show this help

Native compilation must run on the matching target host. Cross-target Bun
compilation works with --no-build after the target's paired prebuilds exist.
`);
}

function parseArgs(args) {
  const options = {
    target: null,
    noBuild: false,
    prebuildRoot: VENDOR,
    output: null,
    help: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--no-build') {
      options.noBuild = true;
    } else if (['--target', '--prebuild-root', '--out'].includes(arg)) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--target') options.target = value;
      else if (arg === '--prebuild-root') options.prebuildRoot = value;
      else options.output = value;
    } else if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length);
    } else if (arg.startsWith('--prebuild-root=')) {
      options.prebuildRoot = arg.slice('--prebuild-root='.length);
    } else if (arg.startsWith('--out=')) {
      options.output = arg.slice('--out='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function resolveTarget(value) {
  if (value) {
    const target = TARGETS.find((candidate) => candidate.bun === value || candidate.key === value);
    if (!target) {
      throw new Error(
        `Unsupported target ${value}. Supported: ${TARGETS.map((item) => item.bun).join(', ')}`,
      );
    }
    return target;
  }

  const host = TARGETS.find(
    (candidate) => candidate.platform === process.platform && candidate.arch === process.arch,
  );
  if (!host) throw new Error(`Unsupported build host ${process.platform}-${process.arch}`);
  return host;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    throw new Error(`${command} exited with ${result.signal || result.status}`);
  }
}

function requireFile(file, description) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${description} is missing: ${file}`);
  }
}

function resolveBunBinary() {
  if (process.env.BUN_BINARY) {
    requireFile(process.env.BUN_BINARY, 'BUN_BINARY');
    return process.env.BUN_BINARY;
  }

  const executableNames = process.platform === 'win32' ? ['bun.exe'] : ['bun', 'bun.exe'];
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (!entry) continue;
    const candidates = executableNames.map((name) => path.join(entry, name));
    candidates.push(path.resolve(entry, '..', 'bun', 'bin', 'bun.exe'));
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  throw new Error('Bun executable not found. Put bun on PATH or set BUN_BINARY to its executable path.');
}

function prebuildPaths(root, target) {
  return {
    runtime: path.join(root, 'tree-sitter', 'prebuilds', target.key, 'tree-sitter.node'),
    php: path.join(root, 'tree-sitter-php', 'prebuilds', target.key, 'tree-sitter-php.node'),
  };
}

function buildAddon(packageRoot, addonName, targetPath) {
  const nodeGyp = path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  requireFile(nodeGyp, 'node-gyp');
  run(process.execPath, [nodeGyp, 'rebuild', '--jobs=4'], {
    cwd: packageRoot,
    env: { ...process.env, JOBS: '4', npm_config_jobs: '4' },
  });

  const builtBinary = path.join(packageRoot, 'build', 'Release', addonName);
  requireFile(builtBinary, `Built native addon ${addonName}`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(builtBinary, targetPath);
  console.log(`[prebuild] wrote ${targetPath}`);
}

function assertNodeBuildSelected(packageRoot, addonName) {
  const requirePackage = createRequire(path.join(packageRoot, 'package.json'));
  const selected = requirePackage('node-gyp-build').resolve(packageRoot);
  const expected = path.join(packageRoot, 'build', 'Release', addonName);
  if (fs.realpathSync(selected) !== fs.realpathSync(expected)) {
    throw new Error(
      `Node selected ${selected} instead of the fresh build ${expected}; unset ` +
        'the package PREBUILD variable and PREBUILDS_ONLY before running this workflow.',
    );
  }
}

function smokeSource(runtimeSpecifier, phpSpecifier) {
  return `const Parser = require(${JSON.stringify(runtimeSpecifier)});
const PHP = require(${JSON.stringify(phpSpecifier)});
const cases = ${JSON.stringify(PHP_CASES)};
const parser = new Parser();
for (const testCase of cases) {
  parser.setLanguage(PHP[testCase.grammar]);
  const tree = parser.parse(testCase.source);
  if (tree.rootNode.type !== 'program' || tree.rootNode.hasError) {
    throw new Error(testCase.name + ' failed: ' + tree.rootNode.toString());
  }
  console.log('PASS ' + testCase.name);
}
if (cases.length !== 8) throw new Error('Expected eight PHP cases');
console.log('NATIVE_PARSER_SMOKE_OK');
`;
}

function runNodeSmoke(tempRoot) {
  try {
    const sourcePath = path.join(tempRoot, 'node-smoke.cjs');
    fs.writeFileSync(sourcePath, smokeSource(RUNTIME_ROOT, PHP_ROOT));
    run(process.execPath, [sourcePath], { cwd: ROOT });
    console.log('[prebuild] Node native-addon smoke passed for eight PHP cases');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runBunSmoke(target, paths, outputPath, keepOutput) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-bun-prebuild-'));
  try {
    const stagedRuntime = path.join(tempRoot, 'vendor', 'tree-sitter');
    const stagedPhp = path.join(tempRoot, 'vendor', 'tree-sitter-php');
    fs.cpSync(RUNTIME_ROOT, stagedRuntime, { recursive: true });
    fs.cpSync(PHP_ROOT, stagedPhp, { recursive: true });
    fs.rmSync(path.join(stagedRuntime, 'build'), { recursive: true, force: true });
    fs.rmSync(path.join(stagedPhp, 'build'), { recursive: true, force: true });

    const stagedRuntimePrebuild = path.join(
      stagedRuntime,
      'prebuilds',
      target.key,
      'tree-sitter.node',
    );
    const stagedPhpPrebuild = path.join(stagedPhp, 'prebuilds', target.key, 'tree-sitter-php.node');
    fs.mkdirSync(path.dirname(stagedRuntimePrebuild), { recursive: true });
    fs.mkdirSync(path.dirname(stagedPhpPrebuild), { recursive: true });
    fs.copyFileSync(paths.runtime, stagedRuntimePrebuild);
    fs.copyFileSync(paths.php, stagedPhpPrebuild);

    const smokePath = path.join(tempRoot, 'bun-smoke.cjs');
    fs.writeFileSync(smokePath, smokeSource('./vendor/tree-sitter', './vendor/tree-sitter-php'));
    const compiledPath = outputPath
      ? path.resolve(ROOT, outputPath)
      : path.join(tempRoot, target.platform === 'win32' ? 'smoke.exe' : 'smoke');
    fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
    const bun = resolveBunBinary();
    const isHostTarget = target.platform === process.platform && target.arch === process.arch;
    if (isHostTarget) {
      run(bun, [smokePath], { cwd: tempRoot });
      console.log(`[prebuild] Bun runtime smoke passed for ${target.key}`);
    }
    run(bun, [
      'build',
      '--compile',
      `--target=${target.bun}`,
      '--outfile',
      compiledPath,
      smokePath,
    ]);

    if (isHostTarget) {
      run(compiledPath, [], { cwd: tempRoot });
      console.log(`[prebuild] Bun compiled smoke passed for ${target.key}`);
    } else {
      console.log(`[prebuild] Bun cross-target compile passed for ${target.key}; executable not run`);
    }
    if (keepOutput) console.log(`[prebuild] compiled smoke executable: ${compiledPath}`);
  } finally {
    if (!keepOutput) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }

  const target = resolveTarget(options.target);
  const isHostTarget = target.platform === process.platform && target.arch === process.arch;
  const prebuildRoot = path.resolve(ROOT, options.prebuildRoot);
  const paths = prebuildPaths(prebuildRoot, target);

  if (isHostTarget && !options.noBuild) {
    buildAddon(RUNTIME_ROOT, 'tree_sitter_runtime_binding.node', paths.runtime);
    buildAddon(PHP_ROOT, 'tree_sitter_php_binding.node', paths.php);
    assertNodeBuildSelected(RUNTIME_ROOT, 'tree_sitter_runtime_binding.node');
    assertNodeBuildSelected(PHP_ROOT, 'tree_sitter_php_binding.node');
    runNodeSmoke(fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-node-smoke-')));
  } else if (!isHostTarget && !options.noBuild) {
    throw new Error(
      `Cannot build ${target.key} on ${process.platform}-${process.arch}. ` +
        'Run on the target host or use --no-build with existing prebuilds.',
    );
  }

  requireFile(paths.runtime, `tree-sitter runtime prebuild for ${target.key}`);
  requireFile(paths.php, `PHP prebuild for ${target.key}`);
  runBunSmoke(target, paths, options.output, Boolean(options.output));
} catch (error) {
  console.error(`[prebuild] ${error.message}`);
  process.exitCode = 1;
}
