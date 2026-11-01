/**
 * Route extraction and decorator association shared by worker and sequential parsing.
 */

import { extractStringContent, findDescendant, type SyntaxNode } from '../utils/ast-helpers.js';
import type Parser from 'tree-sitter';
import type { ParseWorkerResult } from './parse-types.js';
import type { FrameworkHint } from '../framework-detection.js';
import type { createRouteResponseShapeExtractor } from '../route-extractors/response-shapes.js';

// Route/decorator capture rules shared by worker and sequential parsing.
const EXPRESS_ROUTE_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'all',
  'use',
  'route',
]);

// Known HTTP client receivers are consumers rather than route registrations.
const HTTP_CLIENT_RECEIVERS = new Set([
  'axios',
  'request',
  'fetch',
  'http',
  'https',
  'got',
  'ky',
  'superagent',
  'needle',
  'undici',
  'apiclient',
  'client',
  'httpclient',
  'api',
  '$http',
  'session',
  'httpservice',
  'conn',
]);

// Decorator names that indicate HTTP route handlers (NestJS, Flask, FastAPI, Spring)
const ROUTE_DECORATOR_NAMES = new Set([
  'Get',
  'Post',
  'Put',
  'Delete',
  'Patch',
  'Route',
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'route',
  'RequestMapping',
  'GetMapping',
  'PostMapping',
  'PutMapping',
  'DeleteMapping',
]);

export type RouteToolExtractions = Pick<
  ParseWorkerResult,
  'routes' | 'decoratorRoutes' | 'toolDefs'
>;
export type FileDecorators = Map<number, { name: string; arg?: string; isTool?: boolean }>;

/** Consume route/decorator captures in query order before definition filtering. */
export function captureRouteOrDecorator(
  captureMap: Record<string, SyntaxNode>,
  filePath: string,
  lineOffset: number,
  fileDecorators: FileDecorators,
  result: RouteToolExtractions,
  extractShape?: ReturnType<typeof createRouteResponseShapeExtractor>,
): boolean {
  // Store decorator metadata for later association with definitions
  if (captureMap['decorator'] && captureMap['decorator.name']) {
    const decoratorName = captureMap['decorator.name'].text;
    const decoratorArg = captureMap['decorator.arg']?.text;
    const decoratorNode = captureMap['decorator'];
    // Store by the decorator's end line — the definition follows immediately after
    fileDecorators.set(decoratorNode.endPosition.row, {
      name: decoratorName,
      arg: decoratorArg,
    });

    if (ROUTE_DECORATOR_NAMES.has(decoratorName)) {
      const routePath = decoratorArg || '';
      const method = decoratorName.replace('Mapping', '').toUpperCase();
      const httpMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)
        ? method
        : 'GET';
      result.decoratorRoutes.push({
        filePath,
        routePath,
        httpMethod,
        decoratorName,
        lineNumber: decoratorNode.startPosition.row + lineOffset,
        ...extractShape?.(
          decoratorNode.parent?.type === 'method_definition'
            ? decoratorNode.parent
            : decoratorNode.nextNamedSibling,
        ),
      });
    }
    // MCP/RPC tool detection: @mcp.tool(), @app.tool(), @server.tool()
    if (decoratorName === 'tool') {
      // Re-store with isTool flag for the definition handler
      fileDecorators.set(decoratorNode.endPosition.row, {
        name: decoratorName,
        arg: decoratorArg,
        isTool: true,
      });
    }
    return true;
  }

  // Express/Hono route registration: app.get('/path', handler)
  if (
    captureMap['express_route'] &&
    captureMap['express_route.method'] &&
    captureMap['express_route.path']
  ) {
    const method = captureMap['express_route.method'].text;
    const routePath = captureMap['express_route.path'].text;
    if (EXPRESS_ROUTE_METHODS.has(method) && routePath.startsWith('/')) {
      // Extract the receiver (the object the method is called on) to filter out
      // HTTP client calls like axios.get('/api/users') that match the same pattern
      // as Express route registrations.
      const callNode = captureMap['express_route'];
      const funcNode = callNode.childForFieldName?.('function') ?? callNode.children?.[0];
      // Walk through nested member_expressions and call_expressions to
      // reach the innermost receiver identifier.  Handles chains like:
      //   this.httpService.get('/path')   -> member chain    -> 'httpservice'
      //   getClient().get('/path')         -> call_expression -> 'getclient'
      //   axios.get('/path')               -> bare identifier -> 'axios'
      let receiverNode = funcNode?.childForFieldName?.('object') ?? funcNode?.children?.[0];
      while (
        receiverNode?.type === 'member_expression' ||
        receiverNode?.type === 'call_expression'
      ) {
        if (receiverNode.type === 'member_expression') {
          // Drill into the property (rightmost part) of the member expression
          const propNode = receiverNode.childForFieldName?.('property');
          if (propNode) {
            receiverNode = propNode;
          } else {
            break;
          }
        } else {
          // call_expression: unwrap to the function being called
          const innerFunc =
            receiverNode.childForFieldName?.('function') ?? receiverNode.children?.[0];
          if (innerFunc && innerFunc !== receiverNode) {
            receiverNode = innerFunc;
          } else {
            break;
          }
        }
      }
      const receiverText = receiverNode?.text?.toLowerCase() ?? '';

      if (HTTP_CLIENT_RECEIVERS.has(receiverText)) {
        // This is an HTTP client call, not a route definition — skip it
        return true;
      }

      const httpMethod =
        method === 'all' || method === 'use' || method === 'route' ? 'GET' : method.toUpperCase();
      result.decoratorRoutes.push({
        filePath,
        routePath,
        httpMethod,
        decoratorName: `express.${method}`,
        lineNumber: captureMap['express_route'].startPosition.row + lineOffset,
        ...extractShape?.(
          callNode
            .childForFieldName('arguments')
            ?.namedChildren.filter((child) => child.type !== 'comment')
            .at(-1),
        ),
      });
    }
    return true;
  }

  return false;
}

