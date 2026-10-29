import { minimatch } from 'minimatch';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import type { Dirent } from 'fs';
import type { ImportConfigs } from './import-resolvers/types.js';
import {
  isCargoInventoryPath,
  rustCargoTargets,
  rustCargoPackageWorkspace,
  rustWorkspacePackageEdition,
} from './import-resolvers/rust-cargo.js';

import { isDev } from './utils/env.js';

// ============================================================================
// LANGUAGE-SPECIFIC CONFIG TYPES
// ============================================================================

type ObservationStatus = 'present' | 'absent' | 'failed';
type ObservedEntry = Readonly<{ name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }>;
export type ImportConfigObservation =
  | Readonly<{
      kind: 'file';
      path: string;
      status: ObservationStatus;
      sha256?: string;
      byteLength?: number;
      errorCode?: string;
    }>
  | Readonly<{ kind: 'parse-error'; path: string }>
  | Readonly<{
      kind: 'directory';
      path: string;
      status: ObservationStatus;
      entries?: readonly ObservedEntry[];
      errorCode?: string;
    }>
  | Readonly<{
      kind: 'traversal';
      path: '.';
      maxDepth: 5;
      maxDirs: 100;
      dirsScanned: number;
      depthLimited: boolean;
      directoryLimited: boolean;
    }>;

/** Evidence of loader reads, not an atomic filesystem snapshot or replay identity. */
export interface ImportConfigObservations {
  readonly version: 1;
  readonly complete: boolean;
  readonly digest: string | null;
  readonly records: readonly ImportConfigObservation[];
  readonly issues: readonly string[];
}

/** Bounds apply only to retained observation metadata, not existing loader reads. */
class ConfigObservationRecorder {
  private readonly records: ImportConfigObservation[] = [];
  private readonly issues = new Set<string>();
  private bytes = 0;
  private directoryEntries = 0;
  constructor(private readonly repoRoot: string) {}

  relative(filename: string): string {
    return path.relative(this.repoRoot, filename).replace(/\\/g, '/') || '.';
  }

  incomplete(issue: string): void {
    this.issues.add(issue);
  }

  private room(minimumBytes: number): boolean {
    if (this.records.length >= 4096) {
      this.incomplete('capture-record-limit');
      return false;
    }
    if (this.bytes + minimumBytes > 1024 * 1024) {
      this.incomplete('capture-byte-limit');
      return false;
    }
    return true;
  }

  add(record: ImportConfigObservation): void {
    // JSON escaping can expand one input byte to six output bytes.
    if (!this.room(Buffer.byteLength(record.path) * 6 + 128)) return;
    const size = Buffer.byteLength(JSON.stringify(record));
    if (!this.room(size)) return;
    this.bytes += size;
    this.records.push(Object.freeze(record));
  }

  failure(kind: 'file' | 'directory', filename: string, error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code;
    const errorCode =
      typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'UNKNOWN';
    const status = errorCode === 'ENOENT' ? 'absent' : 'failed';
    if (status === 'failed') this.incomplete('read-failed');
    this.add({ kind, path: this.relative(filename), status, errorCode });
  }

  parseError(filename: string): void {
    this.incomplete('parse-error');
    this.add({ kind: 'parse-error', path: this.relative(filename) });
  }

