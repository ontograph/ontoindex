import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';
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
    const parseOutput: ParseOutput = {
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
    };

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

    const routeNode = graph.getNode(generateId('Route', '/api/users'));
    expect(routeNode?.properties.modelPacks).toEqual(['core.framework-models']);

    const handleRel = graph.relationships.find((rel) => rel.type === 'HANDLES_ROUTE');
    expect(handleRel?.reason).toContain('model-packs:core.framework-models');
    expect(releaseCalls).toBe(1);
  });
});
