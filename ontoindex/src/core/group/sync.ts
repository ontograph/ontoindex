import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { initLbug, closeLbug, executeParameterized } from '../lbug/pool-adapter.js';
import { readRegistry, type RegistryEntry } from '../../storage/repo-manager.js';
import type { GroupConfig, RepoHandle, RepoSnapshot, StoredContract, CrossLink } from './types.js';
import { HttpRouteExtractor } from './extractors/http-route-extractor.js';
import { GrpcExtractor } from './extractors/grpc-extractor.js';
import { TopicExtractor } from './extractors/topic-extractor.js';
import { ManifestExtractor } from './extractors/manifest-extractor.js';
import { runExactMatch } from './matching.js';
import { detectServiceBoundaries, assignService } from './service-boundary-detector.js';
import type { CypherExecutor } from './contract-extractor.js';
import { writeContractRegistry } from './storage.js';
import type { ContractRegistry } from './types.js';
import { readFileContents, walkRepositoryPaths } from '../ingestion/filesystem-walker.js';

interface SyncOptions {
  extractorOverride?:
    | ((repo: RepoHandle) => Promise<StoredContract[]>)
    | (() => Promise<StoredContract[]>);
  resolveRepoHandle?: (registryName: string, groupPath: string) => Promise<RepoHandle | null>;
  skipWrite?: boolean;
  groupDir?: string;
  allowStale?: boolean;
  verbose?: boolean;
  exactOnly?: boolean;
  skipEmbeddings?: boolean;
}

interface SyncResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
  unmatched: StoredContract[];
  missingRepos: string[];
  repoSnapshots: Record<string, RepoSnapshot>;
}

const SHARED_LIB_HEADER_EXTENSIONS = new Set(['.h', '.hpp', '.hxx', '.hh', '.cuh']);
const SHARED_LIB_SOURCE_EXTENSIONS = new Set([
  ...SHARED_LIB_HEADER_EXTENSIONS,
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.cu',
]);
const INCLUDE_ROOT_DIR_NAMES = new Set(['include', 'includes', 'inc', 'header', 'headers', 'public']);
const COMMON_TOOLCHAIN_HEADERS = new Set([
  'assert.h',
  'errno.h',
  'fcntl.h',
  'inttypes.h',
  'limits.h',
  'locale.h',
  'math.h',
  'signal.h',
  'stdarg.h',
  'stdbool.h',
  'stddef.h',
  'stdint.h',
  'stdio.h',
  'stdlib.h',
  'string.h',
  'strings.h',
  'sys/socket.h',
  'sys/stat.h',
  'sys/types.h',
  'time.h',
  'unistd.h',
  'windows.h',
  'winsock2.h',
]);
const INCLUDE_REGEX = /^[ \t]*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)/gm;

export function stableRepoPoolId(entry: RegistryEntry, allEntries: RegistryEntry[]): string {
  const base = entry.name.toLowerCase();
  const resolved = path.resolve(entry.path);
  for (const other of allEntries) {
    if (other.name.toLowerCase() === base && path.resolve(other.path) !== resolved) {
      const hash = Buffer.from(entry.path).toString('base64url').slice(0, 6);
      return `${base}-${hash}`;
    }
  }
  return base;
}

function defaultResolveHandle(allEntries: RegistryEntry[]) {
  return async (registryName: string, groupPath: string): Promise<RepoHandle | null> => {
    const e = allEntries.find((en) => en.name === registryName);
    if (!e) return null;
    const poolId = stableRepoPoolId(e, allEntries);
    return {
      id: poolId,
      path: groupPath,
      repoPath: e.path,
      storagePath: e.storagePath,
    };
  };
}

/**
 * Dedupe cross-links that point from the same consumer endpoint to the same
 * provider endpoint for the same contract. Preserves first-seen order so the
 * caller controls precedence (e.g., pass manifest links first).
 */