  directory(filename: string, entries: Dirent[]): void {
    const relativePath = this.relative(filename);
    const pathBudget = Buffer.byteLength(relativePath) * 6 + 128;
    if (!this.room(pathBudget)) return;
    const captured: ObservedEntry[] = [];
    let entryBytes = 0;
    for (const entry of entries) {
      if (this.directoryEntries >= 10000) {
        this.incomplete('capture-directory-entry-limit');
        break;
      }
      // Check raw name size before JSON encoding or retaining another entry.
      if (
        this.bytes + entryBytes + pathBudget + Buffer.byteLength(entry.name) * 6 + 128 >
        1024 * 1024
      ) {
        this.incomplete('capture-byte-limit');
        break;
      }
      const kind = entry.isFile()
        ? 'file'
        : entry.isDirectory()
          ? 'directory'
          : entry.isSymbolicLink()
            ? 'symlink'
            : 'other';
      const observed = { name: entry.name, kind } as const;
      const size = Buffer.byteLength(JSON.stringify(observed)) + 1;
      if (this.bytes + entryBytes + size + pathBudget > 1024 * 1024) {
        this.incomplete('capture-byte-limit');
        break;
      }
      captured.push(Object.freeze(observed));
      entryBytes += size;
      this.directoryEntries++;
    }
    this.add({
      kind: 'directory',
      path: relativePath,
      status: 'present',
      entries: Object.freeze(captured),
    });
  }

  snapshot(): ImportConfigObservations {
    const records = Object.freeze([...this.records]);
    const issues = Object.freeze([...this.issues]);
    const complete = issues.length === 0;
    return Object.freeze({
      version: 1,
      complete,
      digest: complete
        ? createHash('sha256')
            .update(JSON.stringify({ version: 1, records }))
            .digest('hex')
        : null,
      records,
      issues,
    });
  }
}

async function readConfigFile(
  filename: string,
  observations?: ConfigObservationRecorder,
): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filename);
  } catch (error) {
    observations?.failure('file', filename, error);
    throw error;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  observations?.add({
    kind: 'file',
    path: observations.relative(filename),
    status: 'present',
    sha256,
    byteLength: bytes.byteLength,
  });
  return bytes.toString('utf-8');
}

async function readConfigDirectory(
  filename: string,
  observations?: ConfigObservationRecorder,
): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(filename, { withFileTypes: true });
    observations?.directory(filename, entries);
    return entries;
  } catch (error) {
    observations?.failure('directory', filename, error);
    throw error;
  }
}

/** TypeScript path alias config parsed from tsconfig.json */
export interface TsconfigPaths {
  /** Map of alias prefix -> target prefix (e.g., "@/" -> "src/") */
  aliases: Map<string, string>;
  /** Base URL for path resolution (relative to repo root) */
  baseUrl: string;
}

/** Go module config parsed from go.mod */
export interface GoModuleConfig {
  /** Module path (e.g., "github.com/user/repo") */
  modulePath: string;
}

/** PHP Composer PSR-4 autoload config */
export interface ComposerConfig {
  /** Map of namespace prefix -> directory (e.g., "App\\" -> "app/") */
  psr4: Map<string, string>;
  /** PSR-4 entries sorted by namespace length descending (longest match wins).
   *  Cached once at config load time to avoid re-sorting on every import. */
  psr4Sorted?: readonly [string, string][];
}

/** C# project config parsed from .csproj files */
export interface CSharpProjectConfig {
  /** Root namespace from <RootNamespace> or assembly name (default: project directory name) */
  rootNamespace: string;
  /** Directory containing the .csproj file */
  projectDir: string;
}

/** Swift Package Manager module config */
export interface SwiftPackageConfig {
  /** Map of target name -> source directory path (e.g., "SiuperModel" -> "Package/Sources/SiuperModel") */
  targets: Map<string, string>;
}

// ============================================================================
// LANGUAGE-SPECIFIC CONFIG LOADERS
// ============================================================================

/**
 * Parse tsconfig.json to extract path aliases.
 * Tries tsconfig.json, tsconfig.app.json, tsconfig.base.json in order.
 */
