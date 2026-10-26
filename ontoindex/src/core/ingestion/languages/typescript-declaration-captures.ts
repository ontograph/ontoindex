import type { Capture, CaptureMatch, Range, Scope, ScopeId, ScopeTree } from 'ontoindex-shared';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { LocalBindingCandidate } from '../language-provider.js';

const DECLARATIONS = new Map<string, readonly ['function' | 'class', 'parent' | 'self']>([
  ['function_declaration', ['function', 'parent']],
  ['generator_function_declaration', ['function', 'parent']],
  ['function_expression', ['function', 'self']],
  ['generator_function', ['function', 'self']],
  ['class_declaration', ['class', 'parent']],
  ['abstract_class_declaration', ['class', 'parent']],
  ['class', ['class', 'self']],
]);
const IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
const METADATA = '@typescript.binding_scope';
const VAR_HOST = '@typescript.var_host';
const BINDING_KIND = '@typescript.binding_kind';
const FUNCTIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

function unsupported(): never {
  throw new Error(
    'TS/JS declaration captures require supported named syntax and an exact lexical scope',
  );
}

function capture(name: string, node: SyntaxNode, text: string): Capture {
  return {
    name,
    range: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    },
    text,
  };
}

function validRange(range: Range): boolean {
  const { startLine, startCol, endLine, endCol } = range;
  return (
    [startLine, startCol, endLine, endCol].every(Number.isSafeInteger) &&
    startLine >= 1 &&
    startCol >= 0 &&
    endLine >= startLine &&
    endCol >= 0 &&
    (endLine > startLine || endCol > startCol)
  );
}

function sameRange(left: Range, right: Range): boolean {
  return (
    left.startLine === right.startLine &&
    left.startCol === right.startCol &&
    left.endLine === right.endLine &&
    left.endCol === right.endCol
  );
}

function contains(outer: Range, inner: Range): boolean {
  return (
    (outer.startLine < inner.startLine ||
      (outer.startLine === inner.startLine && outer.startCol <= inner.startCol)) &&
    (outer.endLine > inner.endLine ||
      (outer.endLine === inner.endLine && outer.endCol >= inner.endCol))
  );
}

/** Detach one function/class name and its lexical binding placement. */
export function emitTypeScriptDeclarationCaptures(node: SyntaxNode): CaptureMatch[] {
  const declaration = DECLARATIONS.get(node.type);
  if (!declaration || !node.isNamed || node.hasError || node.isMissing) unsupported();
  const [kind, placement] = declaration;
  const name = node.childForFieldName('name');
  if (!name) {
    if (placement === 'self') return [];
    return unsupported();
  }
  if (
    name.isMissing ||
    name.hasError ||
    !['identifier', 'type_identifier'].includes(name.type) ||
    !IDENTIFIER.test(name.text)
  )
    unsupported();
  const anchorKey = `@declaration.${kind}`;
  return [
    {
      [anchorKey]: capture(anchorKey, node, ''),
      '@declaration.name': capture('@declaration.name', name, name.text),
      [METADATA]: capture(METADATA, name, placement),
    },
  ];
}

/** Detach identifier let/const bindings at their names, outside initializer scopes. */
export function emitTypeScriptLexicalBindingCaptures(node: SyntaxNode): CaptureMatch[] {
  if (
    node.type !== 'lexical_declaration' ||
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    !node.children.some((child) => !child.isNamed && ['let', 'const'].includes(child.type))
  )
    unsupported();
  const declarators = node.namedChildren.filter((child) => child.type !== 'comment');
  if (declarators.length === 0) unsupported();
  return declarators.map((declarator) => {
    if (declarator.type !== 'variable_declarator' || declarator.hasError || declarator.isMissing)
      unsupported();
    const name = declarator.childForFieldName('name');
    if (
      !name ||
      name.type !== 'identifier' ||
      !name.isNamed ||
      name.hasError ||
      name.isMissing ||
      !IDENTIFIER.test(name.text)
    )
      unsupported();
    return {
      '@declaration.variable': capture('@declaration.variable', name, ''),
      '@declaration.name': capture('@declaration.name', name, name.text),
    };
  });
}

