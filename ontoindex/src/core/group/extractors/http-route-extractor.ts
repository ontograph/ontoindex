import * as path from 'node:path';
import { glob } from 'glob';
import Parser from 'tree-sitter';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { capScanFiles, readSafe } from './fs-utils.js';
import { getPluginForFile, HTTP_SCAN_GLOB, type HttpDetection } from './http-patterns/index.js';
import { toTreeSitterLanguage } from './tree-sitter-scanner.js';
import { httpMethodFromRouteId } from '../../ingestion/route-extractors/route-identity.js';

/**
 * Language-agnostic orchestrator for HTTP route (provider + consumer)
 * contract extraction. Two strategies, in order of preference per role:
 *
 * 1. **Graph-assisted (Strategy A)** — if a per-repo LadybugDB executor
 *    is available, read `HANDLES_ROUTE` / `FETCHES` Cypher edges that
 *    the ingestion pipeline already produced via tree-sitter. This is
 *    the preferred path because the graph has richer symbol metadata
 *    (real uids, class/method structure, etc.).
 *
 * 2. **Source-scan fallback (Strategy B)** — parse files directly with
 *    the per-language plugin registry in `./http-patterns/`. Used when
 *    the graph has no routes/fetches for this repo (e.g. a repo that
 *    hasn't been indexed yet, or whose indexer doesn't know the
 *    framework). Each plugin owns its tree-sitter grammar and query
 *    sources — this orchestrator imports NO grammars or query strings.
 *
 * Adding a new language for Strategy B is a one-file edit in
 * `http-patterns/index.ts`: register a new `HttpLanguagePlugin` and
 * widen `HTTP_SCAN_GLOB` if needed.
 */

// ─── Graph-assisted queries ──────────────────────────────────────────

const HANDLES_ROUTE_QUERY = `
MATCH (handler)-[r:CodeRelation {type: 'HANDLES_ROUTE'}]->(route:Route)
RETURN handler.id AS fileId, handler.filePath AS filePath,
       route.name AS routePath, route.id AS routeId,
       handler.name AS handlerName, labels(handler) AS handlerLabels,
       route.responseKeys AS responseKeys,
       r.reason AS routeSource`;

const FETCHES_QUERY = `
MATCH (callerFile:File)-[r:CodeRelation {type: 'FETCHES'}]->(route:Route)
RETURN callerFile.id AS fileId, callerFile.filePath AS filePath,
       route.name AS routePath, route.id AS routeId,
       r.reason AS fetchReason`;

const CONTAINS_QUERY = `
MATCH (file:File {id: $fileId})<-[:CodeRelation {type: 'CONTAINS'}]-(sym)
WHERE sym.startLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath, labels(sym) AS labels
ORDER BY sym.startLine`;

// ─── Path normalization (shared between provider / consumer paths) ──

/**
 * Canonicalize a provider-side HTTP path for contract-id generation:
 *   - strip query string
 *   - lower-case
 *   - drop trailing slash
 *   - collapse `:id`, `{id}`, `[id]` path params into a single `{param}`
 */
export function normalizeHttpPath(p: string): string {
  let s = p.trim().split('?')[0].toLowerCase().replace(/\/+$/, '');
  s = s.replace(/:\w+/g, '{param}');
  s = s.replace(/\{[^}]+\}/g, '{param}');
  s = s.replace(/\[[^\]]+\]/g, '{param}');
  // Preserve root: after stripping trailing slashes, the root "/"
  // collapses to "" which would produce malformed contract ids like
  // `http::GET::`. Restore a single slash for the root case.
  return s === '' ? '/' : s;
}

/**
 * Consumer-side normalization is more aggressive:
 *   - template literals (`${x}`) → `{param}`
 *   - strip protocol + host if the URL is absolute
 *   - numeric segments → `{param}` (so `/api/orders/42` → `/api/orders/{param}`)
 */
function normalizeConsumerPath(url: string): string {
  const templated = url.replace(/\$\{[^}]+\}/g, '{param}').trim();
  let pathOnly = templated;
  if (/^https?:\/\//i.test(templated)) {
    try {
      pathOnly = new URL(templated).pathname;
    } catch {
      pathOnly = templated.replace(/^https?:\/\/[^/]+/i, '');
    }
  }
  const normalized = normalizeHttpPath(pathOnly || '/');
  const segments = normalized
    .split('/')
    .filter(Boolean)
    .map((segment) => (/^\d+$/.test(segment) ? '{param}' : segment));
  return `/${segments.join('/')}`.replace(/\/+$/, '') || '/';
}

