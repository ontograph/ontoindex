import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KnowledgeGraph } from '../graph/types.js';
import type { ExtractedFetchCall } from './workers/parse-types.js';

/** An explicitly configured local module is trusted code and runs during indexing. */
export interface RouteProviderContext {
  repoPath: string;
  allPaths: readonly string[];
  graph: KnowledgeGraph;
  readFiles(paths: string[]): Promise<Map<string, string>>;
}

export interface ProvidedRoute {
  routePath: string;
  filePath: string;
  source: string;
  httpMethod?: string;
  handlerSymbol?: string;
  handlerNodeId?: string;
  middleware?: string[];
  responseKeys?: string[];
  errorKeys?: string[];
}

export interface RouteProviderResult {
  routes: ProvidedRoute[];
  consumers?: ExtractedFetchCall[];
  warnings?: string[];
}

export interface RouteProvider {
  apiVersion: 1;
  id: string;
  collect(context: RouteProviderContext): Promise<RouteProviderResult>;
}

export async function loadRouteProvider(modulePath = process.env.ONTOINDEX_ROUTE_PROVIDER): Promise<RouteProvider | undefined> {
  if (!modulePath) return undefined;
  if (!path.isAbsolute(modulePath)) throw new Error('ONTOINDEX_ROUTE_PROVIDER must be an absolute path');
  const module = await import(pathToFileURL(modulePath).href);
  const provider: RouteProvider = module.default;
  if (!provider || provider.apiVersion !== 1 || typeof provider.id !== 'string' || !provider.id || typeof provider.collect !== 'function') {
    throw new Error(`Invalid route provider: ${modulePath}`);
  }
  return provider;
}