export async function loadTsconfigPaths(
  repoRoot: string,
  observations?: ConfigObservationRecorder,
): Promise<TsconfigPaths | null> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];

  for (const filename of candidates) {
    const tsconfigPath = path.join(repoRoot, filename);
    let read = false;
    try {
      const raw = await readConfigFile(tsconfigPath, observations);
      read = true;
      // Strip JSON comments (// and /* */ style) for robustness
      const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(stripped);
      const compilerOptions = tsconfig.compilerOptions;
      if (!compilerOptions?.paths) continue;

      const baseUrl = compilerOptions.baseUrl || '.';
      const aliases = new Map<string, string>();

      for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const target = targets[0] as string;

        // Convert glob patterns: "@/*" -> "@/", "src/*" -> "src/"
        const aliasPrefix = pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern;
        const targetPrefix = target.endsWith('/*') ? target.slice(0, -1) : target;

        aliases.set(aliasPrefix, targetPrefix);
      }

      if (aliases.size > 0) {
        if (isDev) {
          console.log(`📦 Loaded ${aliases.size} path aliases from ${filename}`);
        }
        return { aliases, baseUrl };
      }
    } catch {
      if (read) observations?.parseError(tsconfigPath);
      // File doesn't exist or isn't valid JSON - try next
    }
  }

  return null;
}

/**
 * Parse go.mod to extract module path.
 */
export async function loadGoModulePath(
  repoRoot: string,
  observations?: ConfigObservationRecorder,
): Promise<GoModuleConfig | null> {
  try {
    const goModPath = path.join(repoRoot, 'go.mod');
    const content = await readConfigFile(goModPath, observations);
    const match = content.match(/^module\s+(\S+)/m);
    if (match) {
      if (isDev) {
        console.log(`📦 Loaded Go module path: ${match[1]}`);
      }
      return { modulePath: match[1] };
    }
  } catch {
    // No go.mod
  }
  return null;
}

/** Parse composer.json to extract PSR-4 autoload mappings (including autoload-dev). */
export async function loadComposerConfig(
  repoRoot: string,
  observations?: ConfigObservationRecorder,
): Promise<ComposerConfig | null> {
  const composerPath = path.join(repoRoot, 'composer.json');
  let read = false;
  try {
    const raw = await readConfigFile(composerPath, observations);
    read = true;
    const composer = JSON.parse(raw);
    const psr4Raw = composer.autoload?.['psr-4'] ?? {};
    const psr4Dev = composer['autoload-dev']?.['psr-4'] ?? {};
    const merged = { ...psr4Raw, ...psr4Dev };

    const psr4 = new Map<string, string>();
    for (const [ns, dir] of Object.entries(merged)) {
      const nsNorm = (ns as string).replace(/\\+$/, '');
      const dirNorm = (dir as string).replace(/\\/g, '/').replace(/\/+$/, '');
      psr4.set(nsNorm, dirNorm);
    }

    if (isDev) {
      console.log(`📦 Loaded ${psr4.size} PSR-4 mappings from composer.json`);
    }
    return { psr4 };
  } catch {
    if (read) observations?.parseError(composerPath);
    return null;
  }
}

/**
 * Parse .csproj files to extract RootNamespace.
 * Scans the repo root for .csproj files and returns configs for each.
 */
export async function loadCSharpProjectConfig(
  repoRoot: string,
  observations?: ConfigObservationRecorder,
): Promise<CSharpProjectConfig[]> {
  const configs: CSharpProjectConfig[] = [];
  // BFS scan for .csproj files up to 5 levels deep, cap at 100 dirs to avoid runaway scanning
  const scanQueue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  const maxDepth = 5;
  const maxDirs = 100;
  let dirsScanned = 0;
  let depthLimited = false;

  while (scanQueue.length > 0 && dirsScanned < maxDirs) {
    const { dir, depth } = scanQueue.shift()!;
    dirsScanned++;
    try {
      const entries = await readConfigDirectory(dir, observations);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Skip common non-project directories
          if (
            entry.name === 'node_modules' ||
            entry.name === '.git' ||
            entry.name === 'bin' ||
            entry.name === 'obj'
          )
            continue;
          if (depth < maxDepth)
            scanQueue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
          else depthLimited = true;
        }
        if (entry.isFile() && entry.name.endsWith('.csproj')) {
          try {
            const csprojPath = path.join(dir, entry.name);
            const content = await readConfigFile(csprojPath, observations);
            const nsMatch = content.match(/<RootNamespace>\s*([^<]+)\s*<\/RootNamespace>/);
            const rootNamespace = nsMatch ? nsMatch[1].trim() : entry.name.replace(/\.csproj$/, '');
            const projectDir = path.relative(repoRoot, dir).replace(/\\/g, '/');
            configs.push({ rootNamespace, projectDir });
            if (isDev) {
              console.log(
                `📦 Loaded C# project: ${entry.name} (namespace: ${rootNamespace}, dir: ${projectDir})`,
              );
            }
          } catch {
            // Can't read .csproj
          }
        }
      }
    } catch {
      // Can't read directory
    }
  }
  const directoryLimited = scanQueue.length > 0;
  if (depthLimited) observations?.incomplete('depth-limit');
  if (directoryLimited) observations?.incomplete('directory-limit');
  observations?.add({
    kind: 'traversal',
    path: '.',
    maxDepth: 5,
    maxDirs: 100,
    dirsScanned,
    depthLimited,
    directoryLimited,
  });
  return configs;
}

