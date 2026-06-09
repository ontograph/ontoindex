import ignore, { type Ignore } from 'ignore';
import fs from 'fs/promises';
import nodePath from 'path';
import type { Path } from 'path-scurry';

const DEFAULT_IGNORE_LIST = new Set([
  // Version Control
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.ontoindex',

  // IDEs & Editors
  '.idea',
  '.vscode',
  '.vs',
  '.eclipse',
  '.settings',
  '.DS_Store',
  'Thumbs.db',

  // Dependencies
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor', // PHP/Go
  // 'packages' removed - commonly used for monorepo source code (lerna, pnpm, yarn workspaces)
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'site-packages',
  '.tox',
  'eggs',
  '.eggs',
  'lib64',
  'parts',
  'sdist',
  'wheels',

  // Build Outputs
  'dist',
  'build',
  'out',
  'output',
  'bin',
  'obj',
  'target', // Java/Rust
  '.next',
  '.nuxt',
  '.output',
  '.vercel',
  '.netlify',
  '.serverless',
  '_build',
  'public/build',
  '.parcel-cache',
  '.turbo',
  '.svelte-kit',

  // Test & Coverage
  'coverage',
  '.nyc_output',
  'htmlcov',
  '.coverage',
  '__tests__', // Often just test files
  '__mocks__',
  '.jest',

  // Logs & Temp
  'logs',
  'log',
  'tmp',
  'temp',
  'cache',
  '.cache',
  '.tmp',
  '.temp',

  // Generated/Compiled
  '.generated',
  'generated',
  'auto-generated',
  '.terraform',
  '.serverless',

  // Documentation (optional - might want to keep)
  // 'docs',
  // 'documentation',

  // Misc
  '.husky',
  '.github', // GitHub config, not code
  '.circleci',
  '.gitlab',
  'fixtures', // Test fixtures
  'snapshots', // Jest snapshots
  '__snapshots__',
]);

// Some very large repositories vendor generated C/C++ dependency trees under
// project-specific names instead of conventional vendor/third_party folders.
// These dominate parse CPU and usually drown out first-party code signals.
const THIRD_PARTY_GENERATED_DIR_NAMES = new Set([
  'biff12_records',
  'biff12_unions',
  'cximage',
  'freetype_names',
  'libpsd',
  'libxml2',
  'onlyoffice.github.io',
  'sdkjs-plugins',
]);

const THIRD_PARTY_GENERATED_DIR_PATTERNS = [
  /^freetype[-_]\d[\w.-]*$/,
  /^agg[-_]\d[\w.-]*$/,
] as const;

const THIRD_PARTY_GENERATED_PATH_PATTERNS = [
  /(?:^|\/)desktop-sdk\/chromiumbasededitors\/plugins\/ai-agent\/deploy(?:\/|$)/,
] as const;

const IGNORED_EXTENSIONS = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.psd',
  '.ai',
  '.sketch',
  '.fig',
  '.xd',

  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  '.tgz',

  // Binary/Compiled
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.a',
  '.lib',
  '.o',
  '.obj',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.pyc',
  '.pyo',
  '.pyd',
  '.beam', // Erlang
  '.wasm', // WebAssembly - important!
  '.node', // Native Node addons

  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',

  // Media
  '.mp4',
  '.mp3',
  '.wav',
  '.mov',
  '.avi',
  '.mkv',
  '.flv',
  '.wmv',
  '.ogg',
  '.webm',
  '.flac',
  '.aac',
  '.m4a',

  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',

  // Databases
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  '.accdb',

  // Minified/Bundled files
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.chunk.js',

  // Source maps (debug files, not source)
  '.map',

  // Lock files (handled separately, but also here)
  '.lock',

  // Certificates & Keys (security - don't index!)
  '.pem',
  '.key',
  '.crt',
  '.cer',
  '.p12',
  '.pfx',

  // Data files (often large/binary)
  '.csv',
  '.tsv',
  '.parquet',
  '.avro',
  '.feather',
  '.npy',
  '.npz',
  '.pkl',
  '.pickle',
  '.h5',
  '.hdf5',

  // Misc binary
  '.bin',
  '.dat',
  '.data',
  '.raw',
  '.iso',
  '.img',
  '.dmg',
]);

const includeThirdPartyGeneratedCode = (): boolean =>
  process.env.ONTOINDEX_INCLUDE_THIRD_PARTY === '1';

const isThirdPartyGeneratedDirectory = (name: string): boolean => {
  if (includeThirdPartyGeneratedCode()) return false;

  const normalizedName = name.toLowerCase();
  if (THIRD_PARTY_GENERATED_DIR_NAMES.has(normalizedName)) return true;

  return THIRD_PARTY_GENERATED_DIR_PATTERNS.some((pattern) => pattern.test(normalizedName));
};

const isThirdPartyGeneratedPath = (filePath: string): boolean => {
  if (includeThirdPartyGeneratedCode()) return false;

  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  return THIRD_PARTY_GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));
};

const shouldIgnoreDirectoryName = (name: string): boolean => {
  return DEFAULT_IGNORE_LIST.has(name) || isThirdPartyGeneratedDirectory(name);
};

// Files to ignore by exact name
const IGNORED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  '.gitignore',
  '.ontoindexignore',
  '.gitattributes',
  '.npmrc',
  '.yarnrc',
  '.editorconfig',
  '.prettierrc',
  '.prettierignore',
  '.eslintignore',
  '.dockerignore',
  'Thumbs.db',
  '.DS_Store',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'CHANGELOG.md',
  'CHANGELOG',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.example',
]);