/** Associate preceding decorators with the final definition name exactly once. */
export function associateDefinitionDecorators(
  definitionNode: SyntaxNode | null | undefined,
  nodeName: string,
  filePath: string,
  lineOffset: number,
  fileDecorators: FileDecorators,
  result: RouteToolExtractions,
  frameworkHint: FrameworkHint | null,
): FrameworkHint | null {
  // Decorators appear on lines immediately before their definition; allow up to
  // MAX_DECORATOR_SCAN_LINES gap for blank lines / multi-line decorator stacks.
  const MAX_DECORATOR_SCAN_LINES = 5;
  if (definitionNode) {
    const defStartLine = definitionNode.startPosition.row;
    for (
      let checkLine = defStartLine - 1;
      checkLine >= Math.max(0, defStartLine - MAX_DECORATOR_SCAN_LINES);
      checkLine--
    ) {
      const dec = fileDecorators.get(checkLine);
      if (dec) {
        // Use first (closest) decorator found for framework hint
        if (!frameworkHint) {
          frameworkHint = {
            framework: 'decorator',
            entryPointMultiplier: 1.2,
            reason: `@${dec.name}${dec.arg ? `("${dec.arg}")` : ''}`,
          };
        }
        // Emit tool definition if this is a @tool decorator
        if (dec.isTool) {
          result.toolDefs.push({
            filePath,
            toolName: nodeName,
            description: dec.arg || '',
            lineNumber: definitionNode.startPosition.row + lineOffset,
          });
        }
        fileDecorators.delete(checkLine);
      }
    }
  }

  return frameworkHint;
}

// ============================================================================
// Public types
// ============================================================================

interface ExtractedRoute {
  filePath: string;
  httpMethod: string;
  routePath: string | null;
  controllerName: string | null;
  methodName: string | null;
  middleware: string[];
  prefix: string | null;
  lineNumber: number;
}

// ============================================================================
// Internal types
// ============================================================================

interface RouteGroupContext {
  middleware: string[];
  prefix: string | null;
  controller: string | null;
}

