/**
 * Phase: routes
 *
 * Builds the route registry (Next.js, Expo, PHP, Laravel, decorator-based)
 * and creates Route graph nodes + HANDLES_ROUTE edges.
 * Also links middleware, processes fetch() calls, and scans HTML templates.
 *
 * @deps    parse
 * @reads   allPaths, allExtractedRoutes, allDecoratorRoutes, allFetchCalls
 * @writes  graph (Route nodes, HANDLES_ROUTE, FETCHES_FROM edges)
 * @output  routeRegistry, handlerContents
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';
import { nextjsFileToRouteURL, normalizeFetchURL } from '../route-extractors/nextjs.js';
import {
  normalizeHttpMethod,
  routeIdentity,
  routeNodeId,
} from '../route-extractors/route-identity.js';
import { expoFileToRouteURL } from '../route-extractors/expo.js';
import { phpFileToRouteURL } from '../route-extractors/php.js';
import { extractPHPResponseShapes } from '../route-extractors/response-shapes.js';
import {
  extractMiddlewareChain,
  extractNextjsMiddlewareConfig,
  compileMatcher,
  compiledMatcherMatchesRoute,
} from '../route-extractors/middleware.js';
import { processNextjsFetchRoutes } from '../call-resolution/route-processor.js';
import { generateId } from '../../../lib/utils.js';
import { readFileContents } from '../filesystem-walker.js';
import { isDev } from '../utils/env.js';
import { getActiveModelPacks } from '../../../analysis-packs/execution.js';
import type { ExtractedRoute, ExtractedDecoratorRoute } from '../workers/parse-types.js';
import { loadRouteProvider } from '../route-provider.js';

const EXPO_NAV_PATTERNS = [
  /router\.(push|replace|navigate)\(\s*['"`]([^'"`]+)['"`]/g,
  /<Link\s+[^>]*href=\s*['"`]([^'"`]+)['"`]/g,
];

export interface RouteEntry {
  filePath: string;
  source: string;
  routePath: string;
  httpMethod?: string;
  handlerSymbol?: string;
  middleware?: string[];
  responseKeys?: string[];
  errorKeys?: string[];
}

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const handlerLeafName = (value: string): string =>
  value.match(/(?:^|[.$:>])([A-Za-z_$][\w$]*)$/)?.[1] ?? value;
const compareRoutes = (
  a: ExtractedRoute | ExtractedDecoratorRoute,
  b: ExtractedRoute | ExtractedDecoratorRoute,
) =>
  compareStrings(a.filePath, b.filePath) ||
  a.lineNumber - b.lineNumber ||
  compareStrings(a.routePath ?? '', b.routePath ?? '') ||
  compareStrings(a.httpMethod, b.httpMethod);

export interface RoutesOutput {
  /** Keyed by `METHOD /path` when method evidence exists, otherwise by `/path`. */
  routeRegistry: Map<string, RouteEntry>;
}

async function getRouteModelPackIds(repoPath: string): Promise<string[]> {
  const packs = await getActiveModelPacks(repoPath, ['route-models']);
  return packs.map((pack) => pack.id);
}