// NOTE: Negation patterns in .ontoindexignore (e.g. `!vendor/`) cannot override
// entries in DEFAULT_IGNORE_LIST — this is intentional. The hardcoded list protects
// against indexing directories that are almost never source code (node_modules, .git, etc.).
// Users who need to include such directories should remove them from the hardcoded list.
export const shouldIgnorePath = (filePath: string): boolean => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  const fileName = parts[parts.length - 1];
  const fileNameLower = fileName.toLowerCase();

  // Check if any path segment is in ignore list
  for (const part of parts) {
    if (shouldIgnoreDirectoryName(part)) {
      return true;
    }
  }

  if (isThirdPartyGeneratedPath(normalizedPath)) {
    return true;
  }

  // Check exact filename matches
  if (IGNORED_FILES.has(fileName) || IGNORED_FILES.has(fileNameLower)) {
    return true;
  }

  // Check extension
  const lastDotIndex = fileNameLower.lastIndexOf('.');
  if (lastDotIndex !== -1) {
    const ext = fileNameLower.substring(lastDotIndex);
    if (IGNORED_EXTENSIONS.has(ext)) return true;

    // Handle compound extensions like .min.js, .bundle.js
    const secondLastDot = fileNameLower.lastIndexOf('.', lastDotIndex - 1);
    if (secondLastDot !== -1) {
      const compoundExt = fileNameLower.substring(secondLastDot);
      if (IGNORED_EXTENSIONS.has(compoundExt)) return true;
    }
  }

  // Ignore hidden files (starting with .)
  if (fileName.startsWith('.') && fileName !== '.') {
    // But allow some important config files
    const allowedDotFiles = ['.env', '.gitignore']; // Already in IGNORED_FILES, so this is redundant
    // Actually, let's NOT ignore all dot files - many are important configs
    // Just rely on the explicit lists above
  }

  // Ignore files that look like generated/bundled code
  if (
    fileNameLower.includes('.bundle.') ||
    fileNameLower.includes('.chunk.') ||
    fileNameLower.includes('.generated.') ||
    fileNameLower.endsWith('_pack.js') ||
    fileNameLower.endsWith('.d.ts')
  ) {
    // TypeScript declaration files
    return true;
  }

  return false;
};

/** Check if a directory name is in the hardcoded ignore list */
export const isHardcodedIgnoredDirectory = (name: string): boolean => {
  return shouldIgnoreDirectoryName(name);
};

/**
 * Load .gitignore and .ontoindexignore rules from the repo root.
 * Returns an `ignore` instance with all patterns, or null if no files found.
 */
interface IgnoreOptions {
  /** Skip .gitignore parsing, only read .ontoindexignore. Defaults to ONTOINDEX_NO_GITIGNORE env var. */
  noGitignore?: boolean;
}

export const loadIgnoreRules = async (
  repoPath: string,
  options?: IgnoreOptions,
): Promise<Ignore | null> => {
  const ig = ignore();
  let hasRules = false;

  // Allow users to bypass .gitignore parsing (e.g. when .gitignore accidentally excludes source files)
  const skipGitignore = options?.noGitignore ?? !!process.env.ONTOINDEX_NO_GITIGNORE;
  const filenames = skipGitignore ? ['.ontoindexignore'] : ['.gitignore', '.ontoindexignore'];

  for (const filename of filenames) {
    try {
      const content = await fs.readFile(nodePath.join(repoPath, filename), 'utf-8');
      ig.add(content);
      hasRules = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`  Warning: could not read ${filename}: ${(err as Error).message}`);
      }
    }
  }

  return hasRules ? ig : null;
};

/**
 * Create a glob-compatible ignore filter combining:
 * - .gitignore / .ontoindexignore patterns (via `ignore` package)
 * - Hardcoded DEFAULT_IGNORE_LIST, IGNORED_EXTENSIONS, IGNORED_FILES
 *
 * Returns an IgnoreLike object for glob's `ignore` option,
 * enabling directory-level pruning during traversal.
 */
export const createIgnoreFilter = async (repoPath: string, options?: IgnoreOptions) => {
  const ig = await loadIgnoreRules(repoPath, options);

  return {
    ignored(p: Path): boolean {
      // path-scurry's Path.relative() returns POSIX paths on all platforms,
      // which is what the `ignore` package expects. No explicit normalization needed.
      const rel = p.relative();
      if (!rel) return false;
      // Check .gitignore / .ontoindexignore patterns
      if (ig && ig.ignores(rel)) return true;
      // Fall back to hardcoded rules
      return shouldIgnorePath(rel);
    },
    childrenIgnored(p: Path): boolean {
      // Fast path: check directory name against hardcoded list. The walker
      // enables dot-directory traversal so docs folders like `.memory-bank/`
      // can be indexed; operational dot-dirs must stay listed here.
      if (shouldIgnoreDirectoryName(p.name)) return true;
      if (isThirdPartyGeneratedPath(p.relative())) return true;
      // Check against .gitignore / .ontoindexignore patterns.
      // Since childrenIgnored is only called for directories, always test with
      // a trailing slash. This ensures directory-only negation patterns (e.g.
      // `!iOS/`) are applied correctly — without the slash, `ig.ignores('iOS')`
      // treats the path as a file and misses the negation.
      // Bare-name patterns (e.g. `local`) still match `local/` per gitignore spec:
      // the `ignore` package normalizes `dir` and `dir/` to match directories.
      // See: https://github.com/kaelzhang/node-ignore#2-filenames-and-dirnames
      if (ig) {
        const rel = p.relative();
        if (rel && ig.ignores(rel + '/')) return true;
      }
      return false;
    },
  };
};
