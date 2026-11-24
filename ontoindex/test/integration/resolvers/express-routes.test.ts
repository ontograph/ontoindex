import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Express/Hono route detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'express-route-mapping'), () => {});
  }, 60000);

  it('creates Route nodes for Express endpoints in TypeScript', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/users');
    expect(routes).toContain('/api/users/:id');
    expect(routes).toContain('/api/health');
  });

  it('creates Route nodes for Express endpoints in JavaScript', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/items');
  });

  it('creates HANDLES_ROUTE edges from handler files to Route nodes', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    expect(edges.length).toBeGreaterThanOrEqual(4);

    const usersRoute = edges.find((e) => e.target === '/api/users');
    expect(usersRoute).toBeDefined();
    expect(usersRoute!.sourceFilePath).toContain('server.ts');

    const itemsRoute = edges.find((e) => e.target === '/api/items');
    expect(itemsRoute).toBeDefined();
    expect(itemsRoute!.sourceFilePath).toContain('app.js');
  });

  it('keeps each HTTP method on the same path as a distinct route', () => {
    const usersRoutes = getNodesByLabelFull(result, 'Route').filter((r) => r.name === '/api/users');
    expect(usersRoutes.map((route) => route.properties.httpMethod).sort()).toEqual(['GET', 'POST']);
  });

  it('keeps response shapes scoped to the route method', () => {
    const route = (url: string, method: string) =>
      getNodesByLabelFull(result, 'Route').find(
        (node) => node.name === url && node.properties.httpMethod === method,
      );
    expect(route('/api/users', 'GET')?.properties.responseKeys).toEqual(['users']);
    expect(route('/api/users', 'POST')?.properties.responseKeys).toEqual(['id', 'created']);
    expect(route('/api/users/:id', 'PUT')?.properties.responseKeys).toEqual(['updated']);
    expect(route('/api/users/:id', 'DELETE')?.properties.responseKeys).toEqual(['deleted']);
    expect(route('/api/health', 'GET')?.properties.responseKeys).toEqual(['status']);
    expect(route('/api/items', 'GET')?.properties.responseKeys).toEqual(['items']);
    expect(route('/api/items', 'POST')?.properties.responseKeys).toEqual(['created']);
  });

  it('detects router.get() routes (not just app.get())', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/health');

    const edges = getRelationships(result, 'HANDLES_ROUTE');
    const healthEdge = edges.find((e) => e.target === '/api/health');
    expect(healthEdge).toBeDefined();
    expect(healthEdge!.sourceFilePath).toContain('server.ts');
  });
});
