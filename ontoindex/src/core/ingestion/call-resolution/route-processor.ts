import { KnowledgeGraph } from '../../graph/types.js';
import { ResolutionContext, TIER_CONFIDENCE } from '../model/resolution-context.js';
import { generateId } from '../../../lib/utils.js';
import { yieldToEventLoop } from '../utils/event-loop.js';
import { ExtractedRoute, ExtractedFetchCall } from '../workers/parse-worker.js';
import { fetchURLMatchesRoute, normalizeFetchURL } from '../route-extractors/nextjs.js';
import { routeNodeId } from '../route-extractors/route-identity.js';
import type { RouteEntry } from '../pipeline-phases/routes.js';

/** Common method names on response/data objects that are NOT property accesses */
const RESPONSE_ACCESS_BLOCKLIST = new Set([
  'json',
  'text',
  'blob',
  'arrayBuffer',
  'formData',
  'ok',
  'status',
  'headers',
  'clone',
  'then',
  'catch',
  'finally',
  'map',
  'filter',
  'forEach',
  'reduce',
  'find',
  'some',
  'every',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'concat',
  'join',
  'sort',
  'reverse',
  'includes',
  'indexOf',
  'length',
  'toString',
  'valueOf',
  'keys',
  'values',
  'entries',
  'appendChild',
  'removeChild',
  'insertBefore',
  'replaceChild',
  'replaceChildren',
  'createElement',
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'setAttribute',
  'getAttribute',
  'removeAttribute',
  'hasAttribute',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'classList',
  'className',
  'parentNode',
  'parentElement',
  'childNodes',
  'children',
  'nextSibling',
  'previousSibling',
  'firstChild',
  'lastChild',
  'click',
  'focus',
  'blur',
  'submit',
  'reset',
  'innerHTML',
  'outerHTML',
  'textContent',
  'innerText',
]);

export const extractConsumerAccessedKeys = (content: string): string[] => {
  const keys = new Set<string>();
  const destructurePattern =
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:await\s+)?(?:\w+\.json\s*\(\)|(?:await\s+)?(?:fetch|axios|got)\s*\([^)]*\)(?:\.then\s*\([^)]*\))?(?:\.json\s*\(\))?)/g;
  let match;
  while ((match = destructurePattern.exec(content)) !== null) {
    const destructuredBody = match[1];
    const keyPattern = /(\w+)\s*(?::\s*\w+)?/g;
    let keyMatch;
    while ((keyMatch = keyPattern.exec(destructuredBody)) !== null) {
      keys.add(keyMatch[1]);
    }
  }

  const dataVarDestructure =
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:data|result|response|json|body|res)\b/g;
  while ((match = dataVarDestructure.exec(content)) !== null) {
    const destructuredBody = match[1];
    const keyPattern = /(\w+)\s*(?::\s*\w+)?/g;
    let keyMatch;
    while ((keyMatch = keyPattern.exec(destructuredBody)) !== null) {
      keys.add(keyMatch[1]);
    }
  }

  const propAccessPattern = /\b(?:data|response|result|json|body|res)\s*(?:\?\.|\.)(\w+)/g;
  while ((match = propAccessPattern.exec(content)) !== null) {
    const key = match[1];
    if (!RESPONSE_ACCESS_BLOCKLIST.has(key)) {
      keys.add(key);
    }
  }
  return [...keys];
};

/**
 * Resolve pre-extracted Laravel routes to CALLS edges from route files to controller methods.
 */
