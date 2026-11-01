/**
 * Response shape extraction from route handler file content.
 * Detects .json() calls (JS/TS) and json_encode() calls (PHP),
 * extracts top-level keys, and classifies by HTTP status code.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { nextjsFileToRouteURL } from './nextjs.js';
import type { ExtractedDecoratorRoute } from '../workers/parse-types.js';

type ResponseShape = { responseKeys?: string[]; errorKeys?: string[] };
const JS_CALLABLES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

/** Static object keys only; values, comments and computed keys provide no shape evidence. */
function objectKey(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  if (['property_identifier', 'identifier', 'shorthand_property_identifier'].includes(node.type)) {
    return node.text;
  }
  if (
    node.type === 'string' &&
    !node.namedChildren.some((child) => child.type === 'escape_sequence')
  ) {
    return node.namedChildren.map((child) => child.text).join('');
  }
  return undefined;
}

/** Reuse one parsed tree and one lexical lookup per file, with memoized handler shapes. */
export function createRouteResponseShapeExtractor(root: SyntaxNode) {
  let extract: ReturnType<typeof buildRouteResponseShapeExtractor> | undefined;
  return (handler: SyntaxNode | null | undefined): ResponseShape => {
    if (!handler) return {};
    extract ??= buildRouteResponseShapeExtractor(root);
    return extract(handler);
  };
}

