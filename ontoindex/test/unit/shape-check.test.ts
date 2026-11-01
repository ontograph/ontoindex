import { describe, it, expect } from 'vitest';
import { extractResponseShapes } from '../../src/core/ingestion/route-extractors/response-shapes.js';
import { extractConsumerAccessedKeys } from '../../src/core/ingestion/call-processor.js';
import {
  createRouteResponseShapeExtractor,
  extractNextjsRouteShapes,
} from '../../src/core/ingestion/route-extractors/response-shapes.js';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from 'ontoindex-shared';

describe('handler-owned AST response shapes', () => {
  it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
    'isolates inline and lexically resolved handlers in %s',
    async (language) => {
      const parser = await createParserForLanguage(language);
      const tree = parser.parse(
        [
          "import imported from './handlers';",
          'function named(req, res) { function unused() { res.json({ hidden: true }); }',
          '  // res.json({ comment: true });',
          '  const text = "res.json({ stringKey: true })";',
          '  if (req.bad) return res.status(400).json({ error: "bad" });',
          '  return res.json({ namedKey: true, "quoted-key": 1, shorthand, nested: { excluded: 1 } }); }',
          'app.get("/one", (req, res) => res.json({ one: 1 })); app.get("/two", (req, res) => res.json({ two: 2 }));',
          'app.get("/named", named); app.get("/imported", imported);',
          'function scope(named) { app.get("/shadowed", named); }',
          '{ const named = (req, res) => res.json({ local: true }); app.get("/local", named); }',
          'app.get("/named-again", named);',
        ].join('\n'),
      );
      expect(tree.rootNode.hasError).toBe(false);
      const extract = createRouteResponseShapeExtractor(tree.rootNode);
      const shapes = tree.rootNode
        .descendantsOfType('call_expression')
        .filter((node) => node.childForFieldName('function')?.text === 'app.get')
        .map((node) => extract(node.childForFieldName('arguments')!.namedChildren.at(-1)));
      const namedShape = {
        responseKeys: ['namedKey', 'quoted-key', 'shorthand', 'nested'],
        errorKeys: ['error'],
      };
      expect(shapes).toEqual([
        { responseKeys: ['one'] },
        { responseKeys: ['two'] },
        namedShape,
        {},
        {},
        { responseKeys: ['local'] },
        namedShape,
      ]);
    },
  );

  it('collects only exported Next.js handlers, including local default and aliased handlers', async () => {
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript);
    const tree = parser.parse(
      [
        'function helper() { return Response.json({ helperOnly: true }); }',
        'export function GET() { return Response.json({ items: [] }); }',
        'const post = () => Response.json({ failure: true }, { status: 422 });',
        'export { post as POST };',
      ].join('\n'),
    );
    const routes = extractNextjsRouteShapes(
      tree.rootNode,
      'app/api/items/route.ts',
      createRouteResponseShapeExtractor(tree.rootNode),
    );
    expect(
      routes.map(({ httpMethod, responseKeys, errorKeys }) => ({
        httpMethod,
        responseKeys,
        errorKeys,
      })),
    ).toEqual([
      { httpMethod: 'GET', responseKeys: ['items'], errorKeys: undefined },
      { httpMethod: 'POST', responseKeys: undefined, errorKeys: ['failure'] },
    ]);
    const page = parser.parse(
      'function helper() { return Response.json({ leak: 1 }); } const handler = () => Response.json({ page: 1 }); export default handler;',
    );
    expect(
      extractNextjsRouteShapes(
        page.rootNode,
        'pages/api/items.ts',
        createRouteResponseShapeExtractor(page.rootNode),
      )[0].responseKeys,
    ).toEqual(['page']);
  });

  it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
    'omits reassigned exported and destructured handlers without invalidating property names in %s',
    async (language) => {
      const parser = await createParserForLanguage(language);
      const tree = parser.parse(
        [
          "import importedHandler from './handlers';",
          'export function GET() { return Response.json({ staleGet: 1 }); }',
          'GET = importedHandler;',
          'function handler(req, res) { return res.json({ staleArray: 1 }); }',
          '[handler] = importedHandlers;',
          'function objectHandler(req, res) { return res.json({ staleObject: 1 }); }',
          'function unaffected(req, res) { return res.json({ kept: 1 }); }',
          '({ unaffected: objectHandler } = importedHandlers);',
          'unaffected.property = importedHandler;',
          'app.get("/array", handler); app.get("/object", objectHandler); app.get("/control", unaffected);',
          'export function POST() { return Response.json({ keptPost: 1 }); }',
        ].join('\n'),
      );
      expect(tree.rootNode.hasError).toBe(false);
      const extract = createRouteResponseShapeExtractor(tree.rootNode);
      expect(
        tree.rootNode
          .descendantsOfType('call_expression')
          .filter((node) => node.childForFieldName('function')?.text === 'app.get')
          .map((node) => extract(node.childForFieldName('arguments')!.namedChildren.at(-1))),
      ).toEqual([{}, {}, { responseKeys: ['kept'] }]);
      expect(
        extractNextjsRouteShapes(tree.rootNode, 'app/api/items/route.ts', extract).map(
          ({ httpMethod, responseKeys }) => ({ httpMethod, responseKeys }),
        ),
      ).toEqual([
        { httpMethod: 'GET', responseKeys: undefined },
        { httpMethod: 'POST', responseKeys: ['keptPost'] },
      ]);
    },
  );

  it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
    'invalidates assignment-form loop targets, including destructuring, in %s',
    async (language) => {
      const parser = await createParserForLanguage(language);
      for (const header of [
        'handler of handlers',
        'handler in handlers',
        '[handler] of handlers',
        '{ handler } of handlers',
        '{ value: handler } of handlers',
      ]) {
        const tree = parser.parse(
          [
            'function handler(req, res) { return res.json({ stale: 1 }); }',
            `for (${header}) {}`,
            'app.get("/items", handler);',
          ].join('\n'),
        );
        expect(tree.rootNode.hasError).toBe(false);
        const call = tree.rootNode
          .descendantsOfType('call_expression')
          .find((node) => node.childForFieldName('function')?.text === 'app.get')!;
        expect(
          createRouteResponseShapeExtractor(tree.rootNode)(
            call.childForFieldName('arguments')!.namedChildren.at(-1),
          ),
        ).toEqual({});
      }
    },
  );

  it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
    'keeps var loop bindings in the nearest function and let/const bindings local in %s',
    async (language) => {
      const parser = await createParserForLanguage(language);
      const tree = parser.parse(
        [
          'function outer(req, res) { return res.json({ outer: 1 }); }',
          'function local() {',
          '  function handler(req, res) { return res.json({ stale: 1 }); }',
          '  for (var handler of handlers) {}',
          '  app.get("/var", handler);',
          '  for (var outer in handlers) {}',
          '  app.get("/function-var", outer);',
          '}',
          'for (let outer of handlers) {}',
          'for (const outer in handlers) {}',
          'for (let [outer] of handlers) {}',
          'app.get("/outer", outer);',
          'function topLevel(req, res) { return res.json({ staleTopLevel: 1 }); }',
          'for (var topLevel in handlers) {}',
          'app.get("/top-level-var", topLevel);',
        ].join('\n'),
      );
      expect(tree.rootNode.hasError).toBe(false);
      const extract = createRouteResponseShapeExtractor(tree.rootNode);
      expect(
        tree.rootNode
          .descendantsOfType('call_expression')
          .filter((node) => node.childForFieldName('function')?.text === 'app.get')
          .map((node) => extract(node.childForFieldName('arguments')!.namedChildren.at(-1))),
      ).toEqual([{}, {}, { responseKeys: ['outer'] }, {}]);
    },
  );

  it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
    'resolves writes by binding after collecting shadowing declarations in %s',
    async (language) => {
      const parser = await createParserForLanguage(language);
      const tree = parser.parse(
        [
          'function handler(req, res) { return res.json({ kept: 1 }); }',
          'function parameterShadow(handler) { handler = replacement; for (handler of handlers) {} }',
          'function hoistedShadow() { handler = replacement; var handler; }',
          '{ handler = replacement; let handler; }',
          '{ let handler = (req, res) => res.json({ localStale: 1 });',
          '  handler = replacement; app.get("/local", handler); }',
          'app.get("/outer", handler);',
          'function closureHandler(req, res) { return res.json({ stale: 1 }); }',
          'function closure() { closureHandler = replacement; }',
          'app.get("/closure", closureHandler);',
          'function loopClosureHandler(req, res) { return res.json({ loopStale: 1 }); }',
          'function loopClosure() { for (loopClosureHandler of handlers) {} }',
          'app.get("/loop-closure", loopClosureHandler);',
        ].join('\n'),
      );
      expect(tree.rootNode.hasError).toBe(false);
      const extract = createRouteResponseShapeExtractor(tree.rootNode);
      expect(
        tree.rootNode
          .descendantsOfType('call_expression')
          .filter((node) => node.childForFieldName('function')?.text === 'app.get')
          .map((node) => extract(node.childForFieldName('arguments')!.namedChildren.at(-1))),
      ).toEqual([{}, { responseKeys: ['kept'] }, {}, {}]);
    },
  );

  it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
    'refuses parameter-initializer writes hidden by body declarations in %s',
    async (language) => {
      const parser = await createParserForLanguage(language);
      const tree = parser.parse(
        [
          'export function GET() { return Response.json({ stale: 1 }); }',
          'function initialize(arg = (GET = replacement)) { var GET; }',
          'function named(req, res) { return res.json({ stale: 1 }); }',
          'function nested(arg = (() => { named = replacement; })) { var named; }',
          'function destructured(req, res) { return res.json({ stale: 1 }); }',
          'function destructure(arg = ({ destructured } = source)) { var destructured; }',
          'function kept(req, res) { return res.json({ kept: 1 }); }',
          'app.get("/named", named); app.get("/destructured", destructured);',
          'app.get("/kept", kept);',
        ].join('\n'),
      );
      expect(tree.rootNode.hasError).toBe(false);
      const extract = createRouteResponseShapeExtractor(tree.rootNode);
      expect(
        extractNextjsRouteShapes(tree.rootNode, 'app/api/items/route.ts', extract).map(
          ({ httpMethod, responseKeys }) => ({ httpMethod, responseKeys }),
        ),
      ).toEqual([{ httpMethod: 'GET', responseKeys: undefined }]);
      expect(
        tree.rootNode
          .descendantsOfType('call_expression')
          .filter((node) => node.childForFieldName('function')?.text === 'app.get')
          .map((node) => extract(node.childForFieldName('arguments')!.namedChildren.at(-1))),
      ).toEqual([{}, {}, { responseKeys: ['kept'] }]);
    },
  );

  it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
    'uses binding-owned writes for exported Next.js declarations in %s',
    async (language) => {
      const parser = await createParserForLanguage(language);
      const tree = parser.parse(
        [
          'export function GET() { return Response.json({ kept: 1 }); }',
          'function parameterShadow(GET) { GET = replacement; }',
          'function hoistedShadow() { GET = replacement; var GET; }',
          '{ GET = replacement; let GET; }',
          'export function POST() { return Response.json({ stalePost: 1 }); }',
          'function closure() { POST = replacement; }',
          'export function PUT() { return Response.json({ stalePut: 1 }); }',
          'for (PUT of handlers) {}',
          'export function PATCH() { return Response.json({ stalePatch: 1 }); }',
          'for (var PATCH in handlers) {}',
        ].join('\n'),
      );
      expect(tree.rootNode.hasError).toBe(false);
      expect(
        extractNextjsRouteShapes(
          tree.rootNode,
          'app/api/items/route.ts',
          createRouteResponseShapeExtractor(tree.rootNode),
        ).map(({ httpMethod, responseKeys }) => ({ httpMethod, responseKeys })),
      ).toEqual([
        { httpMethod: 'GET', responseKeys: ['kept'] },
        { httpMethod: 'POST', responseKeys: undefined },
        { httpMethod: 'PUT', responseKeys: undefined },
        { httpMethod: 'PATCH', responseKeys: undefined },
      ]);
    },
  );
});