/** Detach a complete supported signature's ordinary parameter names. */
export function emitTypeScriptParameterBindingCaptures(node: SyntaxNode): CaptureMatch[] {
  if (
    ![
      'function_declaration',
      'generator_function_declaration',
      'function_expression',
      'generator_function',
      'arrow_function',
      'method_definition',
    ].includes(node.type) ||
    !node.isNamed ||
    node.hasError ||
    node.isMissing
  )
    unsupported();
  const parameters = node.childForFieldName('parameters');
  const parameter = node.childForFieldName('parameter');
  let bindings: SyntaxNode[];
  if (parameters) {
    if (
      parameter ||
      parameters.type !== 'formal_parameters' ||
      !parameters.isNamed ||
      parameters.hasError ||
      parameters.isMissing ||
      parameters.children.some(
        (child) =>
          child.isMissing ||
          child.hasError ||
          (!child.isNamed && !['(', ')', ','].includes(child.type)),
      )
    )
      unsupported();
    bindings = parameters.namedChildren.filter((child) => child.type !== 'comment');
  } else {
    if (node.type !== 'arrow_function' || !parameter || parameter.type !== 'identifier')
      unsupported();
    bindings = [parameter];
  }
  const names = new Set<string>();
  const identifiers = bindings.map((binding) => {
    if (!binding.isNamed || binding.hasError || binding.isMissing) unsupported();
    let name = binding;
    if (binding.type === 'required_parameter' || binding.type === 'optional_parameter') {
      const pattern = binding.childForFieldName('pattern');
      const annotation = binding.childForFieldName('type');
      if (
        !pattern ||
        (annotation && annotation.type !== 'type_annotation') ||
        binding.children.some(
          (child) =>
            child.isMissing ||
            child.hasError ||
            (child.id !== pattern.id &&
              child.id !== annotation?.id &&
              child.type !== 'comment' &&
              !(binding.type === 'optional_parameter' && !child.isNamed && child.type === '?')),
        )
      )
        unsupported();
      name = pattern;
    }
    if (
      name.type !== 'identifier' ||
      !name.isNamed ||
      name.hasError ||
      name.isMissing ||
      name.text === 'this' ||
      !IDENTIFIER.test(name.text) ||
      names.has(name.text)
    )
      unsupported();
    names.add(name.text);
    return name;
  });
  return identifiers.map((name) => ({
    '@declaration.variable': capture('@declaration.variable', name, ''),
    '@declaration.name': capture('@declaration.name', name, name.text),
    [BINDING_KIND]: capture(BINDING_KIND, name, 'parameter'),
  }));
}

/** Detach identifier var declarations with their actual variable environment. */
export function emitTypeScriptVarBindingCaptures(node: SyntaxNode): CaptureMatch[] {
  return emitVarBindingCaptures(node, new Map(), new Set());
}

/** Share visited environment validation within one borrowed program root. */
export function emitTypeScriptVarBindingCapturesForFile(root: SyntaxNode): CaptureMatch[] {
  if (root.type !== 'program' || !root.isNamed || root.hasError || root.isMissing) unsupported();
  const siblingNames = new Map<number, ReadonlySet<string>>();
  const validatedSignatures = new Set<number>();
  return root
    .descendantsOfType(['variable_declaration', 'for_in_statement'])
    .flatMap((node) => emitVarBindingCaptures(node, siblingNames, validatedSignatures));
}

