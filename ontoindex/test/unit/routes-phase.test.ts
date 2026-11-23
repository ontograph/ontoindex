import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';
import { routeNodeId } from '../../src/core/ingestion/route-extractors/route-identity.js';
import { routesPhase } from '../../src/core/ingestion/pipeline-phases/routes.js';
import type { ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';

describe('routesPhase', () => {
  let repoDir = '';

  afterEach(async () => {
    if (repoDir) {
      await fs.rm(repoDir, { recursive: true, force: true });
      repoDir = '';
    }
  });

  it('retains response and middleware evidence for file-based routes', async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-file-route-'));
    await fs.mkdir(path.join(repoDir, 'api'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'api/users.php'),
      "<?php echo json_encode(['users' => []]);",
    );
    await fs.mkdir(path.join(repoDir, 'app/api/items'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'app/api/items/route.ts'),
      'export const GET = withAuth(handler);',
    );
    const graph = createKnowledgeGraph();
    const parseOutput = {
      allPaths: ['api/users.php', 'app/api/items/route.ts'],
      allFetchCalls: [],
      allExtractedRoutes: [],
      allDecoratorRoutes: [],
    } as unknown as ParseOutput;
    await routesPhase.execute(
      { repoPath: repoDir, graph, onProgress: () => {}, pipelineStart: Date.now() },
      new Map([['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }]]),
    );
    expect(graph.getNode(routeNodeId('/api/users'))?.properties.responseKeys).toEqual(['users']);
    expect(graph.getNode(routeNodeId('/api/items'))?.properties.middleware).toEqual(['withAuth']);
  });

  it('chooses duplicate route handlers deterministically across parse order', async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-route-order-'));
    for (const file of ['a.ts', 'z.ts']) await fs.writeFile(path.join(repoDir, file), '');

    const frameworkRoutes = ['z.ts', 'a.ts'].map((filePath) => ({
      filePath,
      routePath: '/framework',
      httpMethod: 'GET',
      lineNumber: 1,
      controllerName: null,
      methodName: null,
      middleware: [],
      prefix: null,
      responseKeys: [filePath],
      errorKeys: [filePath],
    }));
    const decoratorRoutes = ['z.ts', 'a.ts'].map((filePath) => ({
      filePath,
      routePath: '/decorator',
      httpMethod: 'GET',
      lineNumber: 1,
      decoratorName: 'express.get',
      responseKeys: [filePath],
      errorKeys: [filePath],
    }));
    const run = async (reverse: boolean) => {
      const graph = createKnowledgeGraph();
      const parseOutput = {
        allPaths: ['a.ts', 'z.ts'],
        allFetchCalls: [],
        allExtractedRoutes: reverse ? [...frameworkRoutes].reverse() : frameworkRoutes,
        allDecoratorRoutes: reverse ? [...decoratorRoutes].reverse() : decoratorRoutes,
      } as unknown as ParseOutput;
      await routesPhase.execute(
        { repoPath: repoDir, graph, onProgress: () => {}, pipelineStart: Date.now() },
        new Map([['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }]]),
      );
      return {
        nodes: ['/framework', '/decorator'].map(
          (url) => graph.getNode(routeNodeId(url, 'GET'))?.properties,
        ),
        edges: graph.relationships.filter((rel) => rel.type === 'HANDLES_ROUTE'),
      };
    };

    const forward = await run(false);
    expect(await run(true)).toEqual(forward);
    for (const node of forward.nodes) {
      expect(node?.filePath).toBe('a.ts');
      expect(node?.responseKeys).toEqual(['a.ts', 'z.ts']);
      expect(node?.errorKeys).toEqual(['a.ts', 'z.ts']);
    }
    expect(forward.edges).toHaveLength(2);
    expect(forward.edges.every((edge) => edge.sourceId === generateId('File', 'a.ts'))).toBe(true);
  });

  it('keeps same-path methods separate and links only unique handler symbols', async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-route-methods-'));
    await fs.writeFile(path.join(repoDir, 'server.ts'), 'export function getUser() {}\n');
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:server.ts:getUser',
      label: 'Function',
      properties: { name: 'getUser', filePath: 'server.ts' },
    });
    graph.addNode({
      id: 'Function:server.ts:createUser',
      label: 'Function',
      properties: { name: 'createUser', filePath: 'server.ts' },
    });
    const parseOutput = {
      allPaths: [],
      allFetchCalls: [],
      allExtractedRoutes: [],
      allDecoratorRoutes: [
        {
          filePath: 'server.ts',
          routePath: '/users',
          httpMethod: 'GET',
          decoratorName: 'route.get',
          handlerSymbol: 'getUser',
          lineNumber: 0,
        },
        {
          filePath: 'server.ts',
          routePath: '/users',
          httpMethod: 'POST',
          decoratorName: 'route.post',
          handlerSymbol: 'createUser',
          lineNumber: 1,
        },
      ],
    } as unknown as ParseOutput;

    const output = await routesPhase.execute(
      { repoPath: repoDir, graph, onProgress: () => {}, pipelineStart: Date.now() },
      new Map([['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }]]),
    );
    expect([...output.routeRegistry.keys()].sort()).toEqual(['GET /users', 'POST /users']);
    expect(graph.getNode(routeNodeId('/users', 'GET'))?.properties.httpMethod).toBe('GET');
    expect(graph.getNode(routeNodeId('/users', 'POST'))?.properties.httpMethod).toBe('POST');
    expect(
      graph.relationships
        .filter((rel) => rel.type === 'HANDLES_ROUTE' && rel.sourceId.startsWith('Function:'))
        .map((rel) => [rel.sourceId, rel.targetId])
        .sort(),
    ).toEqual([
      ['Function:server.ts:createUser', routeNodeId('/users', 'POST')],
      ['Function:server.ts:getUser', routeNodeId('/users', 'GET')],
    ]);
  });

  it('annotates route nodes and HANDLES_ROUTE edges with active route model packs', async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-routes-phase-'));
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/framework-models'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/framework-models/pack.yml'),
      [
        'schema: 1',
        'id: core.framework-models',
        'name: Framework Models',
        'version: 0.1.0',
        'kind: model',
        'tier: experimental',
        'summary: Route model fixture.',
        'provides:',
        '  - route-models',
        'runs: []',
      ].join('\n'),
      'utf8',
    );

    const handlerPath = 'app/api/users/route.ts';
    await fs.mkdir(path.join(repoDir, 'app/api/users'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, handlerPath),
      'export async function GET() { return Response.json({ users: [] }); }\n',
      'utf8',
    );

    let releaseCalls = 0;
    const parseOutput = {
      exportedTypeMap: new Map(),
      allFetchCalls: [],
      allExtractedRoutes: [
        {
          filePath: handlerPath,
          httpMethod: 'GET',
          routePath: '/api/users',
          controllerName: null,
          methodName: null,
          middleware: [],
          prefix: null,
          lineNumber: 1,
          responseKeys: ['users'],
        },
      ],
      allDecoratorRoutes: [],
      allToolDefs: [],
      allORMQueries: [],
      bindingAccumulator: {} as any,
      resolutionContext: {} as any,
      allPaths: [handlerPath],
      allPathSet: new Set([handlerPath]),
      totalFiles: 1,
      usedWorkerPool: false,
      releaseRouteExtractionData: () => {
        releaseCalls++;
      },
    } as unknown as ParseOutput;

    const graph = createKnowledgeGraph();
    await routesPhase.execute(
      {
        repoPath: repoDir,
        graph,
        onProgress: () => {},
        options: undefined,
        pipelineStart: Date.now(),
      },
      new Map([['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }]]),
    );

    const routeNode = graph.getNode(routeNodeId('/api/users', 'GET'));
    expect(routeNode?.properties.modelPacks).toEqual(['core.framework-models']);
    expect(routeNode?.properties.responseKeys).toEqual(['users']);

    const handleRel = graph.relationships.find((rel) => rel.type === 'HANDLES_ROUTE');
    expect(handleRel?.reason).toContain('model-packs:core.framework-models');
    expect(releaseCalls).toBe(1);
  });

  it('copies and unions handler evidence before release without scanning unrelated file responses', async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-route-shapes-'));
    await fs.writeFile(
      path.join(repoDir, 'server.ts'),
      'function unrelated() { return Response.json({ leaked: true }); }',
    );
    const getKeys = ['first'];
    const postKeys = ['second', 'first'];
    const errorKeys = ['invalid'];
    const parseOutput = {
      allPaths: ['server.ts'],
      allFetchCalls: [],
      allExtractedRoutes: [],
      allDecoratorRoutes: [
        {
          filePath: 'server.ts',
          routePath: '/one',
          httpMethod: 'GET',
          decoratorName: 'express.get',
          lineNumber: 0,
          responseKeys: getKeys,
        },
        {
          filePath: 'server.ts',
          routePath: '/one',
          httpMethod: 'POST',
          decoratorName: 'express.post',
          lineNumber: 0,
          responseKeys: postKeys,
          errorKeys,
        },
        {
          filePath: 'server.ts',
          routePath: '/unknown',
          httpMethod: 'GET',
          decoratorName: 'express.get',
          lineNumber: 0,
        },
      ],
      releaseRouteExtractionData: () => {
        getKeys.length = 0;
        postKeys.length = 0;
        errorKeys.length = 0;
      },
    } as unknown as ParseOutput;
    const graph = createKnowledgeGraph();
    await routesPhase.execute(
      { repoPath: repoDir, graph, onProgress: () => {}, pipelineStart: Date.now() },
      new Map([['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }]]),
    );
    expect(graph.getNode(routeNodeId('/one', 'GET'))?.properties.responseKeys).toEqual(['first']);
    expect(graph.getNode(routeNodeId('/one', 'GET'))?.properties.errorKeys).toBeUndefined();
    expect(graph.getNode(routeNodeId('/one', 'POST'))?.properties.responseKeys).toEqual([
      'second',
      'first',
    ]);
    expect(graph.getNode(routeNodeId('/one', 'POST'))?.properties.errorKeys).toEqual(['invalid']);
    expect(graph.getNode(routeNodeId('/unknown', 'GET'))?.properties.responseKeys).toBeUndefined();
  });
});
