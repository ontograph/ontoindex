#!/usr/bin/env node
/**
 * Build script that compiles ontoindex and inlines ontoindex-shared into the dist.
 *
 * Steps:
 *  1. Build ontoindex-shared (tsc)
 *  2. Build ontoindex (tsc)
 *  3. Copy ontoindex-shared/dist to dist/_shared
 *  4. Rewrite bare 'ontoindex-shared' specifiers to relative paths
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLadybugExtensions, verifyLadybugExtensions } from './ladybug-extensions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHARED_ROOT = path.resolve(ROOT, '..', 'ontoindex-shared');
const DIST = path.join(ROOT, 'dist');
const SHARED_DEST = path.join(DIST, '_shared');
const DIST_SUPER_DISPATCH = path.join(DIST, 'mcp', 'super', 'dispatch.js');
const LADYBUG_EXTENSIONS_VERSION = 'v0.17.0';
const NATIVE_ROOT = path.resolve(ROOT, '..', 'ontoindex-native');
const NATIVE_ARTIFACTS = ['index.cjs', 'native.cjs', 'native/ontoindex_native.node'];
if (process.platform === 'linux') {
  console.log('[build] compiling ontoindex-native...');
  execFileSync('npm', ['run', 'build'], {
    cwd: NATIVE_ROOT,
    stdio: 'inherit',
    env: { ...process.env, CARGO_BUILD_JOBS: '4' },
  });
}
for (const artifact of NATIVE_ARTIFACTS) {
  const source = path.join(NATIVE_ROOT, artifact);
  if (!fs.statSync(source).isFile()) {
    throw new Error(`Missing native build artifact: ${source}`);
  }
}
fs.rmSync(DIST, { recursive: true, force: true });
fs.rmSync(path.join(ROOT, 'tsconfig.tsbuildinfo'), { force: true });
fs.rmSync(path.join(SHARED_ROOT, 'dist'), { recursive: true, force: true });
fs.rmSync(path.join(SHARED_ROOT, 'tsconfig.tsbuildinfo'), { force: true });

// ── 1. Build ontoindex-shared ───────────────────────────────────────
console.log('[build] compiling ontoindex-shared...');
execSync('npx tsc', { cwd: SHARED_ROOT, stdio: 'inherit' });

// ── 2. Build ontoindex ──────────────────────────────────────────────
console.log('[build] compiling ontoindex...');
execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });

console.log('[build] copying native addon into dist/native/addon...');
for (const artifact of NATIVE_ARTIFACTS) {
  const dest = path.join(DIST, 'native', 'addon', artifact);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(NATIVE_ROOT, artifact), dest);
}

// ── 3. Copy shared dist ────────────────────────────────────────────
console.log('[build] copying shared module into dist/_shared...');
fs.cpSync(path.join(SHARED_ROOT, 'dist'), SHARED_DEST, { recursive: true });

// ── 4. Rewrite imports ─────────────────────────────────────────────
console.log('[build] rewriting ontoindex-shared imports...');
let rewritten = 0;

function rewriteFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.includes('ontoindex-shared')) return;

  const relDir = path.relative(path.dirname(filePath), SHARED_DEST);
  // Always use posix separators and point to the package index
  const relImport = relDir.split(path.sep).join('/') + '/index.js';

  const updated = content
    .replace(/from\s+['"]ontoindex-shared['"]/g, `from '${relImport}'`)
    .replace(/import\(\s*['"]ontoindex-shared['"]\s*\)/g, `import('${relImport}')`);

  if (updated !== content) {
    fs.writeFileSync(filePath, updated);
    rewritten++;
  }
}

function walk(dir, extensions, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, extensions, cb);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      cb(full);
    }
  }
}

function currentLbugExtensionPlatformDir() {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  if (process.platform === 'linux' || process.platform === 'win32') {
    return `${process.platform}_${arch}`;
  }
  return null;
}

function defaultLbugExtensionsBaseDir() {
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, 'ontoindex', 'ladybugdb-extensions');
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'ontoindex', 'ladybugdb-extensions');
  }
  return path.join(process.env.HOME || '', '.cache', 'ontoindex', 'ladybugdb-extensions');
}

function resolveLadybugExtensionSourceDir() {
  const platformDir = currentLbugExtensionPlatformDir();
  if (!platformDir) return null;

  const defaultCache = path.join(
    defaultLbugExtensionsBaseDir(),
    LADYBUG_EXTENSIONS_VERSION,
    platformDir,
  );
  const dirs = [
    process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR,
    process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE,
    defaultCache,
  ].filter(Boolean);

  for (const dir of dirs) {
    if (
      fs.existsSync(path.join(dir, 'libfts.lbug_extension')) &&
      fs.existsSync(path.join(dir, 'libvector.lbug_extension'))
    ) {
      return { dir, platformDir };
    }
  }

  return null;
}

async function fetchMissingLadybugExtensions() {
  if (process.env.ONTOINDEX_SKIP_EXT_FETCH === '1') return;
  const platformDir = currentLbugExtensionPlatformDir();
  if (!platformDir) return;
  const pins = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'ladybug-extension-pins.json'), 'utf-8'),
  );
  const dir =
    process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR ||
    process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE ||
    path.join(defaultLbugExtensionsBaseDir(), LADYBUG_EXTENSIONS_VERSION, platformDir);
  const result = await ensureLadybugExtensions({
    dir,
    version: LADYBUG_EXTENSIONS_VERSION,
    platformDir,
    pins,
  });
  if (!result.ok) {
    console.log(
      `[build] LadybugDB extensions not fetched (${result.missing.join(', ')}); continuing.`,
    );
  }
}

function copyBundledLadybugExtensions() {
  const source = resolveLadybugExtensionSourceDir();
  if (!source) {
    console.log('[build] skipping bundled LadybugDB extensions (cache not found).');
    return;
  }

  const destDir = path.join(
    DIST,
    'ladybugdb-extensions',
    LADYBUG_EXTENSIONS_VERSION,
    source.platformDir,
  );
  fs.mkdirSync(destDir, { recursive: true });
  verifyLadybugExtensions({
    dir: source.dir,
    version: LADYBUG_EXTENSIONS_VERSION,
    platformDir: source.platformDir,
    pins: JSON.parse(fs.readFileSync(path.join(__dirname, 'ladybug-extension-pins.json'), 'utf-8')),
  });
  for (const file of ['libfts.lbug_extension', 'libvector.lbug_extension']) {
    fs.copyFileSync(path.join(source.dir, file), path.join(destDir, file));
  }
  console.log(`[build] bundled LadybugDB extensions from ${source.dir}`);
}

walk(DIST, ['.js', '.d.ts'], rewriteFile);
await fetchMissingLadybugExtensions();
copyBundledLadybugExtensions();

// ── 5. Make CLI entry executable ────────────────────────────────────
const cliEntry = path.join(DIST, 'cli', 'index.js');
if (fs.existsSync(cliEntry)) fs.chmodSync(cliEntry, 0o755);
validateSuperDispatchArtifacts(DIST_SUPER_DISPATCH);

console.log(`[build] done - rewrote ${rewritten} files.`);

/**
 * Sanity-check that every super-function dispatch case can resolve its
 * implementation file in dist.
 */
