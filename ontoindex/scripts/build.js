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
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHARED_ROOT = path.resolve(ROOT, '..', 'ontoindex-shared');
const DIST = path.join(ROOT, 'dist');
const SHARED_DEST = path.join(DIST, '_shared');
const DIST_SUPER_DISPATCH = path.join(DIST, 'mcp', 'super', 'dispatch.js');
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

walk(DIST, ['.js', '.d.ts'], rewriteFile);

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
