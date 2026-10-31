'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const outDir = path.join(root, 'native');
const provenancePath = path.join(outDir, 'build-provenance.json');
const addonPath = path.join(outDir, 'ontoindex_native.node');
const sourcePaths = ['Cargo.toml', 'build.rs', 'scripts/copy-native.cjs', 'src'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sourceDigest() {
  const files = [];
  function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      files.push(relative);
    } else {
      throw new Error('Native source inputs must be regular files or directories');
    }
  }
  for (const relative of sourcePaths) {
    if (relative === 'build.rs' && !fs.existsSync(path.join(root, relative))) continue;
    visit(relative);
  }
  const hash = createHash('sha256');
  for (const relative of files.sort()) {
    const bytes = fs.readFileSync(path.join(root, relative));
    // Frame both path and contents so distinct trees cannot concatenate identically.
    hash.update(`${Buffer.byteLength(relative)}:`).update(relative);
    hash.update(`${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

function metadata(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

// Invalidate old provenance even if Cargo or any input inspection fails.
fs.rmSync(provenancePath, { force: true });
try {
  const nativeSourceSha256 = sourceDigest();
  const cargoLockSha256 = sha256(fs.readFileSync(path.join(root, 'Cargo.lock')));
  const commit = metadata('git', ['rev-parse', 'HEAD']);
  const status = metadata('git', [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    ...sourcePaths,
    'Cargo.lock',
  ]);
  const cargoVersion = metadata('cargo', ['--version']);
  const rustcVersion = metadata('rustc', ['--version', '--verbose']);
  const versionPattern = '[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?';
  const toolchain = {
    cargoVersion:
      cargoVersion?.match(new RegExp(`^cargo (${versionPattern})(?: |$)`))?.[1] || 'unknown',
    rustcVersion:
      rustcVersion?.match(new RegExp(`^release: (${versionPattern})$`, 'm'))?.[1] || 'unknown',
    host: rustcVersion?.match(/^host: ([a-z0-9_]+(?:-[a-z0-9_]+){2,})$/m)?.[1] || 'unknown',
  };
  const output = execFileSync(
    'cargo',
    ['build', '--release', '--message-format=json-render-diagnostics'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (
    sourceDigest() !== nativeSourceSha256 ||
    sha256(fs.readFileSync(path.join(root, 'Cargo.lock'))) !== cargoLockSha256
  ) {
    throw new Error('Native source inputs or Cargo.lock changed during Cargo build');
  }
  const extension =
    process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
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
    throw new Error(
      `Expected one Cargo native artifact, found ${candidates.size}: ${[...candidates].join(', ')}`,
    );
  }
  const [artifact] = candidates;
  if (!fs.statSync(artifact).isFile())
    throw new Error(`Native artifact is not a file: ${artifact}`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(artifact, addonPath);
  fs.writeFileSync(
    provenancePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        source: {
          commit: commit && /^[a-f0-9]{40,64}$/.test(commit) ? commit : 'unknown',
          scopedDirty: status === null ? 'unknown' : status.length > 0,
          nativeSourceSha256,
          cargoLockSha256,
        },
        toolchain,
        effectiveTarget: 'unknown',
        profile: 'release',
        addonSha256: sha256(fs.readFileSync(addonPath)),
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  fs.rmSync(provenancePath, { force: true });
  throw error;
}