function buildRouteResponseShapeExtractor(root: SyntaxNode) {
  type Scope = {
    parent?: Scope;
    bindings: Map<string, (SyntaxNode | null)[]>;
    functionScope: boolean;
  };
  const scopes = new Map<number, Scope>();
  const mutatedNames = new Set<string>();
  let unresolvedAssignment = false;
  const rootScope: Scope = { bindings: new Map(), functionScope: true };
  const bind = (scope: Scope, name: string, callable: SyntaxNode | null) => {
    const values = scope.bindings.get(name) ?? [];
    values.push(callable);
    scope.bindings.set(name, values);
  };
  const visitPattern = (node: SyntaxNode | null, visitName: (name: string) => void): boolean => {
    if (!node) return false;
    if (
      ['identifier', 'type_identifier', 'shorthand_property_identifier_pattern'].includes(node.type)
    ) {
      visitName(node.text);
    } else if (['required_parameter', 'optional_parameter'].includes(node.type)) {
      return visitPattern(
        node.childForFieldName('pattern') ?? node.childForFieldName('name'),
        visitName,
      );
    } else if (['assignment_pattern', 'object_assignment_pattern'].includes(node.type)) {
      return visitPattern(node.childForFieldName('left'), visitName);
    } else if (node.type === 'pair_pattern') {
      return visitPattern(node.childForFieldName('value'), visitName);
    } else if (
      ['object_pattern', 'array_pattern', 'rest_pattern', 'formal_parameters'].includes(node.type)
    ) {
      let resolved = true;
      for (const child of node.namedChildren) {
        if (!visitPattern(child, visitName)) resolved = false;
      }
      return resolved;
    } else if (!['member_expression', 'subscript_expression', 'comment'].includes(node.type)) {
      return false;
    }
    // Property writes do not rebind their receiver or property name.
    return true;
  };
  const bindPattern = (
    scope: Scope,
    node: SyntaxNode | null,
    callable: SyntaxNode | null = null,
  ): void => {
    visitPattern(node, (name) => bind(scope, name, callable));
  };
  const pending: { node: SyntaxNode; scope: Scope }[] = [{ node: root, scope: rootScope }];
  while (pending.length > 0) {
    const { node, scope: outer } = pending.pop()!;
    let scope = outer;
    if (JS_CALLABLES.has(node.type)) {
      const name = node.childForFieldName('name');
      if (name && node.type.endsWith('_declaration')) bind(outer, name.text, node);
      scope = { parent: outer, bindings: new Map(), functionScope: true };
      if (name && !node.type.endsWith('_declaration') && node.type !== 'method_definition') {
        bind(scope, name.text, node);
      }
      bindPattern(
        scope,
        node.childForFieldName('parameters') ?? node.childForFieldName('parameter'),
      );
    } else if (
      [
        'statement_block',
        'switch_body',
        'class_body',
        'catch_clause',
        'for_statement',
        'for_in_statement',
      ].includes(node.type)
    ) {
      scope = { parent: outer, bindings: new Map(), functionScope: false };
      if (node.type === 'catch_clause') bindPattern(scope, node.childForFieldName('parameter'));
      if (node.type === 'class_body')
        bindPattern(scope, node.parent?.childForFieldName('name') ?? null);
      if (node.type === 'for_in_statement' && node.childForFieldName('kind')) {
        bindPattern(scope, node.childForFieldName('left'));
      }
    }
    scopes.set(node.id, scope);
    if (node.type === 'variable_declarator') {
      let bindingScope = scope;
      if (node.parent?.type === 'variable_declaration') {
        while (!bindingScope.functionScope && bindingScope.parent)
          bindingScope = bindingScope.parent;
      }
      const value = node.childForFieldName('value');
      bindPattern(
        bindingScope,
        node.childForFieldName('name'),
        value && JS_CALLABLES.has(value.type) ? value : null,
      );
    } else if (node.type === 'class_declaration') {
      bindPattern(scope, node.childForFieldName('name'));
    } else if (node.type === 'import_clause') {
      // Every imported binding stays unresolved; it must never borrow a same-file callable.
      for (const identifier of node.descendantsOfType('identifier'))
        bind(scope, identifier.text, null);
    } else if (
      ['assignment_expression', 'augmented_assignment_expression', 'update_expression'].includes(
        node.type,
      )
    ) {
      const target = node.childForFieldName('left') ?? node.childForFieldName('argument');
      if (!visitPattern(target, (name) => mutatedNames.add(name))) unresolvedAssignment = true;
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i--) {
      pending.push({ node: node.namedChildren[i], scope });
    }
  }

  const cache = new Map<number, ResponseShape>();
  return (handler: SyntaxNode | null | undefined): ResponseShape => {
    if (!handler) return {};
    if (handler.type === 'identifier') {
      if (unresolvedAssignment || mutatedNames.has(handler.text)) return {};
      let scope = scopes.get(handler.id);
      while (scope && !scope.bindings.has(handler.text)) scope = scope.parent;
      const bindings = scope?.bindings.get(handler.text);
      if (!bindings || bindings.length !== 1 || !bindings[0]) return {};
      handler = bindings[0];
    }
    if (!JS_CALLABLES.has(handler.type)) return {};
    if (
      handler.type.endsWith('_declaration') &&
      (unresolvedAssignment || mutatedNames.has(handler.childForFieldName('name')?.text ?? ''))
    )
      return {};
    const cached = cache.get(handler.id);
    if (cached) return cached;
    const successKeys: string[] = [];
    const errorKeys: string[] = [];
    const body = handler.childForFieldName('body');
    const nodes = body ? [body] : [];
    while (nodes.length > 0) {
      const node = nodes.pop()!;
      // Function/class declarations inside the handler are not executed by declaring them.
      if (JS_CALLABLES.has(node.type) || ['class', 'class_declaration'].includes(node.type))
        continue;
      if (node.type === 'call_expression') {
        const member = node.childForFieldName('function');
        const args =
          node
            .childForFieldName('arguments')
            ?.namedChildren.filter((child) => child.type !== 'comment') ?? [];
        if (
          member?.type === 'member_expression' &&
          member.childForFieldName('property')?.text === 'json' &&
          args[0]?.type === 'object'
        ) {
          let status: number | undefined;
          const receiver = member.childForFieldName('object');
          const statusMember =
            receiver?.type === 'call_expression' ? receiver.childForFieldName('function') : null;
          if (
            statusMember?.type === 'member_expression' &&
            statusMember.childForFieldName('property')?.text === 'status'
          ) {
            const code = receiver!.childForFieldName('arguments')?.namedChildren[0];
            if (code?.type === 'number') status = Number(code.text);
          }
          if (status === undefined && args[1]?.type === 'object') {
            const statusPair = args[1].namedChildren.find(
              (child) =>
                child.type === 'pair' && objectKey(child.childForFieldName('key')) === 'status',
            );
            const code = statusPair?.childForFieldName('value');
            if (code?.type === 'number') status = Number(code.text);
          }
          const keys = status !== undefined && status >= 400 ? errorKeys : successKeys;
          for (const property of args[0].namedChildren) {
            const key = objectKey(
              property.type === 'pair' ? property.childForFieldName('key') : property,
            );
            if (key !== undefined) keys.push(key);
          }
        }
      }
      for (let i = node.namedChildren.length - 1; i >= 0; i--) nodes.push(node.namedChildren[i]);
    }
    const shape = buildShapeResult(successKeys, errorKeys);
    cache.set(handler.id, shape);
    return shape;
  };
}