describe('extractResponseShapes', () => {
  it('extracts unquoted keys from .json() call', () => {
    const content = `return NextResponse.json({ data: [], pagination: {} });`;
    const result = extractResponseShapes(content);
    expect(result.responseKeys).toContain('data');
    expect(result.responseKeys).toContain('pagination');
  });

  it('extracts single-quoted property keys from .json() call', () => {
    const content = `return NextResponse.json({ 'courses': coursesData, 'articles': articlesData });`;
    const result = extractResponseShapes(content);
    expect(result.responseKeys).toContain('courses');
    expect(result.responseKeys).toContain('articles');
    // Must not contain quotes
    for (const key of result.responseKeys!) {
      expect(key).not.toMatch(/['"]/);
    }
  });

  it('extracts double-quoted property keys from .json() call', () => {
    const content = `return NextResponse.json({ "items": data, "count": total });`;
    const result = extractResponseShapes(content);
    expect(result.responseKeys).toContain('items');
    expect(result.responseKeys).toContain('count');
  });

  it('extracts backtick-quoted property keys from .json() call', () => {
    const content = 'return NextResponse.json({ `users`: data, `total`: count });';
    const result = extractResponseShapes(content);
    expect(result.responseKeys).toContain('users');
    expect(result.responseKeys).toContain('total');
  });

  it('classifies error keys by status code', () => {
    const content = `
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    `;
    const result = extractResponseShapes(content);
    expect(result.errorKeys).toContain('error');
    expect(result.responseKeys).toBeUndefined();
  });

  it('separates success and error keys from same handler', () => {
    const content = `
      if (bad) return NextResponse.json({ error: 'fail', details: 'x' }, { status: 400 });
      return NextResponse.json({ data: items, total: count });
    `;
    const result = extractResponseShapes(content);
    expect(result.responseKeys).toEqual(expect.arrayContaining(['data', 'total']));
    expect(result.errorKeys).toEqual(expect.arrayContaining(['error', 'details']));
  });
});

describe('extractConsumerAccessedKeys', () => {
  it('extracts destructured keys from .json()', () => {
    const content = `const { data, pagination } = await res.json();`;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('data');
    expect(keys).toContain('pagination');
  });

  it('extracts property access on response variables', () => {
    const content = `
      const data = await fetch('/api/test').then(r => r.json());
      console.log(data.items);
      console.log(data.total);
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('items');
    expect(keys).toContain('total');
  });

  it('filters out common response methods', () => {
    const content = `
      const items = data.map(x => x.name);
      data.forEach(item => process(item));
      const len = data.length;
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).not.toContain('map');
    expect(keys).not.toContain('forEach');
    expect(keys).not.toContain('length');
  });

  it('filters out DOM manipulation methods', () => {
    const content = `
      const { url } = await response.json();
      const link = document.createElement('a');
      link.href = url;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).not.toContain('appendChild');
    expect(keys).not.toContain('removeChild');
    expect(keys).not.toContain('createElement');
    expect(keys).not.toContain('click');
  });

  it('still captures real response keys alongside DOM code', () => {
    const content = `
      const data = await res.json();
      const url = data.downloadUrl;
      const link = document.createElement('a');
      document.body.appendChild(link);
      document.body.removeChild(link);
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('downloadUrl');
    expect(keys).not.toContain('appendChild');
    expect(keys).not.toContain('removeChild');
  });

  it('does not blocklist legitimate API field names', () => {
    const content = `
      const data = await res.json();
      console.log(data.type);
      console.log(data.href);
      console.log(data.target);
      console.log(data.style);
    `;
    const keys = extractConsumerAccessedKeys(content);
    expect(keys).toContain('type');
    expect(keys).toContain('href');
    expect(keys).toContain('target');
    expect(keys).toContain('style');
  });
});