function dedupeCrossLinks(links: CrossLink[]): CrossLink[] {
  const seen = new Set<string>();
  const out: CrossLink[] = [];
  for (const link of links) {
    const key = `${link.from.repo}::${link.from.symbolUid}|${link.to.repo}::${link.to.symbolUid}|${link.type}|${link.contractId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

function normalizeIncludePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function isSharedLibHeader(filePath: string): boolean {
  return SHARED_LIB_HEADER_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isSharedLibSource(filePath: string): boolean {
  return SHARED_LIB_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function shouldExtractIncludePath(includePath: string): boolean {
  return !includePath.startsWith('../') && (includePath.includes('/') || includePath.includes('.'));
}

function addLocalIncludeCandidate(candidates: Set<string>, candidatePath: string): void {
  const normalizedCandidate = normalizeIncludePath(candidatePath);
  candidates.add(normalizedCandidate);
  if (path.posix.extname(normalizedCandidate) !== '') return;
  for (const ext of SHARED_LIB_HEADER_EXTENSIONS) {
    candidates.add(`${normalizedCandidate}${ext}`);
  }
}

function collectIncludeRoots(headerFiles: string[]): string[] {
  const includeRoots = new Set<string>();
  for (const filePath of headerFiles) {
      const normalizedPath = normalizeIncludePath(filePath);
      const parts = normalizedPath.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
      if (!INCLUDE_ROOT_DIR_NAMES.has(parts[i].toLowerCase())) continue;
      includeRoots.add(parts.slice(0, i + 1).join('/'));
    }
  }
  return [...includeRoots];
}

function providerIncludeContractPath(filePath: string, includeRoots: string[]): string {
  const normalizedPath = normalizeIncludePath(filePath);
  let bestMatch = normalizedPath;
  for (const includeRoot of includeRoots) {
    const prefix = `${includeRoot}/`;
    if (!normalizedPath.startsWith(prefix)) continue;
    const candidate = normalizedPath.slice(prefix.length);
    if (!candidate) continue;
    if (bestMatch === normalizedPath || candidate.length < bestMatch.length) {
      bestMatch = candidate;
    }
  }
  return bestMatch;
}

function localIncludeCandidates(
  importerPath: string,
  includePath: string,
  includeRoots: string[],
): string[] {
  const normalizedInclude = normalizeIncludePath(includePath);
  const importerDir = path.posix.dirname(importerPath.replace(/\\/g, '/'));
  const candidates = new Set<string>();
  addLocalIncludeCandidate(candidates, normalizedInclude);
  if (importerDir !== '.') {
    addLocalIncludeCandidate(candidates, path.posix.join(importerDir, normalizedInclude));
  }
  for (const includeRoot of includeRoots) {
    addLocalIncludeCandidate(candidates, path.posix.join(includeRoot, normalizedInclude));
  }
  return [...candidates];
}

function resolveRepoLocalInclude(
  importerPath: string,
  includePath: string,
  localFiles: Set<string>,
  includeRoots: string[],
): string | undefined {
  for (const candidate of localIncludeCandidates(importerPath, includePath, includeRoots)) {
    if (localFiles.has(candidate)) return candidate;
  }
  return undefined;
}

async function extractSharedLibContracts(
  repoPath: string,
  repo: string,
  serviceForFile: (filePath: string) => string | undefined,
): Promise<StoredContract[]> {
  const scannedFiles = await walkRepositoryPaths(repoPath);
  const repoFiles = scannedFiles.map((file) => file.path.replace(/\\/g, '/'));
  const headerFiles = repoFiles.filter(isSharedLibHeader);
  const localFileSet = new Set(repoFiles.map((file) => normalizeIncludePath(file)));
  const includeRoots = collectIncludeRoots(headerFiles);
  const sourceFiles = repoFiles.filter(isSharedLibSource);
  const sourceContents = await readFileContents(repoPath, sourceFiles);
  const contracts: StoredContract[] = [];
  const seen = new Set<string>();

  for (const filePath of headerFiles) {
    const contractPath = providerIncludeContractPath(filePath, includeRoots);
    const contractId = `lib::include/${contractPath}`;
    const key = `provider::${filePath}::${contractId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contracts.push({
      contractId,
      type: 'lib',
      role: 'provider',
      symbolUid: `File:${filePath}`,
      symbolRef: { filePath, name: path.basename(filePath) },
      symbolName: path.basename(filePath),
      confidence: 0.95,
      meta: { source: 'shared_libs', kind: 'include-provider' },
      repo,
      service: serviceForFile(filePath),
    });
  }

  for (const filePath of sourceFiles) {
    const content = sourceContents.get(filePath);
    if (!content) continue;
    const sanitizedContent = stripBlockComments(content);
    const consumerService = serviceForFile(filePath);

    for (const match of sanitizedContent.matchAll(INCLUDE_REGEX)) {
      const rawInclude = (match[1] ?? match[2])?.trim();
      if (!rawInclude) continue;
      const includeKind = match[1] ? 'quoted' : 'angle';

      const normalizedInclude = normalizeIncludePath(rawInclude);
      const localIncludePath = resolveRepoLocalInclude(
        filePath,
        normalizedInclude,
        localFileSet,
        includeRoots,
      );
      if (localIncludePath) {
        const providerService = serviceForFile(localIncludePath);
        if (!providerService || providerService === consumerService) continue;

        const contractPath = providerIncludeContractPath(localIncludePath, includeRoots);
        const contractId = `lib::include/${contractPath}`;
        const key = `consumer::${filePath}::${contractId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        contracts.push({
          contractId,
          type: 'lib',
          role: 'consumer',
          symbolUid: `File:${filePath}`,
          symbolRef: { filePath, name: path.basename(filePath) },
          symbolName: path.basename(filePath),
          confidence: 0.85,
          meta: {
            source: 'shared_libs',
            kind: 'include-consumer',
            includePath: normalizedInclude,
            resolvedLocalPath: localIncludePath,
          },
          repo,
          service: consumerService,
        });
        continue;
      }

      if (includeKind === 'angle' && COMMON_TOOLCHAIN_HEADERS.has(normalizedInclude.toLowerCase())) {
        continue;
      }
      if (!shouldExtractIncludePath(normalizedInclude)) continue;

      const contractId = `lib::include/${normalizedInclude}`;
      const key = `consumer::${filePath}::${contractId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      contracts.push({
        contractId,
        type: 'lib',
        role: 'consumer',
        symbolUid: `File:${filePath}`,
        symbolRef: { filePath, name: path.basename(filePath) },
        symbolName: path.basename(filePath),
        confidence: 0.85,
        meta: { source: 'shared_libs', kind: 'include-consumer', includePath: normalizedInclude },
        repo,
        service: consumerService,
      });
    }
  }

  return contracts;
}

export async function syncGroup(config: GroupConfig, opts?: SyncOptions): Promise<SyncResult> {
  const missingRepos: string[] = [];
  const repoSnapshots: Record<string, RepoSnapshot> = {};
  let autoContracts: StoredContract[] = [];
  let manifestCrossLinks: CrossLink[] = [];
  let dbExecutors: Map<string, CypherExecutor> | undefined;

  const eo = opts?.extractorOverride;
  if (eo && eo.length === 0) {
    autoContracts = await (eo as () => Promise<StoredContract[]>)();
  } else {
    const entries = await readRegistry();
    const resolve = opts?.resolveRepoHandle ?? defaultResolveHandle(entries);
    const httpEx = new HttpRouteExtractor();
    const grpcEx = new GrpcExtractor();
    const topicEx = new TopicExtractor();
    const needsLbug = config.detect.http || config.detect.grpc || config.detect.topics;
    dbExecutors = new Map<string, CypherExecutor>();
    const openPoolIds: string[] = [];

    try {
      for (const [groupPath, regName] of Object.entries(config.repos)) {
        const handle = await resolve(regName, groupPath);
        if (!handle) {
          missingRepos.push(groupPath);
          continue;
        }

        const poolId = handle.id;
        const lbugPath = path.join(handle.storagePath, 'lbug');
        try {
          const boundaries = await detectServiceBoundaries(handle.repoPath);

          if (config.detect.shared_libs) {
            const extracted = await extractSharedLibContracts(handle.repoPath, groupPath, (filePath) =>
              assignService(filePath, boundaries),
            );
            autoContracts.push(...extracted);
          }

          if (needsLbug) {
            await initLbug(poolId, lbugPath);
            openPoolIds.push(poolId);

            const executor: CypherExecutor = (query, params) =>
              executeParameterized(poolId, query, params ?? {});

            dbExecutors.set(groupPath, executor);

            if (config.detect.http) {
              const extracted = await httpEx.extract(executor, handle.repoPath, handle);
              for (const c of extracted) {
                autoContracts.push({
                  ...c,
                  repo: groupPath,
                  service: assignService(c.symbolRef.filePath, boundaries),
                });
              }
            }

            if (config.detect.grpc) {
              const extracted = await grpcEx.extract(executor, handle.repoPath, handle);
              for (const c of extracted) {
                autoContracts.push({
                  ...c,
                  repo: groupPath,
                  service: assignService(c.symbolRef.filePath, boundaries),
                });
              }
            }

            if (config.detect.topics) {
              const extracted = await topicEx.extract(executor, handle.repoPath, handle);
              for (const c of extracted) {
                autoContracts.push({
                  ...c,
                  repo: groupPath,
                  service: assignService(c.symbolRef.filePath, boundaries),
                });
              }
            }
          }

          const metaPath = path.join(handle.storagePath, 'meta.json');
          try {
            const raw = await fs.readFile(metaPath, 'utf-8');
            const m = JSON.parse(raw) as { indexedAt?: string; lastCommit?: string };
            repoSnapshots[groupPath] = {
              indexedAt: m.indexedAt || '',
              lastCommit: m.lastCommit || '',
            };
          } catch {
            const e = entries.find((en) => en.name === regName);
            repoSnapshots[groupPath] = {
              indexedAt: e?.indexedAt || '',
              lastCommit: e?.lastCommit || '',
            };
          }
        } catch {
          missingRepos.push(groupPath);
        }
      }
    } finally {
      for (const id of [...new Set(openPoolIds)]) {
        await closeLbug(id).catch(() => {});
      }
    }
  }

  // Process manifest links declared in group.yaml.
  // ManifestExtractor is fully implemented but was never wired into this
  // pipeline — config.links were parsed and validated but silently dropped.
  // Placed after the DB try/finally: resolveSymbol falls back to synthetic
  // UIDs when dbExecutors is undefined or a pool is closed, so cross-links
  // are always generated regardless of whether real DB executors are available.
  if (config.links.length > 0) {
    // Warn about dangling links that reference repos not declared in config.repos.
    // They still generate cross-links via synthetic UIDs (determinism is preserved),
    // but the operator probably meant something that now silently does nothing useful.
    const knownRepos = new Set(Object.keys(config.repos));
    for (const link of config.links) {
      const dangling = [link.from, link.to].filter((r) => !knownRepos.has(r));
      if (dangling.length > 0) {
        console.warn(
          `[group/sync] manifest link ${link.type}:${link.contract} references repos not in config.repos: ${dangling.join(', ')} — cross-links will use synthetic UIDs`,
        );
      }
    }

    const manifestEx = new ManifestExtractor();
    const manifestResult = await manifestEx.extractFromManifest(config.links, dbExecutors);
    autoContracts.push(...manifestResult.contracts);
    manifestCrossLinks = manifestResult.crossLinks;
    if (opts?.verbose) {
      console.log(
        `  manifest: ${manifestCrossLinks.length} cross-links from ${config.links.length} declared links`,
      );
    }
  }

  const { matched, unmatched } = runExactMatch(autoContracts);

  // Dedupe cross-links. Manifest contracts participate in runExactMatch, so a
  // manifest-declared link can also emit a matchType:'exact' CrossLink with the
  // same endpoints. Prefer the manifest version — it reflects operator intent
  // and carries matchType:'manifest' which downstream consumers may rely on.
  const crossLinks = dedupeCrossLinks([...manifestCrossLinks, ...matched]);
  const allContracts: StoredContract[] = autoContracts;

  const registry: ContractRegistry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots,
    missingRepos,
    contracts: allContracts,
    crossLinks,
  };

  if (opts?.groupDir && !opts.skipWrite) {
    await writeContractRegistry(opts.groupDir, registry);
  }

  return {
    contracts: allContracts,
    crossLinks,
    unmatched,
    missingRepos,
    repoSnapshots,
  };
}