function emitVarBindingCaptures(
  node: SyntaxNode,
  siblingNames: Map<number, ReadonlySet<string>>,
  validatedSignatures: Set<number>,
): CaptureMatch[] {
  if (!node.isNamed || node.hasError || node.isMissing) unsupported();
  let names: SyntaxNode[];
  if (node.type === 'for_in_statement') {
    const kind = node.childForFieldName('kind');
    if (!kind) return [];
    if (kind.type !== 'var') unsupported();
    const left = node.childForFieldName('left');
    if (!left) unsupported();
    names = [left];
  } else {
    if (
      node.type !== 'variable_declaration' ||
      !node.children.some((child) => !child.isNamed && child.type === 'var')
    )
      unsupported();
    const declarators = node.namedChildren.filter((child) => child.type !== 'comment');
    if (declarators.length === 0) unsupported();
    names = declarators.map((declarator) => {
      if (declarator.type !== 'variable_declarator' || declarator.hasError || declarator.isMissing)
        unsupported();
      const name = declarator.childForFieldName('name');
      if (!name) unsupported();
      return name;
    });
  }
  for (const name of names) {
    if (
      name.type !== 'identifier' ||
      !name.isNamed ||
      name.hasError ||
      name.isMissing ||
      !IDENTIFIER.test(name.text)
    )
      unsupported();
  }
  const declaredNames = new Set(names.map((name) => name.text));
  let ancestor = node.parent;
  let host: SyntaxNode | null = null;
  let kind = '';
  while (ancestor) {
    if (ancestor.hasError || ancestor.isMissing) unsupported();
    if (['program', 'statement_block', 'for_statement'].includes(ancestor.type)) {
      let collisions = siblingNames.get(ancestor.id);
      if (!collisions) {
        const collected = new Set<string>();
        for (const declaration of ancestor.namedChildren) {
          if (DECLARATIONS.has(declaration.type)) {
            const name = declaration.childForFieldName('name');
            if (name) collected.add(name.text);
          }
          if (declaration.type === 'lexical_declaration') {
            for (const binding of emitTypeScriptLexicalBindingCaptures(declaration)) {
              collected.add(binding['@declaration.name']!.text);
            }
          }
        }
        siblingNames.set(ancestor.id, collected);
        collisions = collected;
      }
      for (const name of declaredNames) if (collisions.has(name)) unsupported();
    }
    if (ancestor.type === 'switch_body') unsupported();
    if (
      ancestor.type === 'for_in_statement' &&
      ['let', 'const'].includes(ancestor.childForFieldName('kind')?.type ?? '')
    ) {
      const left = ancestor.childForFieldName('left');
      if (!left || left.type !== 'identifier' || declaredNames.has(left.text)) unsupported();
    }
    if (FUNCTIONS.has(ancestor.type)) {
      // Reuse the signature gate; default/rest/destructured parameters have a
      // separate environment that this bounded model does not represent.
      if (!validatedSignatures.has(ancestor.id)) {
        emitTypeScriptParameterBindingCaptures(ancestor);
        validatedSignatures.add(ancestor.id);
      }
      if (
        ['function_expression', 'generator_function'].includes(ancestor.type) &&
        declaredNames.has(ancestor.childForFieldName('name')?.text ?? '')
      )
        unsupported();
      host = ancestor;
      kind = 'Function';
      break;
    }
    if (ancestor.type === 'program') {
      host = ancestor;
      kind = 'Module';
      break;
    }
    if (ancestor.type === 'statement_block') {
      if (['internal_module', 'class_static_block'].includes(ancestor.parent?.type ?? '')) {
        host = ancestor;
        kind = 'Block';
        break;
      }
    }
    if (ancestor.type === 'catch_clause') {
      const parameter = ancestor.childForFieldName('parameter');
      if (parameter && (parameter.type !== 'identifier' || declaredNames.has(parameter.text)))
        unsupported();
    }
    // Refuse malformed class field initializers instead of leaking outward.
    if (['class_body', 'internal_module', 'class_static_block'].includes(ancestor.type))
      unsupported();
    ancestor = ancestor.parent;
  }
  if (!host) unsupported();
  return names.map((name) => ({
    '@declaration.variable': capture('@declaration.variable', name, ''),
    '@declaration.name': capture('@declaration.name', name, name.text),
    [BINDING_KIND]: capture(BINDING_KIND, name, 'var'),
    [VAR_HOST]: capture(VAR_HOST, host, kind),
  }));
}

function bindingKind(match: CaptureMatch): 'var' | 'parameter' | null {
  const metadata = match[BINDING_KIND];
  const name = match['@declaration.name'];
  if (!metadata) {
    if (Object.keys(match).some((key) => key.startsWith(BINDING_KIND) || key.startsWith(VAR_HOST)))
      unsupported();
    return null;
  }
  const anchor = match['@declaration.variable'];
  if (
    Object.keys(match).some(
      (key) =>
        (key.startsWith(BINDING_KIND) && key !== BINDING_KIND) ||
        (key.startsWith(VAR_HOST) && key !== VAR_HOST),
    ) ||
    !name ||
    !anchor ||
    metadata.name !== BINDING_KIND ||
    !['var', 'parameter'].includes(metadata.text) ||
    !validRange(metadata.range) ||
    !sameRange(metadata.range, name.range) ||
    !IDENTIFIER.test(name.text) ||
    anchor.name !== '@declaration.variable' ||
    anchor.text !== '' ||
    !sameRange(anchor.range, name.range) ||
    name.name !== '@declaration.name'
  )
    unsupported();
  if ((metadata.text === 'var') !== Boolean(match[VAR_HOST])) unsupported();
  return metadata.text as 'var' | 'parameter';
}