function validateSuperDispatchArtifacts(dispatchPath) {
  if (!fs.existsSync(dispatchPath)) {
    throw new Error(`Cannot validate super dispatch artifacts: missing ${dispatchPath}`);
  }

  const dispatchSource = fs.readFileSync(dispatchPath, 'utf-8');
  const caseImportPattern =
    /case\s+(?:'([^']+)'|"([^\"]+)")\s*:\s*\{[\s\S]*?import\(\s*(?:'([^']+\.js)'|"([^"]+\.js)")\s*\)/g;

  const missing = [];
  const seenTools = new Set();
  for (const match of dispatchSource.matchAll(caseImportPattern)) {
    const tool = match[1] ?? match[2];
    const moduleSpecifier = match[3] ?? match[4];
    if (!tool || !moduleSpecifier) continue;

    seenTools.add(tool);
    const resolvedModule = path.join(path.dirname(dispatchPath), moduleSpecifier);
    if (!fs.existsSync(resolvedModule)) {
      missing.push(`${tool}->${moduleSpecifier}`);
    }
  }

  if (seenTools.size === 0) {
    throw new Error(
      'Validation failed: no super dispatch import cases found in dist/mcp/super/dispatch.js',
    );
  }

  if (missing.length > 0) {
    throw new Error(`Missing dist super-module artifacts: ${missing.join(', ')}`);
  }
}