/** Exported Next.js entrypoints only; unrelated helpers never contribute file-wide keys. */
export function extractNextjsRouteShapes(
  root: SyntaxNode,
  filePath: string,
  extract: ReturnType<typeof createRouteResponseShapeExtractor>,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  const routePath = nextjsFileToRouteURL(filePath);
  if (!routePath) return [];
  const pages = /(?:^|\/)pages\/api\//.test(filePath.replace(/\\/g, '/'));
  const routes: ExtractedDecoratorRoute[] = [];
  const add = (name: string, handler: SyntaxNode) => {
    if (
      pages
        ? name !== 'default'
        : !['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(name)
    )
      return;
    routes.push({
      filePath,
      routePath,
      httpMethod: pages ? 'GET' : name,
      decoratorName: 'nextjs',
      lineNumber: handler.startPosition.row + lineOffset,
      ...extract(handler),
    });
  };
  for (const statement of root.namedChildren) {
    if (statement.type !== 'export_statement' || statement.childForFieldName('source')) continue;
    const declaration = statement.childForFieldName('declaration');
    if (pages && statement.children.some((child) => child.type === 'default')) {
      const value = declaration ?? statement.childForFieldName('value');
      if (value) add('default', value);
    } else if (declaration?.type === 'function_declaration') {
      const name = declaration.childForFieldName('name');
      if (name) add(name.text, declaration);
    } else if (declaration?.type === 'lexical_declaration') {
      for (const binding of declaration.namedChildren) {
        const name = binding.childForFieldName('name');
        if (name?.type === 'identifier') add(name.text, name);
      }
    } else {
      const clause = statement.namedChildren.find((child) => child.type === 'export_clause');
      for (const specifier of clause?.namedChildren ?? []) {
        const name = specifier.childForFieldName('name');
        if (name) add(specifier.childForFieldName('alias')?.text ?? name.text, name);
      }
    }
  }
  return routes;
}

/** Return the status code (group 1) from the last match, or undefined. */
function lastMatchGroup(text: string, pattern: RegExp): number | undefined {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return undefined;
  return parseInt(matches[matches.length - 1][1], 10);
}

/** Build the {responseKeys, errorKeys} result, deduplicating and omitting empty. */
function buildShapeResult(
  successKeys: string[],
  errKeys: string[],
): { responseKeys?: string[]; errorKeys?: string[] } {
  return {
    ...(successKeys.length > 0 ? { responseKeys: [...new Set(successKeys)] } : {}),
    ...(errKeys.length > 0 ? { errorKeys: [...new Set(errKeys)] } : {}),
  };
}

/**
 * Detect an HTTP status code associated with a .json() call.
 */
export function detectStatusCode(
  content: string,
  jsonMatchPos: number,
  closingBracePos: number,
): number | undefined {
  const lookbackStart = Math.max(0, jsonMatchPos - 200);
  const before = content.slice(lookbackStart, jsonMatchPos);
  const statusChainMatch = before.match(/\.status\s*\(\s*(\d{3})\s*\)\s*$/);
  if (statusChainMatch) {
    return parseInt(statusChainMatch[1], 10);
  }
  if (closingBracePos > 0) {
    const afterFirstArg = content.slice(closingBracePos + 1, closingBracePos + 150);
    const secondArgMatch = afterFirstArg.match(/^\s*,\s*\{[^}]*status\s*:\s*(\d{3})/);
    if (secondArgMatch) {
      return parseInt(secondArgMatch[1], 10);
    }
  }
  const extendedBefore = content.slice(Math.max(0, jsonMatchPos - 300), jsonMatchPos);
  if (/new\s+Response\s*\(\s*JSON\s*\.stringify\s*$/.test(extendedBefore) && closingBracePos > 0) {
    const afterStringify = content.slice(closingBracePos + 1, closingBracePos + 200);
    const respStatusMatch = afterStringify.match(/^\s*\)\s*,\s*\{[^}]*status\s*:\s*(\d{3})/);
    if (respStatusMatch) {
      return parseInt(respStatusMatch[1], 10);
    }
  }
  return undefined;
}

/**
 * Extract response shapes from JS/TS handler file content.
 */
export function extractResponseShapes(content: string): {
  responseKeys?: string[];
  errorKeys?: string[];
} {
  const successKeys: string[] = [];
  const errKeys: string[] = [];
  const jsonPattern = /\.json\s*\(/g;
  let jsonMatch;
  while ((jsonMatch = jsonPattern.exec(content)) !== null) {
    const matchPos = jsonMatch.index;
    const startIdx = matchPos + jsonMatch[0].length;
    let i = startIdx;
    while (i < content.length && content[i] !== '{' && content[i] !== ')') i++;
    if (i >= content.length || content[i] !== '{') continue;
    const callKeys: string[] = [];
    let depth = 0;
    let keyStart = -1;
    let inString: string | null = null;
    let closingBracePos = -1;
    for (let j = i; j < content.length; j++) {
      const ch = content[j];
      if (inString) {
        if (ch === '\\') {
          j++;
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        // Quoted string at depth 1 before ':' is a property key (e.g., { 'courses': data })
        // The original parser only handled unquoted identifiers.
        if (depth === 1 && keyStart === -1) {
          const quote = ch;
          const strStart = j + 1;
          let strEnd = -1;
          for (let s = strStart; s < content.length; s++) {
            if (content[s] === '\\') {
              s++;
              continue;
            }
            if (content[s] === quote) {
              strEnd = s;
              break;
            }
          }
          if (strEnd !== -1) {
            // Scan forward for ':' without allocating a substring
            let p = strEnd + 1;
            while (
              p < content.length &&
              (content[p] === ' ' ||
                content[p] === '\t' ||
                content[p] === '\n' ||
                content[p] === '\r')
            )
              p++;
            if (content[p] === ':') {
              callKeys.push(content.slice(strStart, strEnd));
            }
            j = strEnd;
            continue;
          }
        }
        inString = ch;
        continue;
      }
      if (ch === '{') {
        depth++;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          closingBracePos = j;
          break;
        }
        continue;
      }
      if (depth !== 1) continue;
      if (keyStart === -1 && /[a-zA-Z_$]/.test(ch)) {
        keyStart = j;
      } else if (keyStart !== -1 && !/[a-zA-Z0-9_$]/.test(ch)) {
        const key = content.slice(keyStart, j);
        const rest = content.slice(j).trimStart();
        if (rest[0] === ':' || rest[0] === ',' || rest[0] === '}') {
          callKeys.push(key);
        }
        keyStart = -1;
      }
    }
    if (callKeys.length === 0) continue;
    const status = detectStatusCode(content, matchPos, closingBracePos);
    if (status !== undefined && status >= 400) {
      errKeys.push(...callKeys);
    } else {
      successKeys.push(...callKeys);
    }
  }
  return buildShapeResult(successKeys, errKeys);
}

/**
 * Find the last exit/die boundary in a string.
 * Matches: exit; exit(N); die; die('msg'); die($var);
 * Returns the index AFTER the boundary.
 */
function findLastExitBoundary(text: string): number {
  const pattern = /\b(exit|die)\s*(\([^)]*\))?\s*;/g;
  let lastEnd = -1;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  return lastEnd;
}

function detectPHPStatusCode(content: string, jsonEncodePos: number): number | undefined {
  const lookbackStart = Math.max(0, jsonEncodePos - 300);
  let before = content.slice(lookbackStart, jsonEncodePos);
  const boundaryEnd = findLastExitBoundary(before);
  if (boundaryEnd !== -1) {
    before = before.slice(boundaryEnd);
  }
  return (
    lastMatchGroup(before, /http_response_code\s*\(\s*(\d{3})\s*\)/g) ??
    lastMatchGroup(before, /header\s*\(\s*['"]HTTP\/[\d.]+\s+(\d{3})/g) ??
    // CGI/FastCGI format
    lastMatchGroup(before, /header\s*\(\s*['"]Status:\s*(\d{3})/g)
  );
}

function findMatchingBracket(
  content: string,
  openPos: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let inString: string | null = null;
  for (let j = openPos; j < content.length; j++) {
    const ch = content[j];
    if (inString) {
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === open) {
      depth++;
      continue;
    }
    if (ch === close) {
      depth--;
      if (depth === 0) return j;
      continue;
    }
  }
  return -1;
}

function extractPHPArrayKeys(arrayContent: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  const topLevelRanges: Array<[number, number]> = [];
  let rangeStart = 0;
  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      if (depth === 0) topLevelRanges.push([rangeStart, i]);
      depth++;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth--;
      if (depth === 0) rangeStart = i + 1;
    }
  }
  if (depth === 0) topLevelRanges.push([rangeStart, arrayContent.length]);
  for (const [start, end] of topLevelRanges) {
    const segment = arrayContent.slice(start, end);
    const localPattern = /(['"])([a-zA-Z_][a-zA-Z0-9_]*)\1\s*=>/g;
    let m;
    while ((m = localPattern.exec(segment)) !== null) {
      keys.push(m[2]);
    }
  }
  return keys;
}

export function extractPHPResponseShapes(content: string): {
  responseKeys?: string[];
  errorKeys?: string[];
} {
  const successKeys: string[] = [];
  const errKeys: string[] = [];
  const jsonEncodePattern = /json_encode\s*\(/g;
  let match;
  while ((match = jsonEncodePattern.exec(content)) !== null) {
    const matchPos = match.index;
    const startIdx = matchPos + match[0].length;
    let i = startIdx;
    while (i < content.length && /\s/.test(content[i])) i++;
    if (i >= content.length) continue;
    let arrayEnd = -1;
    const openChar = content[i];
    if (openChar === '[') {
      arrayEnd = findMatchingBracket(content, i, '[', ']');
    } else if (content.slice(i, i + 6) === 'array(') {
      i += 5;
      arrayEnd = findMatchingBracket(content, i, '(', ')');
    } else {
      continue;
    }
    if (arrayEnd === -1) continue;
    const arrayContent = content.slice(i + 1, arrayEnd);
    const callKeys = extractPHPArrayKeys(arrayContent);
    if (callKeys.length === 0) continue;
    const status = detectPHPStatusCode(content, matchPos);
    if (status !== undefined && status >= 400) {
      errKeys.push(...callKeys);
    } else {
      successKeys.push(...callKeys);
    }
  }
  return buildShapeResult(successKeys, errKeys);
}
