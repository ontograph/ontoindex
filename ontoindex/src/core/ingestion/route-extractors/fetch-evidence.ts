import type { SyntaxNode } from '../utils/ast-helpers.js';

export interface FetchEvidence {
  fetchURL: string;
  httpMethod?: string;
}

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

function stringValue(node: SyntaxNode): string | null {
  const fragments = node.namedChildren.filter(
    (child) => child.type === 'string_fragment' || child.type === 'string_content',
  );
  if (fragments.length > 0) return fragments.map((child) => child.text).join('');
  if (node.type !== 'string') return null;
  const raw = node.text;
  return raw.length >= 2 && ['"', "'"].includes(raw[0]!) ? raw.slice(1, -1) : null;
}

function staticURLPart(node: SyntaxNode): { value: string; partial: boolean } | null {
  if (node.type === 'string') {
    const value = stringValue(node);
    return value === null ? null : { value, partial: false };
  }
  if (node.type === 'template_string') {
    let value = '';
    let partial = false;
    for (const child of node.namedChildren) {
      if (child.type === 'string_fragment') value += child.text;
      else if (child.type === 'template_substitution') {
        value += '[param]';
        partial = true;
      } else return null;
    }
    return { value, partial };
  }
  if (node.type === 'binary_expression' && node.children.some((child) => child.type === '+')) {
    const leftNode = node.childForFieldName('left');
    const rightNode = node.childForFieldName('right');
    if (!leftNode || !rightNode) return null;
    const left = staticURLPart(leftNode);
    const right = staticURLPart(rightNode);
    if (!left || !right) return null;
    return { value: left.value + right.value, partial: left.partial || right.partial };
  }
  if (node.type === 'identifier') return { value: '[param]', partial: true };
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    if (fn?.text !== 'encodeURIComponent') return null;
    return { value: '[param]', partial: true };
  }
  return null;
}

function methodFromOptions(options: SyntaxNode | undefined): string | undefined {
  if (!options) return 'GET';
  if (options.type !== 'object') return undefined;
  let methodPair: SyntaxNode | undefined;
  for (const child of options.namedChildren) {
    if (child.type === 'spread_element') return undefined;
    if (child.type === 'pair') {
      const key = child.childForFieldName('key');
      if (!key || key.type === 'computed_property_name') return undefined;
      const keyText = key.text.replace(/^["']|["']$/g, '');
      if (keyText === 'method') {
        if (methodPair) return undefined;
        methodPair = child;
      }
      continue;
    }
    if (
      (child.type === 'shorthand_property_identifier' ||
        child.type === 'shorthand_property_identifier_pattern') &&
      child.text === 'method'
    )
      return undefined;
    if (child.type === 'method_definition') {
      const name = child.childForFieldName('name');
      if (!name || name.type === 'computed_property_name' || name.text === 'method')
        return undefined;
    }
  }
  if (!methodPair) return 'GET';
  const value = methodPair.childForFieldName('value');
  const raw = value && stringValue(value);
  if (raw === null || raw === undefined) return undefined;
  const method = raw.toUpperCase();
  return HTTP_METHODS.has(method) ? method : undefined;
}

/** Resolve only literal/template/concatenated URL prefixes; dynamic bases stay unknown. */
export function extractFetchEvidence(callNode: SyntaxNode): FetchEvidence | null {
  const args =
    callNode
      .childForFieldName('arguments')
      ?.namedChildren.filter((child) => child.type !== 'comment') ?? [];
  const url = args[0] && staticURLPart(args[0]);
  if (!url || !url.value.startsWith('/')) return null;
  const httpMethod = methodFromOptions(args[1]);
  return {
    fetchURL: url.value,
    ...(httpMethod ? { httpMethod } : {}),
  };
}