/** Preserve every declaration while choosing one canonical supported binding. */
export function selectTypeScriptLocalBindings(
  candidates: readonly LocalBindingCandidate[],
  host: Scope,
  tree: ScopeTree,
): readonly LocalBindingCandidate[] | null {
  const kinds = candidates.map((candidate) => bindingKind(candidate.match));
  if (!kinds.includes('var')) return null;
  if (kinds.some((kind) => kind === null)) unsupported();
  for (const candidate of candidates) {
    if (
      bindingKind(candidate.match) === 'var' &&
      typeScriptDeclarationBindingScope(candidate.match, host, tree) !== host.id
    )
      unsupported();
  }
  const parameters = candidates.filter((_, index) => kinds[index] === 'parameter');
  if (parameters.length > 1) unsupported();
  if (parameters.length === 1) return parameters;
  let earliest = candidates[0]!;
  let tied = false;
  for (const candidate of candidates.slice(1)) {
    const a = candidate.match['@declaration.name']!.range;
    const b = earliest.match['@declaration.name']!.range;
    const order =
      a.startLine - b.startLine ||
      a.startCol - b.startCol ||
      a.endLine - b.endLine ||
      a.endCol - b.endCol;
    if (order < 0) {
      earliest = candidate;
      tied = false;
    } else if (order === 0) tied = true;
  }
  if (tied) unsupported();
  return [earliest];
}

/** Preserve structural ownership while selecting the declaration's binding host. */
export function typeScriptDeclarationBindingScope(
  match: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  const localKind = bindingKind(match);
  if (localKind === 'var') {
    const metadata = match[VAR_HOST]!;
    const name = match['@declaration.name']!;
    if (
      metadata.name !== VAR_HOST ||
      !['Module', 'Function', 'Block'].includes(metadata.text) ||
      !validRange(metadata.range) ||
      !contains(metadata.range, name.range) ||
      Object.keys(match).some((key) => key.startsWith(METADATA))
    )
      unsupported();
    let current = tree.getScope(innermost.id);
    if (
      !current ||
      current.filePath !== innermost.filePath ||
      current.kind !== innermost.kind ||
      current.parent !== innermost.parent ||
      !sameRange(current.range, innermost.range)
    )
      unsupported();
    const seen = new Set<ScopeId>();
    while (current) {
      if (seen.has(current.id)) unsupported();
      seen.add(current.id);
      if (current.kind === metadata.text && sameRange(current.range, metadata.range))
        return current.id;
      if (['Function', 'Module', 'Namespace', 'Class'].includes(current.kind)) unsupported();
      const parent = tree.getParent(current.id);
      if (
        !parent ||
        parent.id !== current.parent ||
        parent.filePath !== innermost.filePath ||
        !contains(parent.range, current.range)
      )
        unsupported();
      current = parent;
    }
    unsupported();
  }
  const metadataKeys = Object.keys(match).filter((key) => key.startsWith(METADATA));
  if (metadataKeys.length === 0) return null;
  if (metadataKeys.length !== 1 || metadataKeys[0] !== METADATA) unsupported();
  const metadata = match[METADATA];
  const name = match['@declaration.name'];
  const anchors = Object.keys(match).filter(
    (key) => key.startsWith('@declaration.') && key !== '@declaration.name',
  );
  if (anchors.length !== 1 || !['@declaration.function', '@declaration.class'].includes(anchors[0]))
    unsupported();
  const anchor = match[anchors[0]];
  for (const [key, item] of [
    [METADATA, metadata],
    ['@declaration.name', name],
    [anchors[0], anchor],
  ] as const) {
    if (
      !item ||
      item.name !== key ||
      typeof item.text !== 'string' ||
      !item.range ||
      !validRange(item.range)
    )
      unsupported();
  }
  if (
    !['parent', 'self'].includes(metadata.text) ||
    !IDENTIFIER.test(name.text) ||
    anchor.text !== '' ||
    !sameRange(metadata.range, name.range) ||
    !contains(anchor.range, name.range)
  )
    unsupported();
  const kind = anchors[0] === '@declaration.function' ? 'Function' : 'Class';
  const stored = tree.getScope(innermost.id);
  if (
    innermost.kind !== kind ||
    !sameRange(innermost.range, anchor.range) ||
    !stored ||
    stored.kind !== kind ||
    stored.parent !== innermost.parent ||
    stored.filePath !== innermost.filePath ||
    !sameRange(stored.range, anchor.range)
  )
    unsupported();
  if (metadata.text === 'self') return stored.id;
  const parent = tree.getParent(stored.id);
  if (
    !parent ||
    parent.id !== stored.parent ||
    parent.filePath !== stored.filePath ||
    !contains(parent.range, stored.range)
  )
    unsupported();
  return parent.id;
}
