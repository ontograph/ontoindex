import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { extractLaravelRoutes } from '../../src/core/ingestion/workers/route-extractor.js';

describe('extractLaravelRoutes', () => {
  it('does not overflow on very deep non-route syntax trees', () => {
    type TestNode = {
      type: string;
      text: string;
      children: TestNode[];
      startPosition: { row: number };
    };

    let root: TestNode = {
      type: 'program',
      text: '',
      children: [],
      startPosition: { row: 0 },
    };
    for (let i = 0; i < 20000; i++) {
      root = {
        type: 'block',
        text: '',
        children: [root],
        startPosition: { row: i },
      };
    }

    expect(
      extractLaravelRoutes({ rootNode: root } as unknown as Parser.Tree, 'routes/web.php'),
    ).toEqual([]);
  });

  it('extracts nested route groups without recursive traversal', () => {
    const parser = new Parser();
    parser.setLanguage(PHP.php);
    const code = `<?php
Route::prefix('api')->middleware('auth')->group(function () {
  Route::prefix('v1')->group(function () {
    Route::get('/users', [UserController::class, 'index']);
  });
});
`;

    const routes = extractLaravelRoutes(parser.parse(code), 'routes/web.php');

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      httpMethod: 'get',
      routePath: '/users',
      controllerName: 'UserController',
      methodName: 'index',
      middleware: ['auth'],
      prefix: 'api/v1',
    });
  });
});