interface ChainedRouteCall {
  isRouteFacade: boolean;
  terminalMethod: string;
  attributes: { method: string; argsNode: SyntaxNode | null }[];
  terminalArgs: SyntaxNode | null;
  node: SyntaxNode;
}

// ============================================================================
// Constants
// ============================================================================

const ROUTE_HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'any',
  'match',
]);

const ROUTE_RESOURCE_METHODS = new Set(['resource', 'apiResource']);

const RESOURCE_ACTIONS = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
const API_RESOURCE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy'];

// ============================================================================
// AST helpers
// ============================================================================

/** Check if node is a scoped_call_expression with object 'Route' */
function isRouteStaticCall(node: SyntaxNode): boolean {
  if (node.type !== 'scoped_call_expression') return false;
  const obj = node.childForFieldName?.('object') ?? node.children?.[0];
  return obj?.text === 'Route';
}

/** Get the method name from a scoped_call_expression or member_call_expression */
function getCallMethodName(node: SyntaxNode): string | null {
  const nameNode =
    node.childForFieldName?.('name') ?? node.children?.find((c: SyntaxNode) => c.type === 'name');
  return nameNode?.text ?? null;
}

/** Get the arguments node from a call expression */
function getArguments(node: SyntaxNode): SyntaxNode | null {
  return node.children?.find((c: SyntaxNode) => c.type === 'arguments') ?? null;
}

/** Find the closure body inside arguments */
function findClosureBody(argsNode: SyntaxNode | null): SyntaxNode | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') {
      for (const inner of child.children ?? []) {
        if (inner.type === 'anonymous_function' || inner.type === 'arrow_function') {
          return (
            inner.childForFieldName?.('body') ??
            inner.children?.find((c: SyntaxNode) => c.type === 'compound_statement') ??
            null
          );
        }
      }
    }
    if (child.type === 'anonymous_function' || child.type === 'arrow_function') {
      return (
        child.childForFieldName?.('body') ??
        child.children?.find((c: SyntaxNode) => c.type === 'compound_statement') ??
        null
      );
    }
  }
  return null;
}

/** Extract first string argument from arguments node */
function extractFirstStringArg(argsNode: SyntaxNode | null): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === 'string' || target.type === 'encapsed_string') {
      return extractStringContent(target);
    }
  }
  return null;
}

/** Extract middleware from arguments — handles string or array */
function extractMiddlewareArg(argsNode: SyntaxNode | null): string[] {
  if (!argsNode) return [];
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === 'string' || target.type === 'encapsed_string') {
      const val = extractStringContent(target);
      return val ? [val] : [];
    }
    if (target.type === 'array_creation_expression') {
      const items: string[] = [];
      for (const el of target.children ?? []) {
        if (el.type === 'array_element_initializer') {
          const str = el.children?.find(
            (c: SyntaxNode) => c.type === 'string' || c.type === 'encapsed_string',
          );
          const val = str ? extractStringContent(str) : null;
          if (val) items.push(val);
        }
      }
      return items;
    }
  }
  return [];
}

/** Extract Controller::class from arguments */
function extractClassArg(argsNode: SyntaxNode | null): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'class_constant_access_expression') {
      return target.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
    }
  }
  return null;
}

