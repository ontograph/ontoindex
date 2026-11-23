import Parser from 'tree-sitter';
import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'ontoindex-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { extractFetchEvidence } from '../../src/core/ingestion/route-extractors/fetch-evidence.js';
import {
  routeNodeId,
  httpMethodFromRouteId,
} from '../../src/core/ingestion/route-extractors/route-identity.js';
import { fetchURLMatchesRoute } from '../../src/core/ingestion/route-extractors/nextjs.js';
import { processNextjsFetchRoutes } from '../../src/core/ingestion/call-resolution/route-processor.js';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import type { ExtractedFetchCall } from '../../src/core/ingestion/workers/parse-types.js';
import type { RouteEntry } from '../../src/core/ingestion/pipeline-phases/routes.js';

function visit(node: Parser.SyntaxNode, result: Parser.SyntaxNode[]): void {
  if (node.type === 'call_expression' && node.childForFieldName('function')?.text === 'fetch')
    result.push(node);
  node.namedChildren.forEach((child) => visit(child, result));
}

describe('fetch route evidence', () => {
  it('keeps literal, template, and explicit method evidence while rejecting dynamic option methods', async () => {
    const source = `
      fetch('/api/users/' + id, { method: 'post' });
      fetch(\`/api/items/\${id}\`, { method: 'patch' });
      fetch('/api/unknown', { [methodKey]: 'DELETE' });
      fetch('/api/unknown', { method });
      fetch('/api/unknown', { get method() { return 'POST'; } });
      fetch('/api/unknown', options);
      fetch('/api/default');
    `;
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fetch.ts', source);
    const tree = parser.parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    const calls: Parser.SyntaxNode[] = [];
    visit(tree.rootNode, calls);
    const evidence = calls.map((call) => extractFetchEvidence(call));
    expect(evidence).toEqual([
      { fetchURL: '/api/users/[param]', httpMethod: 'POST' },
      { fetchURL: '/api/items/[param]', httpMethod: 'PATCH' },
      { fetchURL: '/api/unknown' },
      { fetchURL: '/api/unknown' },
      { fetchURL: '/api/unknown' },
      { fetchURL: '/api/unknown' },
      { fetchURL: '/api/default', httpMethod: 'GET' },
    ]);
  });

  it('requires a dynamic client segment to match a dynamic provider segment', () => {
    expect(fetchURLMatchesRoute('/api/users/42', '/api/users/[id]')).toBe(true);
    expect(fetchURLMatchesRoute('/api/users/[param]', '/api/users/[id]')).toBe(true);
    expect(fetchURLMatchesRoute('/api/users/[param]', '/api/users')).toBe(false);
  });

  it('matches exact methods, marks uncertain candidates, and skips ambiguous methods', () => {
    const graph = createKnowledgeGraph();
    const routes = new Map<string, RouteEntry>([
      [
        'GET /api/users',
        { filePath: 'get.ts', source: 'framework', routePath: '/api/users', httpMethod: 'GET' },
      ],
      [
        'POST /api/users',
        { filePath: 'post.ts', source: 'framework', routePath: '/api/users', httpMethod: 'POST' },
      ],
      [
        'GET /api/users/[id]',
        {
          filePath: 'dynamic.ts',
          source: 'framework',
          routePath: '/api/users/[id]',
          httpMethod: 'GET',
        },
      ],
      [
        'GET /api/unique',
        { filePath: 'unique.ts', source: 'framework', routePath: '/api/unique', httpMethod: 'GET' },
      ],
    ]);
    const fetchCalls: ExtractedFetchCall[] = [
      { filePath: 'client.ts', fetchURL: '/api/users', httpMethod: 'GET', lineNumber: 0 },
      { filePath: 'client.ts', fetchURL: '/api/users', httpMethod: 'POST', lineNumber: 1 },
      { filePath: 'client.ts', fetchURL: '/api/users', lineNumber: 2 },
      { filePath: 'client.ts', fetchURL: '/api/users/[param]', httpMethod: 'GET', lineNumber: 3 },
      { filePath: 'uncertain.ts', fetchURL: '/api/unique', lineNumber: 4 },
    ];

    processNextjsFetchRoutes(graph, fetchCalls, routes);

    const edges = graph.relationships.filter((edge) => edge.type === 'FETCHES');
    expect(edges.map((edge) => edge.targetId).sort()).toEqual(
      [
        routeNodeId('/api/users', 'GET'),
        routeNodeId('/api/users', 'POST'),
        routeNodeId('/api/users/[id]', 'GET'),
        routeNodeId('/api/unique', 'GET'),
      ].sort(),
    );
    const exactGet = edges.find((edge) => edge.targetId === routeNodeId('/api/users', 'GET'))!;
    expect(exactGet.reason).toContain('request-method:GET');
    expect(exactGet.reason).not.toContain('method-unknown');
    const unknownCallEdge = edges.find(
      (edge) => edge.targetId === routeNodeId('/api/unique', 'GET'),
    )!;
    expect(unknownCallEdge.confidence).toBe(0.5);
    expect(unknownCallEdge.reason).toContain('method-unknown');
    expect(httpMethodFromRouteId(routeNodeId('/api/users', 'POST'))).toBe('POST');
    expect(httpMethodFromRouteId('Route:/api/users')).toBeUndefined();
  });

  it('keeps a path-only provider in another file as a possible match', () => {
    const graph = createKnowledgeGraph();
    const routes = new Map<string, RouteEntry>([
      [
        'POST /api/users',
        { filePath: 'post.ts', source: 'framework', routePath: '/api/users', httpMethod: 'POST' },
      ],
      ['/api/users', { filePath: 'legacy.php', source: 'php-file-route', routePath: '/api/users' }],
    ]);
    processNextjsFetchRoutes(
      graph,
      [{ filePath: 'client.ts', fetchURL: '/api/users', httpMethod: 'GET', lineNumber: 0 }],
      routes,
    );
    expect(graph.relationships.map((edge) => edge.targetId)).toEqual([routeNodeId('/api/users')]);
    expect(graph.relationships[0]?.reason).toContain('path-only-route');
  });
});
