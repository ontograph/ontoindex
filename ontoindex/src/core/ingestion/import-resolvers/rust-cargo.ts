import path from 'path';
import { parse } from 'smol-toml';

type Table = Record<string, unknown>;

function table(value: unknown): value is Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep workspace boundaries even when their inherited edition is missing or invalid. */
export function rustWorkspacePackageEdition(source: string):
  | {
      edition?: string;
      exclude: string[];
      invalidExclude: boolean;
      members?: string[];
      invalidMembers: boolean;
      dependencies?: Table;
    }
  | undefined {
  const manifest = parse(source) as Table;
  if (!table(manifest.workspace)) return undefined;
  const pkg = manifest.workspace.package;
  const edition = table(pkg) ? pkg.edition : undefined;
  const exclude = manifest.workspace.exclude;
  const members = manifest.workspace.members;
  const invalidMembers =
    members !== undefined &&
    (!Array.isArray(members) || members.some((entry) => typeof entry !== 'string'));
  const invalidExclude =
    exclude !== undefined &&
    (!Array.isArray(exclude) || exclude.some((entry) => typeof entry !== 'string'));
  return {
    edition:
      !invalidExclude &&
      !invalidMembers &&
      typeof edition === 'string' &&
      ['2015', '2018', '2021', '2024'].includes(edition)
        ? edition
        : undefined,
    exclude: invalidExclude ? [] : ((exclude ?? []) as string[]),
    invalidExclude,
    members: invalidMembers ? [] : (members as string[] | undefined),
    invalidMembers,
    dependencies: table(manifest.workspace.dependencies)
      ? manifest.workspace.dependencies
      : undefined,
  };
}

/** An explicit workspace is authoritative; never fall back to an ancestor on invalid input. */
export function rustCargoPackageWorkspace(source: string): string | undefined {
  const manifest = parse(source) as Table;
  const workspace = table(manifest.package) ? manifest.package.workspace : undefined;
  if (workspace === undefined) return undefined;
  if (
    typeof workspace !== 'string' ||
    workspace.length === 0 ||
    workspace.includes('\\') ||
    workspace.includes('\0') ||
    path.posix.isAbsolute(workspace) ||
    /^[A-Za-z]:/.test(workspace)
  )
    throw new Error('Invalid Cargo package workspace');
  return workspace;
}