export async function loadSwiftPackageConfig(
  repoRoot: string,
  observations?: ConfigObservationRecorder,
): Promise<SwiftPackageConfig | null> {
  // Swift imports are module-name based (e.g., `import SiuperModel`)
  // SPM convention: Sources/<TargetName>/ or Package/Sources/<TargetName>/
  // We scan for these directories to build a target map
  const targets = new Map<string, string>();

  const sourceDirs = ['Sources', 'Package/Sources', 'src'];
  for (const sourceDir of sourceDirs) {
    try {
      const fullPath = path.join(repoRoot, sourceDir);
      const entries = await readConfigDirectory(fullPath, observations);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          targets.set(entry.name, sourceDir + '/' + entry.name);
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  if (targets.size > 0) {
    if (isDev) {
      console.log(`📦 Loaded ${targets.size} Swift package targets`);
    }
    return { targets };
  }
  return null;
}

// ============================================================================
// BUNDLED CONFIG LOADER
// ============================================================================

/** Load all language-specific configs once for an ingestion run. */
export async function loadImportConfigs(
  repoRoot: string,
  allPaths: readonly string[] = [],
): Promise<ImportConfigs> {
  const observations = new ConfigObservationRecorder(repoRoot);
  const inventory = new Set(allPaths.filter(isCargoInventoryPath));
  // Observe packaging/build inputs only; packaging roots and compile-db semantics
  // are not implemented by the import resolvers.
  const observedBasenames = [
    'pyproject.toml',
    'setup.cfg',
    'compile_commands.json',
    'CMakeLists.txt',
  ];
  const observedFiles = [
    ...new Set([
      ...observedBasenames,
      ...[...inventory].filter((filename) =>
        observedBasenames.includes(path.posix.basename(filename)),
      ),
    ]),
  ].sort();
  for (const relativePath of observedFiles) {
    try {
      await readConfigFile(path.join(repoRoot, relativePath), observations);
    } catch {
      // The shared reader records absence or failure without changing resolver output.
    }
  }
  const manifests = [
    ...new Set([
      'Cargo.toml',
      ...[...inventory].filter((filename) => filename.endsWith('/Cargo.toml')),
    ]),
  ].sort();
  let cargoPresent = false;
  const rustCrateRoots = new Set<string>();
  const rustWorkspaceCrates = new Map<string, string | null>();
  const cargoLibraries = new Map<string, string | null>();
  const cargoAliases: [string, string][] = [];
  const registerCrate = (crates: Map<string, string | null>, name: string, root: string): void => {
    crates.set(name, crates.has(name) && crates.get(name) !== root ? null : root);
  };
  const cargoSources = new Map<string, string>();
  const workspaceEditions = new Map<
    string,
    NonNullable<ReturnType<typeof rustWorkspacePackageEdition>>
  >();
  for (const manifest of manifests) {
    const filename = path.join(repoRoot, manifest);
    let source: string;
    try {
      source = await readConfigFile(filename, observations);
    } catch (error) {
      if (inventory.has(manifest) || (error as { code?: string })?.code !== 'ENOENT')
        cargoPresent = true;
      continue;
    }
    cargoPresent = true;
    try {
      const workspace = rustWorkspacePackageEdition(source);
      if (workspace) {
        workspaceEditions.set(path.posix.dirname(manifest), workspace);
        if (workspace.invalidExclude || workspace.invalidMembers) observations.parseError(filename);
      }
      cargoSources.set(manifest, source);
    } catch {
      observations.parseError(filename);
    }
  }
  for (const [manifest, source] of cargoSources) {
    try {
      const memberDirectory = path.posix.dirname(manifest);
      const explicitWorkspace = rustCargoPackageWorkspace(source);
      let directory =
        explicitWorkspace === undefined
          ? memberDirectory
          : path.posix.normalize(path.posix.join(memberDirectory, explicitWorkspace));
      if (
        directory === '..' ||
        directory.startsWith('../') ||
        (explicitWorkspace !== undefined && !workspaceEditions.has(directory))
      ) {
        throw new Error('Unresolved Cargo package workspace');
      }
      let workspace: ReturnType<typeof rustWorkspacePackageEdition>;
      while (true) {
        const candidate = workspaceEditions.get(directory);
        const relative = path.posix.relative(directory, memberDirectory);
        const excluded = candidate?.exclude.some((entry) => {
          const normalized = path.posix.normalize(entry).replace(/\/$/, '');
          return (
            relative === normalized || relative.startsWith(`${normalized}/`) || normalized === '.'
          );
        });
        const included =
          candidate?.members === undefined ||
          candidate.members.some((entry) => {
            const pattern = path.posix.normalize(entry).replace(/\/$/, '').split('/');
            const parts = relative.split('/');
            return (
              pattern.length === parts.length &&
              pattern.every((segment, index) =>
                // Cargo globs are per-segment `*`, `?` and `[..]`, and match leading dots.
                minimatch(parts[index], segment, { dot: true, nobrace: true, noext: true }),
              )
            );
          });
        if (
          candidate &&
          (directory === memberDirectory ||
            (!excluded && (explicitWorkspace !== undefined || included)))
        ) {
          workspace = candidate;
          break;
        }
        if (candidate && !included) break;
        if (explicitWorkspace !== undefined || directory === '.') break;
        directory = path.posix.dirname(directory);
      }
      const targets = rustCargoTargets(
        source,
        manifest,
        inventory,
        workspace?.edition,
        workspace?.dependencies,
      );
      cargoAliases.push(...(targets.aliases ?? []));
      for (const root of targets.roots) rustCrateRoots.add(root);
      if (targets.library) {
        const { name, root } = targets.library;
        registerCrate(rustWorkspaceCrates, name, root);
        registerCrate(cargoLibraries, targets.packageName!, root);
      }
    } catch {
      observations.parseError(path.join(repoRoot, manifest));
    }
  }
  // The resolver's crate registry is global; conflicting aliases fail closed across packages.
  for (const [alias, packageName] of cargoAliases) {
    const root = cargoLibraries.get(packageName);
    if (root) registerCrate(rustWorkspaceCrates, alias, root);
    else if (root === null) rustWorkspaceCrates.set(alias, null);
  }
  return {
    tsconfigPaths: await loadTsconfigPaths(repoRoot, observations),
    goModule: await loadGoModulePath(repoRoot, observations),
    composerConfig: await loadComposerConfig(repoRoot, observations),
    swiftPackageConfig: await loadSwiftPackageConfig(repoRoot, observations),
    csharpConfigs: await loadCSharpProjectConfig(repoRoot, observations),
    ...(cargoPresent ? { rustCrateRoots: [...rustCrateRoots].sort(), rustWorkspaceCrates } : {}),
    observations: observations.snapshot(),
  };
}