export const processRoutesFromExtracted = async (
  graph: KnowledgeGraph,
  extractedRoutes: ExtractedRoute[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
) => {
  for (let i = 0; i < extractedRoutes.length; i++) {
    const route = extractedRoutes[i];
    if (i % 50 === 0) {
      onProgress?.(i, extractedRoutes.length);
      await yieldToEventLoop();
    }

    if (!route.controllerName || !route.methodName) continue;

    const controllerResolved = ctx.resolve(route.controllerName, route.filePath);
    if (!controllerResolved || controllerResolved.candidates.length === 0) continue;
    if (controllerResolved.tier === 'global' && controllerResolved.candidates.length > 1) continue;

    const controllerDef = controllerResolved.candidates[0];
    const confidence = TIER_CONFIDENCE[controllerResolved.tier];

    const methodResolved = ctx.resolve(route.methodName, controllerDef.filePath);
    const methodId =
      methodResolved?.tier === 'same-file' ? methodResolved.candidates[0]?.nodeId : undefined;
    const sourceId = generateId('File', route.filePath);

    if (!methodId) {
      const guessedId = generateId('Method', `${controllerDef.filePath}:${route.methodName}`);
      const relId = generateId('CALLS', `${sourceId}:route->${guessedId}`);
      graph.addRelationship({
        id: relId,
        sourceId,
        targetId: guessedId,
        type: 'CALLS',
        confidence: confidence * 0.8,
        reason: 'laravel-route',
      });
      continue;
    }

    const relId = generateId('CALLS', `${sourceId}:route->${methodId}`);
    graph.addRelationship({
      id: relId,
      sourceId,
      targetId: methodId,
      type: 'CALLS',
      confidence,
      reason: 'laravel-route',
    });
  }
  onProgress?.(extractedRoutes.length, extractedRoutes.length);
};

/**
 * Create FETCHES edges from extracted fetch() calls to matching Route nodes.
 */
export const processNextjsFetchRoutes = (
  graph: KnowledgeGraph,
  fetchCalls: ExtractedFetchCall[],
  routeRegistry: ReadonlyMap<string, Pick<RouteEntry, 'filePath' | 'routePath' | 'httpMethod'>>,
  consumerContents?: Map<string, string>, // filePath → file content
) => {
  const routeCountByFile = new Map<string, number>();
  const matchingRoutes = (call: ExtractedFetchCall) => {
    const normalized = normalizeFetchURL(call.fetchURL);
    if (!normalized) return [];
    const matches = [...routeRegistry.values()].filter((route) =>
      fetchURLMatchesRoute(normalized, route.routePath),
    );
    const method = call.httpMethod?.toUpperCase();
    const explicitMethods = matches.filter((route) => route.httpMethod);
    const pathOnly = matches.filter((route) => !route.httpMethod);
    const explicitMethodMatches = explicitMethods.filter(
      (route) => route.httpMethod?.toUpperCase() === method,
    );
    if (method) return [...explicitMethodMatches, ...pathOnly];
    if (explicitMethods.length === 1) return [...explicitMethods, ...pathOnly];
    return pathOnly;
  };
  for (const call of fetchCalls) {
    if (matchingRoutes(call).length > 0)
      routeCountByFile.set(call.filePath, (routeCountByFile.get(call.filePath) ?? 0) + 1);
  }

  const edgeEvidence = new Map<
    string,
    {
      sourceId: string;
      targetId: string;
      filePath: string;
      confidence: number;
      methodUnknown: boolean;
      knownMethodMatch: boolean;
      pathOnly: boolean;
      dynamicURL: boolean;
      accessedKeys: string[];
      requestMethods: Set<string>;
    }
  >();
  for (const call of fetchCalls) {
    const normalized = normalizeFetchURL(call.fetchURL);
    if (!normalized) continue;
    const sourceId = generateId('File', call.filePath);
    const accessedKeys = consumerContents?.get(call.filePath)
      ? extractConsumerAccessedKeys(consumerContents.get(call.filePath)!)
      : [];
    const dynamicURL = normalized.includes('[param]');
    for (const route of matchingRoutes(call)) {
      const targetId = routeNodeId(route.routePath, route.httpMethod);
      const id = generateId('FETCHES', `${sourceId}->${targetId}`);
      const methodUnknown = Boolean(route.httpMethod && !call.httpMethod);
      const pathOnly = !route.httpMethod;
      let confidence = 0.9;
      if (methodUnknown) confidence = Math.min(confidence, 0.5);
      if (pathOnly) confidence = Math.min(confidence, 0.65);
      if (dynamicURL) confidence = Math.min(confidence, 0.65);
      const existing = edgeEvidence.get(id);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, confidence);
        existing.methodUnknown ||= methodUnknown;
        existing.knownMethodMatch ||= Boolean(
          call.httpMethod && call.httpMethod.toUpperCase() === route.httpMethod?.toUpperCase(),
        );
        existing.pathOnly ||= pathOnly;
        existing.dynamicURL ||= dynamicURL;
        if (call.httpMethod) existing.requestMethods.add(call.httpMethod.toUpperCase());
        for (const key of accessedKeys) {
          if (!existing.accessedKeys.includes(key)) existing.accessedKeys.push(key);
        }
      } else {
        edgeEvidence.set(id, {
          sourceId,
          targetId,
          filePath: call.filePath,
          confidence,
          methodUnknown,
          knownMethodMatch: Boolean(
            call.httpMethod && call.httpMethod.toUpperCase() === route.httpMethod?.toUpperCase(),
          ),
          pathOnly,
          dynamicURL,
          accessedKeys: [...accessedKeys],
          requestMethods: new Set(call.httpMethod ? [call.httpMethod.toUpperCase()] : []),
        });
      }
    }
  }

  for (const [id, evidence] of edgeEvidence) {
    const fetchCount = routeCountByFile.get(evidence.filePath) ?? 0;
    const reason = [
      'fetch-url-match',
      ...(evidence.requestMethods.size === 1
        ? [`request-method:${[...evidence.requestMethods][0]}`]
        : evidence.requestMethods.size > 1
          ? [`request-methods:${[...evidence.requestMethods].sort().join(',')}`]
          : []),
      ...(evidence.methodUnknown && !evidence.knownMethodMatch ? ['method-unknown'] : []),
      ...(evidence.pathOnly ? ['path-only-route'] : []),
      ...(evidence.dynamicURL ? ['dynamic-url'] : []),
      ...(evidence.accessedKeys.length > 0 ? [`keys:${evidence.accessedKeys.join(',')}`] : []),
      ...(fetchCount > 1 ? [`fetches:${fetchCount}`] : []),
    ].join('|');
    graph.addRelationship({
      id,
      sourceId: evidence.sourceId,
      targetId: evidence.targetId,
      type: 'FETCHES',
      confidence: evidence.confidence,
      reason,
    });
  }
};