/** Only canonical repository-relative inventory paths are eligible for Cargo reads. */
export function isCargoInventoryPath(filename: string): boolean {
  return (
    filename.length > 0 &&
    !filename.includes('\\') &&
    !filename.includes('\0') &&
    !path.posix.isAbsolute(filename) &&
    !/^[A-Za-z]:/.test(filename) &&
    filename.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** Resolve the supported static Cargo lib/bin subset; never invoke Cargo or read files. */
export function rustCargoRoots(
  source: string,
  manifestPath: string,
  inventory: ReadonlySet<string>,
): string[] {
  return rustCargoTargets(source, manifestPath, inventory).roots;
}

/** Discover roots and the one importable library from the same parsed manifest. */
export function rustCargoTargets(
  source: string,
  manifestPath: string,
  inventory: ReadonlySet<string>,
  inheritedEdition?: string,
  workspaceDependencies?: Table,
): {
  roots: string[];
  packageName?: string;
  aliases?: [string, string][];
  library?: { name: string; root: string };
} {
  const manifest = parse(source) as Table;
  if (!isCargoInventoryPath(manifestPath)) throw new Error('Invalid Cargo manifest path');
  if (manifest.package === undefined) return { roots: [] };
  if (!table(manifest.package)) throw new Error('Invalid Cargo package');
  const pkg = manifest.package;
  const aliases: [string, string][] = [];
  const collectDependencies = (owner: Table): void => {
    for (const kind of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      const dependencies = owner[kind];
      if (!table(dependencies)) continue;
      for (const [alias, value] of Object.entries(dependencies)) {
        if (!table(value)) continue;
        const dependency = value.workspace === true ? workspaceDependencies?.[alias] : value;
        if (table(dependency) && typeof dependency.package === 'string') {
          aliases.push([alias.replace(/-/g, '_'), dependency.package]);
        }
      }
    }
  };
  collectDependencies(manifest);
  if (table(manifest.target)) {
    for (const target of Object.values(manifest.target)) {
      if (table(target)) collectDependencies(target);
    }
  }
  const validName = (name: unknown): name is string =>
    typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name);
  if (!validName(pkg.name)) throw new Error('Invalid Cargo package name');
  for (const flag of ['autolib', 'autobins']) {
    if (pkg[flag] !== undefined && typeof pkg[flag] !== 'boolean') {
      throw new Error('Invalid Cargo auto-discovery flag');
    }
  }
  if (manifest.lib !== undefined && !table(manifest.lib)) throw new Error('Invalid Cargo lib');
  if (manifest.bin !== undefined && !Array.isArray(manifest.bin))
    throw new Error('Invalid Cargo bins');
  const lib = manifest.lib as Table | undefined;
  const bins = (manifest.bin ?? []) as unknown[];
  let edition = pkg.edition ?? '2015';
  if (table(edition) && edition.workspace === true) {
    if (!inheritedEdition || !['2015', '2018', '2021', '2024'].includes(inheritedEdition)) {
      throw new Error('Unresolved Cargo workspace edition');
    }
    edition = inheritedEdition;
  }
  if (typeof edition !== 'string') throw new Error('Invalid Cargo package edition');
  const knownEdition = ['2015', '2018', '2021', '2024'].includes(edition as string);
  if (!knownEdition) return { roots: [] };
  const oldExplicit = edition === '2015' && (lib !== undefined || bins.length > 0);
  const autoLib =
    knownEdition && (pkg.autolib === true || (pkg.autolib === undefined && !oldExplicit));
  const autoBins =
    knownEdition && (pkg.autobins === true || (pkg.autobins === undefined && !oldExplicit));
  const directory = path.posix.dirname(manifestPath);
  const prefix = directory === '.' ? '' : `${directory}/`;
  const roots = new Set<string>();
  const rootPath = (relative: unknown): string => {
    if (
      typeof relative !== 'string' ||
      relative.includes('\\') ||
      relative.includes('\0') ||
      path.posix.isAbsolute(relative) ||
      /^[A-Za-z]:/.test(relative) ||
      relative.split('/').includes('..') ||
      !isCargoInventoryPath(path.posix.normalize(relative))
    ) {
      throw new Error('Invalid Cargo target path');
    }
    return `${prefix}${path.posix.normalize(relative)}`;
  };
  const add = (filename: string): void => {
    if (filename.endsWith('.rs') && inventory.has(filename)) roots.add(filename);
  };

  if (lib) {
    if (lib.name !== undefined && !validName(lib.name)) throw new Error('Invalid Cargo lib name');
    if (lib.path !== undefined) add(rootPath(lib.path));
    else if (knownEdition) add(`${prefix}src/lib.rs`);
  } else if (autoLib) add(`${prefix}src/lib.rs`);
  const libraryRoot = [...roots][0];

  const explicit = new Map<string, Table>();
  for (const bin of bins) {
    if (!table(bin) || !validName(bin.name) || explicit.has(bin.name)) {
      throw new Error('Invalid or duplicate Cargo bin name');
    }
    if (bin.path !== undefined) rootPath(bin.path);
    explicit.set(bin.name, bin);
  }
  const automatic = new Map<string, string[]>();
  const candidate = (name: string, filename: string): void => {
    if (!inventory.has(filename)) return;
    const existing = automatic.get(name) ?? [];
    existing.push(filename);
    automatic.set(name, existing);
  };
  candidate(pkg.name, `${prefix}src/main.rs`);
  for (const filename of inventory) {
    if (!filename.startsWith(`${prefix}src/bin/`)) continue;
    const relative = filename.slice(`${prefix}src/bin/`.length);
    const match = /^([^/]+)\.rs$/.exec(relative) ?? /^([^/]+)\/main\.rs$/.exec(relative);
    if (match && validName(match[1])) candidate(match[1], filename);
  }
  for (const [name, bin] of explicit) {
    if (bin.path !== undefined) add(rootPath(bin.path));
    else if (knownEdition) {
      const candidates = automatic.get(name) ?? [];
      if (candidates.length > 1) throw new Error('Ambiguous Cargo bin root');
      if (candidates.length === 1) add(candidates[0]);
    }
  }
  if (autoBins) {
    for (const [name, candidates] of automatic) {
      if (explicit.has(name)) continue;
      if (candidates.length > 1) throw new Error('Ambiguous Cargo bin root');
      add(candidates[0]);
    }
  }
  return {
    roots: [...roots].sort(),
    packageName: pkg.name,
    aliases,
    ...(libraryRoot
      ? {
          library: {
            name: ((lib?.name ?? pkg.name) as string).replace(/-/g, '_'),
            root: libraryRoot,
          },
        }
      : {}),
  };
}