export const routesPhase: PipelinePhase<RoutesOutput> = {
  name: 'routes',
  deps: ['parse'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<RoutesOutput> {
    const parseOutput = getPhaseOutput<ParseOutput>(deps, 'parse');
    const {
      allPaths,
      allFetchCalls: parseFetchCalls,
      allExtractedRoutes,
      allDecoratorRoutes,
    } = parseOutput;

    // Local copy — routes phase must not mutate upstream ParseOutput
    const allFetchCalls = [...parseFetchCalls];

    const routeRegistry = new Map<string, RouteEntry>();
    const routeModelPackIds = await getRouteModelPackIds(ctx.repoPath);

    // Detect Expo Router app/ roots vs Next.js app/ roots (monorepo-safe)
    const expoAppRoots = new Set<string>();
    const nextjsAppRoots = new Set<string>();
    const expoAppPaths = new Set<string>();
    for (const p of allPaths) {
      const norm = p.replace(/\\/g, '/');
      const appIdx = norm.lastIndexOf('app/');
      if (appIdx < 0) continue;
      const root = norm.slice(0, appIdx + 4);
      if (/\/_layout\.(tsx?|jsx?)$/.test(norm)) expoAppRoots.add(root);
      if (/\/page\.(tsx?|jsx?)$/.test(norm)) nextjsAppRoots.add(root);
    }
    for (const root of nextjsAppRoots) expoAppRoots.delete(root);
    if (expoAppRoots.size > 0) {
      for (const p of allPaths) {
        const norm = p.replace(/\\/g, '/');
        const appIdx = norm.lastIndexOf('app/');
        if (appIdx >= 0 && expoAppRoots.has(norm.slice(0, appIdx + 4))) expoAppPaths.add(p);
      }
    }

    for (const p of allPaths) {
      if (expoAppPaths.has(p)) {
        const expoURL = expoFileToRouteURL(p);
        if (expoURL && !routeRegistry.has(expoURL)) {
          routeRegistry.set(expoURL, {
            filePath: p,
            routePath: expoURL,
            source: 'expo-filesystem-route',
          });
          continue;
        }
      }
      const nextjsURL = nextjsFileToRouteURL(p);
      if (nextjsURL && !routeRegistry.has(nextjsURL)) {
        routeRegistry.set(nextjsURL, {
          filePath: p,
          routePath: nextjsURL,
          source: 'nextjs-filesystem-route',
        });
        continue;
      }
      if (p.endsWith('.php')) {
        const phpURL = phpFileToRouteURL(p);
        if (phpURL && !routeRegistry.has(phpURL)) {
          routeRegistry.set(phpURL, { filePath: p, routePath: phpURL, source: 'php-file-route' });
        }
      }
    }

    const ensureSlash = (path: string) => (path.startsWith('/') ? path : '/' + path);
    let duplicateRoutes = 0;
    const addRoute = (url: string, entry: Omit<RouteEntry, 'routePath'>) => {
      const routePath = ensureSlash(url);
      const httpMethod = normalizeHttpMethod(entry.httpMethod);
      const identity = routeIdentity(routePath, httpMethod);
      const existing = routeRegistry.get(identity);
      if (existing) {
        duplicateRoutes++;
        for (const field of ['responseKeys', 'errorKeys'] as const) {
          if (entry[field]?.length)
            existing[field] = [...new Set([...(existing[field] ?? []), ...entry[field]])];
        }
        if (existing.handlerSymbol !== entry.handlerSymbol) existing.handlerSymbol = undefined;
        return;
      }
      routeRegistry.set(identity, {
        ...entry,
        routePath,
        ...(httpMethod ? { httpMethod } : {}),
        ...(entry.responseKeys ? { responseKeys: [...entry.responseKeys] } : {}),
        ...(entry.errorKeys ? { errorKeys: [...entry.errorKeys] } : {}),
      });
    };
    for (const route of [...allExtractedRoutes].sort(compareRoutes)) {
      if (!route.routePath) continue;
      addRoute(ensureSlash(route.routePath), {
        filePath: route.filePath,
        source: 'framework-route',
        httpMethod: route.httpMethod,
        ...(route.controllerName && route.methodName
          ? { handlerSymbol: `${route.controllerName}.${route.methodName}` }
          : {}),
        middleware: route.middleware,
        responseKeys: route.responseKeys,
        errorKeys: route.errorKeys,
      });
    }
    for (const dr of [...allDecoratorRoutes].sort(
      (a, b) => compareRoutes(a, b) || compareStrings(a.decoratorName, b.decoratorName),
    )) {
      if (!dr.routePath) continue;
      addRoute(ensureSlash(dr.routePath), {
        filePath: dr.filePath,
        source: `decorator-${dr.decoratorName}`,
        httpMethod: dr.httpMethod,
        ...(dr.handlerSymbol ? { handlerSymbol: dr.handlerSymbol } : {}),
        responseKeys: dr.responseKeys,
        errorKeys: dr.errorKeys,
      });
    }

    const provider = await loadRouteProvider();
    const provided = provider && await provider.collect({
      repoPath: ctx.repoPath, allPaths, graph: ctx.graph,
      readFiles: (paths) => readFileContents(ctx.repoPath, paths),
    });
    if (provided) {
      if (!Array.isArray(provided.routes)) throw new Error(`Route provider ${provider!.id} returned invalid routes`);
      for (const warning of provided.warnings ?? []) console.error(`[route-provider:${provider!.id}] ${warning}`);
      for (const route of provided.routes) {
        if (!route.routePath?.startsWith('/') || !allPaths.includes(route.filePath)) {
          throw new Error(`Route provider ${provider!.id} returned an invalid route`);
        }
        addRoute(route.routePath, route);
      }
      allFetchCalls.push(...(provided.consumers ?? []));
    }

    // Method-specific evidence supersedes a path-only filesystem candidate
    // for that path. Keeping both creates duplicate provider contracts.
    const methodSpecificPaths = new Set(
      [...routeRegistry.values()]
        .filter((entry) => entry.httpMethod)
        .map((entry) => `${entry.filePath}\0${entry.routePath}`),
    );
    for (const [identity, entry] of routeRegistry) {
      if (!entry.httpMethod && methodSpecificPaths.has(`${entry.filePath}\0${entry.routePath}`))
        routeRegistry.delete(identity);
    }

    parseOutput.releaseRouteExtractionData?.();

    let handlerContents: Map<string, string> | undefined;
    if (routeRegistry.size > 0) {
      const handlerPaths = [...new Set([...routeRegistry.values()].map((e) => e.filePath))];
      handlerContents = await readFileContents(ctx.repoPath, handlerPaths);
      const symbolNodesByFile = new Map<string, { id: string; label: string; name: string }[]>();
      ctx.graph.forEachNode((node) => {
        if (
          (node.label !== 'Method' && node.label !== 'Function') ||
          typeof node.properties.filePath !== 'string' ||
          typeof node.properties.name !== 'string'
        )
          return;
        let nodes = symbolNodesByFile.get(node.properties.filePath);
        if (!nodes) {
          nodes = [];
          symbolNodesByFile.set(node.properties.filePath, nodes);
        }
        nodes.push({ id: node.id, label: node.label, name: node.properties.name });
      });

      for (const [, entry] of routeRegistry) {
        const { filePath: handlerPath, source: routeSource } = entry;
        const content = handlerContents.get(handlerPath);
        // File-based routes have no separate handler symbol, so file-level evidence applies.
        const fileBased =
          routeSource.endsWith('filesystem-route') || routeSource === 'php-file-route';
        const phpShapes =
          fileBased && content && handlerPath.endsWith('.php')
            ? extractPHPResponseShapes(content)
            : undefined;
        const responseKeys = entry.responseKeys ?? phpShapes?.responseKeys;
        const errorKeys = entry.errorKeys ?? phpShapes?.errorKeys;
        const middleware = entry.middleware?.length
          ? entry.middleware
          : fileBased && content
            ? extractMiddlewareChain(content)?.chain
            : undefined;
        const routeNodeIdValue = routeNodeId(entry.routePath, entry.httpMethod);
        ctx.graph.addNode({
          id: routeNodeIdValue,
          label: 'Route',
          properties: {
            name: entry.routePath,
            filePath: handlerPath,
            ...(entry.httpMethod ? { httpMethod: entry.httpMethod } : {}),
            ...(responseKeys ? { responseKeys } : {}),
            ...(errorKeys ? { errorKeys } : {}),
            ...(middleware && middleware.length > 0 ? { middleware } : {}),
            ...(routeModelPackIds.length > 0 ? { modelPacks: routeModelPackIds } : {}),
          },
        });

        const handlerFileId = generateId('File', handlerPath);
        const routeEvidence = [
          routeSource,
          entry.httpMethod ? `http-method:${entry.httpMethod}` : 'coverage:path-only',
          ...(entry.handlerSymbol ? [`handler-symbol:${entry.handlerSymbol}`] : []),
          ...(routeModelPackIds.length > 0 ? [`model-packs:${routeModelPackIds.join(',')}`] : []),
        ].join('|');
        ctx.graph.addRelationship({
          id: generateId('HANDLES_ROUTE', `${handlerFileId}->${routeNodeIdValue}`),
          sourceId: handlerFileId,
          targetId: routeNodeIdValue,
          type: 'HANDLES_ROUTE',
          confidence: 1.0,
          reason: routeEvidence,
        });

        if (entry.handlerSymbol && /^[A-Za-z_$][\w$]*$/.test(entry.handlerSymbol)) {
          const leafName = handlerLeafName(entry.handlerSymbol);
          const localCandidates = (symbolNodesByFile.get(handlerPath) ?? []).filter(
            (node) => node.name === leafName,
          );
          if (localCandidates.length === 1) {
            const handler = localCandidates[0]!;
            ctx.graph.addRelationship({
              id: generateId('HANDLES_ROUTE', `${handler.id}->${routeNodeIdValue}`),
              sourceId: handler.id,
              targetId: routeNodeIdValue,
              type: 'HANDLES_ROUTE',
              confidence: 0.95,
              reason: `resolved-handler-symbol:${entry.handlerSymbol}|${routeEvidence}`,
            });
          }
        }
      }

      for (const route of provided?.routes ?? []) {
        if (!route.handlerNodeId) continue;
        const handler = ctx.graph.getNode(route.handlerNodeId);
        const targetId = routeNodeId(route.routePath, route.httpMethod);
        if (!handler || !ctx.graph.getNode(targetId)) throw new Error(`Route provider ${provider!.id} returned an invalid handler link`);
        ctx.graph.addRelationship({ id: generateId('HANDLES_ROUTE', `${handler.id}->${targetId}`),
          sourceId: handler.id, targetId, type: 'HANDLES_ROUTE', confidence: 1,
          reason: `route-provider:${provider!.id}` });
      }

      if (isDev) {
        console.log(
          `🗺️ Route registry: ${routeRegistry.size} routes${duplicateRoutes > 0 ? ` (${duplicateRoutes} duplicate URLs skipped)` : ''}`,
        );
      }
    }

    // ── Link Next.js project-level middleware.ts to routes ──
    if (routeRegistry.size > 0) {
      const middlewareCandidates = allPaths.filter(
        (p) =>
          p === 'middleware.ts' ||
          p === 'middleware.js' ||
          p === 'middleware.tsx' ||
          p === 'middleware.jsx' ||
          p === 'src/middleware.ts' ||
          p === 'src/middleware.js' ||
          p === 'src/middleware.tsx' ||
          p === 'src/middleware.jsx',
      );
      if (middlewareCandidates.length > 0) {
        const mwContents = await readFileContents(ctx.repoPath, middlewareCandidates);
        for (const [mwPath, mwContent] of mwContents) {
          const config = extractNextjsMiddlewareConfig(mwContent);
          if (!config) continue;
          const mwLabel =
            config.wrappedFunctions.length > 0 ? config.wrappedFunctions : [config.exportedName];

          const compiled = config.matchers
            .map(compileMatcher)
            .filter((m): m is NonNullable<typeof m> => m !== null);

          let linkedCount = 0;
          for (const entry of routeRegistry.values()) {
            const matches =
              compiled.length === 0 ||
              compiled.some((cm) => compiledMatcherMatchesRoute(cm, entry.routePath));
            if (!matches) continue;

            const existing = ctx.graph.getNode(routeNodeId(entry.routePath, entry.httpMethod));
            if (!existing) continue;

            const currentMw = existing.properties.middleware ?? [];
            existing.properties.middleware = [
              ...mwLabel,
              ...currentMw.filter((m) => !mwLabel.includes(m)),
            ];
            linkedCount++;
          }
          if (isDev && linkedCount > 0) {
            console.log(
              `🛡️ Linked ${mwPath} middleware [${mwLabel.join(', ')}] to ${linkedCount} routes`,
            );
          }
        }
      }
    }

    // Scan HTML/template files for form action and AJAX url patterns
    const htmlCandidates = allPaths.filter(
      (p) =>
        p.endsWith('.html') ||
        p.endsWith('.htm') ||
        p.endsWith('.ejs') ||
        p.endsWith('.hbs') ||
        p.endsWith('.blade.php'),
    );
    if (htmlCandidates.length > 0 && routeRegistry.size > 0) {
      const htmlContents = await readFileContents(ctx.repoPath, htmlCandidates);
      const htmlPatterns = [/action=["']([^"']+)["']/g, /url:\s*["']([^"']+)["']/g];
      for (const [filePath, content] of htmlContents) {
        for (const pattern of htmlPatterns) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const normalized = normalizeFetchURL(match[1]);
            if (normalized) {
              allFetchCalls.push({ filePath, fetchURL: normalized, lineNumber: 0 });
            }
          }
        }
      }
    }

    // ── Extract Expo Router navigation patterns ──
    if (expoAppPaths.size > 0 && routeRegistry.size > 0) {
      const unreadExpoPaths = [...expoAppPaths].filter((p) => !handlerContents?.has(p));
      const extraContents =
        unreadExpoPaths.length > 0
          ? await readFileContents(ctx.repoPath, unreadExpoPaths)
          : new Map<string, string>();
      const allExpoContents = new Map([...(handlerContents ?? new Map()), ...extraContents]);
      for (const [filePath, content] of allExpoContents) {
        if (!expoAppPaths.has(filePath)) continue;
        for (const pattern of EXPO_NAV_PATTERNS) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const url = match[2] ?? match[1];
            if (url && url.startsWith('/')) {
              allFetchCalls.push({ filePath, fetchURL: url, lineNumber: 0 });
            }
          }
        }
      }
    }

    if (routeRegistry.size > 0 && allFetchCalls.length > 0) {
      const consumerPaths = [...new Set(allFetchCalls.map((c) => c.filePath))];
      const consumerContents = await readFileContents(ctx.repoPath, consumerPaths);

      processNextjsFetchRoutes(ctx.graph, allFetchCalls, routeRegistry, consumerContents);
      if (isDev) {
        console.log(
          `🔗 Processed ${allFetchCalls.length} fetch() calls against ${routeRegistry.size} routes`,
        );
      }
    }

    return { routeRegistry };
  },
};