/** Extract controller class name from arguments: [Controller::class, 'method'] or 'Controller@method' */
function extractControllerTarget(argsNode: SyntaxNode | null): {
  controller: string | null;
  method: string | null;
} {
  if (!argsNode) return { controller: null, method: null };

  const args: (SyntaxNode | undefined)[] = [];
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') args.push(child.children?.[0]);
    else if (child.type !== '(' && child.type !== ')' && child.type !== ',') args.push(child);
  }

  // Second arg is the handler
  const handlerNode = args[1];
  if (!handlerNode) return { controller: null, method: null };

  // Array syntax: [UserController::class, 'index']
  if (handlerNode.type === 'array_creation_expression') {
    let controller: string | null = null;
    let method: string | null = null;
    const elements: SyntaxNode[] = [];
    for (const el of handlerNode.children ?? []) {
      if (el.type === 'array_element_initializer') elements.push(el);
    }
    if (elements[0]) {
      const classAccess = findDescendant(elements[0], 'class_constant_access_expression');
      if (classAccess) {
        controller = classAccess.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
      }
    }
    if (elements[1]) {
      const str = findDescendant(elements[1], 'string');
      method = str ? extractStringContent(str) : null;
    }
    return { controller, method };
  }

  // String syntax: 'UserController@index'
  if (handlerNode.type === 'string' || handlerNode.type === 'encapsed_string') {
    const text = extractStringContent(handlerNode);
    if (text?.includes('@')) {
      const [controller, method] = text.split('@');
      return { controller, method };
    }
  }

  // Class reference: UserController::class (invokable controller)
  if (handlerNode.type === 'class_constant_access_expression') {
    const controller =
      handlerNode.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
    return { controller, method: '__invoke' };
  }

  return { controller: null, method: null };
}

/**
 * Unwrap a chained call like Route::middleware('auth')->prefix('api')->group(fn)
 */
function unwrapRouteChain(node: SyntaxNode): ChainedRouteCall | null {
  if (node.type !== 'member_call_expression') return null;

  const terminalMethod = getCallMethodName(node);
  if (!terminalMethod) return null;

  const terminalArgs = getArguments(node);
  const attributes: { method: string; argsNode: SyntaxNode | null }[] = [];

  let current = node.children?.[0];

  while (current) {
    if (current.type === 'member_call_expression') {
      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });
      current = current.children?.[0];
    } else if (current.type === 'scoped_call_expression') {
      const obj = current.childForFieldName?.('object') ?? current.children?.[0];
      if (obj?.text !== 'Route') return null;

      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });

      return { isRouteFacade: true, terminalMethod, attributes, terminalArgs, node };
    } else {
      break;
    }
  }

  return null;
}

/** Parse Route::group(['middleware' => ..., 'prefix' => ...], fn) array syntax */
function parseArrayGroupArgs(argsNode: SyntaxNode | null): RouteGroupContext {
  const ctx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
  if (!argsNode) return ctx;

  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'array_creation_expression') {
      for (const el of target.children ?? []) {
        if (el.type !== 'array_element_initializer') continue;
        const children = el.children ?? [];
        const arrowIdx = children.findIndex((c: SyntaxNode) => c.type === '=>');
        if (arrowIdx === -1) continue;
        const key = extractStringContent(children[arrowIdx - 1]);
        const val = children[arrowIdx + 1];
        if (key === 'middleware') {
          if (val?.type === 'string') {
            const s = extractStringContent(val);
            if (s) ctx.middleware.push(s);
          } else if (val?.type === 'array_creation_expression') {
            for (const item of val.children ?? []) {
              if (item.type === 'array_element_initializer') {
                const str = item.children?.find((c: SyntaxNode) => c.type === 'string');
                const s = str ? extractStringContent(str) : null;
                if (s) ctx.middleware.push(s);
              }
            }
          }
        } else if (key === 'prefix') {
          ctx.prefix = extractStringContent(val) ?? null;
        } else if (key === 'controller') {
          if (val?.type === 'class_constant_access_expression') {
            ctx.controller = val.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
          }
        }
      }
    }
  }
  return ctx;
}

// ============================================================================
// Public API
// ============================================================================