function contractIdFor(method: string, pathNorm: string): string {
  return `http::${method.toUpperCase()}::${pathNorm}`;
}

function mergeGraphAndSource(
  graphContracts: ExtractedContract[],
  sourceContracts: ExtractedContract[],
): ExtractedContract[] {
  const seen = new Set(
    graphContracts.map(
      (contract) => `${contract.role}|${contract.contractId}|${contract.symbolRef.filePath}`,
    ),
  );
  return [
    ...graphContracts,
    ...sourceContracts.filter((contract) => {
      const key = `${contract.role}|${contract.contractId}|${contract.symbolRef.filePath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

// ─── Graph row helpers ───────────────────────────────────────────────

function methodFromRouteReason(reason: string): string | null {
  const r = reason || '';
  const evidence = r.match(/(?:^|\|)http-method:([A-Za-z]+)/i)?.[1];
  if (evidence) return evidence.toUpperCase();
  if (/GetMapping|decorator-Get/i.test(r)) return 'GET';
  if (/PostMapping|decorator-Post/i.test(r)) return 'POST';
  if (/PutMapping|decorator-Put/i.test(r)) return 'PUT';
  if (/DeleteMapping|decorator-Delete/i.test(r)) return 'DELETE';
  if (/PatchMapping|decorator-Patch/i.test(r)) return 'PATCH';
  return null;
}

function pickSymbolUid(
  rows: Record<string, unknown>[],
  preferredName: string | null,
): { uid: string; name: string; filePath: string } {
  const norm = (x: unknown) => String(x ?? '');
  const labeled = rows.filter((r) => {
    const labels = r.labels ?? r[3];
    const s = JSON.stringify(labels);
    return s.includes('Method') || s.includes('Function');
  });
  const pool = labeled.length > 0 ? labeled : rows;
  if (preferredName) {
    const hit = pool.find((r) => norm(r.name ?? r[1]) === preferredName);
    if (hit) {
      return {
        uid: norm(hit.uid ?? hit[0]),
        name: norm(hit.name ?? hit[1]),
        filePath: norm(hit.filePath ?? hit[2]),
      };
    }
  }
  const first = pool[0] || rows[0];
  return {
    uid: norm(first?.uid ?? first?.[0]),
    name: norm(first?.name ?? first?.[1]),
    filePath: norm(first?.filePath ?? first?.[2]),
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────

export class HttpRouteExtractor implements ContractExtractor {
  type = 'http' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    // Parse each file at most once and reuse the plugin results across
    // both graph-assisted enrichment and source-scan emission.
    const parser = new Parser();
    const cachedDetections = new Map<string, HttpDetection[]>();
    const getDetections = (rel: string): HttpDetection[] => {
      const cached = cachedDetections.get(rel);
      if (cached) return cached;
      const plugin = getPluginForFile(rel);
      if (!plugin) {
        cachedDetections.set(rel, []);
        return [];
      }
      const content = readSafe(repoPath, rel);
      if (!content) {
        cachedDetections.set(rel, []);
        return [];
      }
      try {
        parser.setLanguage(
          toTreeSitterLanguage(plugin.languageForContent?.(content) ?? plugin.language),
        );
        const tree = parser.parse(content);
        const detections = plugin.scan(tree);
        cachedDetections.set(rel, detections);
        return detections;
      } catch {
        cachedDetections.set(rel, []);
        return [];
      }
    };

    // Glob the source-scan file list at most once per extract() —
    // both provider and consumer fallback paths share the same list.
    let scannedFiles: string[] | null = null;
    const getScannedFiles = async (): Promise<string[]> => {
      if (scannedFiles) return scannedFiles;
      scannedFiles = await this.scanFiles(repoPath);
      return scannedFiles;
    };

    const graphProviders =
      dbExecutor != null ? await this.extractProvidersGraph(dbExecutor, getDetections) : [];
    const providers = mergeGraphAndSource(
      graphProviders,
      this.extractProvidersSourceScan(await getScannedFiles(), getDetections),
    );

    const graphConsumers =
      dbExecutor != null ? await this.extractConsumersGraph(dbExecutor, getDetections) : [];
    const consumers = mergeGraphAndSource(
      graphConsumers,
      this.extractConsumersSourceScan(await getScannedFiles(), getDetections),
    );

    return [...providers, ...consumers];
  }

  private async scanFiles(repoPath: string): Promise<string[]> {
    const files = await glob(HTTP_SCAN_GLOB, {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/vendor/**'],
      nodir: true,
    });
    return capScanFiles(files, 'http');
  }

  // ─── Graph-assisted providers ──────────────────────────────────────

  private async extractProvidersGraph(
    db: CypherExecutor,
    getDetections: (rel: string) => HttpDetection[],
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    let rows: Record<string, unknown>[];
    try {
      rows = await db(HANDLES_ROUTE_QUERY);
    } catch {
      return [];
    }

    const directlyResolvedRouteIds = new Set(
      rows
        .filter((row) => /Method|Function/.test(JSON.stringify(row.handlerLabels ?? row[5] ?? [])))
        .map((row) => String(row.routeId ?? row[3] ?? ''))
        .filter(Boolean),
    );

    for (const row of rows) {
      const filePath = String(row.filePath ?? '');
      const routePath = String(row.routePath ?? '');
      const routeId = String(row.routeId ?? row[3] ?? '');
      const directSymbol = /Method|Function/.test(
        JSON.stringify(row.handlerLabels ?? row[5] ?? []),
      );
      if (!directSymbol && directlyResolvedRouteIds.has(routeId)) continue;
      const routeSource = String(row.routeSource ?? row.routeReason ?? row[7] ?? '');
      let method = httpMethodFromRouteId(routeId) ?? methodFromRouteReason(routeSource);

      // A route ID or relation reason supplies method evidence. Source
      // scanning can fill a missing method only when one route matches.
      const detections = filePath ? getDetections(filePath) : [];
      const providerDetections = detections.filter((d) => d.role === 'provider');
      let handlerName: string | null =
        directSymbol && typeof row.handlerName === 'string' ? row.handlerName : null;
      const normalizedRoute = normalizeHttpPath(routePath);
      // Multiple methods at one path are common. Keep only the candidate
      // whose method matches explicit route evidence, or infer from one
      // unique candidate when the graph has no method.
      const candidates = providerDetections.filter(
        (d) => normalizeHttpPath(d.path) === normalizedRoute,
      );
      let match: (typeof candidates)[number] | undefined;
      const methodCandidates = method ? candidates.filter((d) => d.method === method) : candidates;
      const ambiguousCandidates = methodCandidates.length > 1 && !directSymbol;
      if (method) {
        if (methodCandidates.length === 1) match = methodCandidates[0];
      } else if (methodCandidates.length === 1) {
        match = methodCandidates[0];
      } else {
        continue;
      }
      if (match) {
        if (!method) method = match.method;
        if (!handlerName) handlerName = match.name;
      }
      if (!method) continue;

      const pathNorm = normalizeHttpPath(routePath);
      const cid = contractIdFor(method, pathNorm);

      let symbolUid = directSymbol ? String(row.fileId ?? row[0] ?? '') : '';
      let symbolName = path.basename(filePath) || 'handler';
      let symPath = filePath;
      const fileId = row.fileId ?? row[0];
      if (handlerName && directSymbol) symbolName = handlerName;
      if (fileId && !directSymbol && handlerName && !ambiguousCandidates) {
        try {
          const syms = await db(CONTAINS_QUERY, { fileId });
          if (syms.length > 0) {
            const picked = pickSymbolUid(syms, handlerName);
            symbolUid = picked.uid;
            symbolName = picked.name;
            symPath = picked.filePath || filePath;
          }
        } catch {
          /* ignore */
        }
      }

      out.push({
        contractId: cid,
        type: 'http',
        role: 'provider',
        symbolUid,
        symbolRef: { filePath: symPath, name: symbolName },
        symbolName,
        confidence: directSymbol ? 0.95 : ambiguousCandidates ? 0.65 : 0.9,
        meta: {
          method,
          path: pathNorm,
          pathSegments: pathNorm.split('/').filter(Boolean),
          extractionStrategy: 'graph_assisted',
          routeSource,
        },
      });
    }
    return out;
  }

  // ─── Source-scan providers ─────────────────────────────────────────

  private extractProvidersSourceScan(
    files: string[],
    getDetections: (rel: string) => HttpDetection[],
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    for (const rel of files) {
      const detections = getDetections(rel);
      for (const d of detections) {
        if (d.role !== 'provider') continue;
        const pathNorm = normalizeHttpPath(d.path);
        out.push({
          contractId: contractIdFor(d.method, pathNorm),
          type: 'http',
          role: 'provider',
          symbolUid: '',
          symbolRef: { filePath: rel, name: d.name ?? 'handler' },
          symbolName: d.name ?? 'handler',
          confidence: d.confidence,
          meta: {
            method: d.method,
            path: pathNorm,
            pathSegments: pathNorm.split('/').filter(Boolean),
            extractionStrategy: 'source_scan',
            framework: d.framework,
          },
        });
      }
    }
    return this.dedupeContracts(out);
  }

  // ─── Graph-assisted consumers ──────────────────────────────────────

  private async extractConsumersGraph(
    db: CypherExecutor,
    getDetections: (rel: string) => HttpDetection[],
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    let rows: Record<string, unknown>[];
    try {
      rows = await db(FETCHES_QUERY);
    } catch {
      return [];
    }
    for (const row of rows) {
      const filePath = String(row.filePath ?? '');
      const routePath = String(row.routePath ?? '');
      const pathNorm = normalizeHttpPath(routePath);
      const fetchReason = String(row.fetchReason ?? '');
      let method = fetchReason.match(/(?:^|\|)request-method:([A-Za-z]+)/)?.[1]?.toUpperCase();
      // Prefer the plugin's detected method if we can find a matching
      // fetch/axios call in the same file.
      const detections = filePath ? getDetections(filePath) : [];
      // Symmetric to the provider path: infer a method only from explicit
      // graph evidence or one unique source-scan match.
      const consumerCandidates = detections.filter(
        (d) => d.role === 'consumer' && normalizeConsumerPath(d.path) === pathNorm,
      );
      if (!method && consumerCandidates.length === 1) method = consumerCandidates[0].method;
      if (!method) continue;

      const cid = contractIdFor(method, pathNorm);
      let symbolUid = '';
      let symbolName = 'fetch';
      let symPath = filePath;
      const fileId = row.fileId ?? row[0];
      if (fileId) {
        try {
          const syms = await db(CONTAINS_QUERY, { fileId });
          if (syms.length > 0) {
            const picked = pickSymbolUid(syms, null);
            symbolUid = picked.uid;
            symbolName = picked.name;
            symPath = picked.filePath || filePath;
          }
        } catch {
          /* ignore */
        }
      }
      out.push({
        contractId: cid,
        type: 'http',
        role: 'consumer',
        symbolUid,
        symbolRef: { filePath: symPath, name: symbolName },
        symbolName,
        confidence: /(?:^|\|)(?:method-unknown|dynamic-url|path-only-route)(?:\||$)/.test(
          fetchReason,
        )
          ? 0.65
          : 0.9,
        meta: {
          method,
          path: pathNorm,
          extractionStrategy: 'graph_assisted',
          fetchReason,
          methodEvidence: fetchReason.includes('request-method:')
            ? 'graph-request-method'
            : 'source-scan',
        },
      });
    }
    return out;
  }

  // ─── Source-scan consumers ─────────────────────────────────────────

  private extractConsumersSourceScan(
    files: string[],
    getDetections: (rel: string) => HttpDetection[],
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    for (const rel of files) {
      const detections = getDetections(rel);
      for (const d of detections) {
        if (d.role !== 'consumer') continue;
        const pathNorm = normalizeConsumerPath(d.path);
        out.push({
          contractId: contractIdFor(d.method, pathNorm),
          type: 'http',
          role: 'consumer',
          symbolUid: '',
          symbolRef: { filePath: rel, name: 'fetch' },
          symbolName: 'fetch',
          confidence: d.confidence,
          meta: {
            method: d.method,
            path: pathNorm,
            extractionStrategy: 'source_scan',
            framework: d.framework,
          },
        });
      }
    }
    return this.dedupeContracts(out);
  }

  private dedupeContracts(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    const out: ExtractedContract[] = [];
    for (const c of items) {
      const k = `${c.contractId}|${c.symbolRef.filePath}|${c.symbolRef.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }
}