export function extractLaravelRoutes(
  tree: Pick<Parser.Tree, 'rootNode'>,
  filePath: string,
): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  function resolveStack(stack: RouteGroupContext[]): {
    middleware: string[];
    prefix: string | null;
    controller: string | null;
  } {
    const middleware: string[] = [];
    let prefix: string | null = null;
    let controller: string | null = null;
    for (const ctx of stack) {
      middleware.push(...ctx.middleware);
      if (ctx.prefix) prefix = prefix ? `${prefix}/${ctx.prefix}`.replace(/\/+/g, '/') : ctx.prefix;
      if (ctx.controller) controller = ctx.controller;
    }
    return { middleware, prefix, controller };
  }

  function emitRoute(
    httpMethod: string,
    argsNode: SyntaxNode | null,
    lineNumber: number,
    groupStack: RouteGroupContext[],
    chainAttrs: { method: string; argsNode: SyntaxNode | null }[],
  ) {
    const effective = resolveStack(groupStack);

    for (const attr of chainAttrs) {
      if (attr.method === 'middleware')
        effective.middleware.push(...extractMiddlewareArg(attr.argsNode));
      if (attr.method === 'prefix') {
        const p = extractFirstStringArg(attr.argsNode);
        if (p) effective.prefix = effective.prefix ? `${effective.prefix}/${p}` : p;
      }
      if (attr.method === 'controller') {
        const cls = extractClassArg(attr.argsNode);
        if (cls) effective.controller = cls;
      }
    }

    const routePath = extractFirstStringArg(argsNode);

    if (ROUTE_RESOURCE_METHODS.has(httpMethod)) {
      const target = extractControllerTarget(argsNode);
      const actions = httpMethod === 'apiResource' ? API_RESOURCE_ACTIONS : RESOURCE_ACTIONS;
      for (const action of actions) {
        routes.push({
          filePath,
          httpMethod,
          routePath,
          controllerName: target.controller ?? effective.controller,
          methodName: action,
          middleware: [...effective.middleware],
          prefix: effective.prefix,
          lineNumber,
        });
      }
    } else {
      const target = extractControllerTarget(argsNode);
      routes.push({
        filePath,
        httpMethod,
        routePath,
        controllerName: target.controller ?? effective.controller,
        methodName: target.method,
        middleware: [...effective.middleware],
        prefix: effective.prefix,
        lineNumber,
      });
    }
  }

  function pushChildren(
    pending: { node: SyntaxNode; groupStack: RouteGroupContext[] }[],
    node: SyntaxNode,
    groupStack: RouteGroupContext[],
  ) {
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push({ node: children[i], groupStack });
    }
  }

  const pending: { node: SyntaxNode; groupStack: RouteGroupContext[] }[] = [
    { node: tree.rootNode, groupStack: [] },
  ];

  while (pending.length > 0) {
    const { node, groupStack } = pending.pop()!;

    // Case 1: Simple Route::get(...), Route::post(...), etc.
    if (isRouteStaticCall(node)) {
      const method = getCallMethodName(node);
      if (method && (ROUTE_HTTP_METHODS.has(method) || ROUTE_RESOURCE_METHODS.has(method))) {
        emitRoute(method, getArguments(node), node.startPosition.row, groupStack, []);
        continue;
      }
      if (method === 'group') {
        const argsNode = getArguments(node);
        const groupCtx = parseArrayGroupArgs(argsNode);
        const body = findClosureBody(argsNode);
        if (body) {
          pending.push({ node: body, groupStack: [...groupStack, groupCtx] });
        }
        continue;
      }
    }

    // Case 2: Fluent chain — Route::middleware(...)->group(...) or Route::middleware(...)->get(...)
    const chain = unwrapRouteChain(node);
    if (chain) {
      if (chain.terminalMethod === 'group') {
        const groupCtx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
        for (const attr of chain.attributes) {
          if (attr.method === 'middleware')
            groupCtx.middleware.push(...extractMiddlewareArg(attr.argsNode));
          if (attr.method === 'prefix') groupCtx.prefix = extractFirstStringArg(attr.argsNode);
          if (attr.method === 'controller') groupCtx.controller = extractClassArg(attr.argsNode);
        }
        const body = findClosureBody(chain.terminalArgs);
        if (body) {
          pending.push({ node: body, groupStack: [...groupStack, groupCtx] });
        }
        continue;
      }
      if (
        ROUTE_HTTP_METHODS.has(chain.terminalMethod) ||
        ROUTE_RESOURCE_METHODS.has(chain.terminalMethod)
      ) {
        emitRoute(
          chain.terminalMethod,
          chain.terminalArgs,
          node.startPosition.row,
          groupStack,
          chain.attributes,
        );
        continue;
      }
    }

    pushChildren(pending, node, groupStack);
  }

  return routes;
}
