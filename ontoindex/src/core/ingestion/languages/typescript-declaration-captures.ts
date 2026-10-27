import type {
  BindingRef,
  Capture,
  CaptureMatch,
  Range,
  Scope,
  ScopeId,
  ScopeTree,
} from 'ontoindex-shared';
import { ScopeUnsupportedSyntaxError } from '../scope-unsupported-syntax.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { LocalBindingCandidate } from '../language-provider.js';

const DECLARATIONS = new Map<
  string,
  readonly ['function' | 'class' | 'enum' | 'interface' | 'typealias', ('parent' | 'self')?]
>([
  ['function_declaration', ['function', 'parent']],
  ['generator_function_declaration', ['function', 'parent']],
  ['function_expression', ['function', 'self']],
  ['generator_function', ['function', 'self']],
  ['class_declaration', ['class', 'parent']],
  ['abstract_class_declaration', ['class', 'parent']],
  ['class', ['class', 'self']],
  ['enum_declaration', ['enum']],
  ['interface_declaration', ['interface', 'parent']],
  ['type_alias_declaration', ['typealias']],
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

function unsupported(node?: SyntaxNode): never {
  throw new ScopeUnsupportedSyntaxError(
    'TS/JS declaration captures require supported named syntax and an exact lexical scope',
    node,
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

/** Validate the bounded annotation subset without emitting value references. */
export function typeScriptAnnotationType(annotation: SyntaxNode): SyntaxNode {
  if (
    annotation.type !== 'type_annotation' ||
    !annotation.isNamed ||
    annotation.hasError ||
    annotation.isMissing
  )
    unsupported(annotation);
  const children = annotation.children.filter((child) => child.type !== 'comment');
  const type = children[1];
  if (
    children.length !== 2 ||
    children[0]!.type !== ':' ||
    children[0]!.isNamed ||
    !type?.isNamed ||
    type.hasError ||
    type.isMissing
  )
    unsupported(annotation);
  validateTypeScriptType(type);
  return type;
}

/** Validate constructor type arguments without emitting value references. */
export function typeScriptTypeArguments(argumentsNode: SyntaxNode): void {
  if (argumentsNode.type !== 'type_arguments') unsupported(argumentsNode);
  validateTypeScriptType(argumentsNode);
}

export function validateTypeScriptType(type: SyntaxNode): void {
  const pending = [type];
  while (pending.length) {
    const current = pending.pop()!;
    if (!current.isNamed || current.hasError || current.isMissing) unsupported(current);
    if (['identifier', 'type_identifier', 'property_identifier'].includes(current.type)) {
      if (!IDENTIFIER.test(current.text)) unsupported(current);
    } else if (current.type === 'predefined_type') {
      if (
        ![
          'any',
          'unknown',
          'never',
          'void',
          'boolean',
          'number',
          'string',
          'object',
          'undefined',
          'null',
          'symbol',
          'bigint',
        ].includes(current.text)
      )
        unsupported(current);
    } else if (current.type === 'literal_type') {
      const parts = current.children.filter((child) => child.type !== 'comment');
      const literal = parts[0];
      if (
        parts.length !== 1 ||
        !literal?.isNamed ||
        !['string', 'number', 'true', 'false', 'null', 'undefined', 'unary_expression'].includes(
          literal.type,
        )
      )
        unsupported(current);
      if (literal.type === 'unary_expression') {
        const operator = literal.childForFieldName('operator');
        const argument = literal.childForFieldName('argument');
        const operands = literal.children.filter((child) => child.type !== 'comment');
        if (
          operands.length !== 2 ||
          operands[0]!.id !== operator?.id ||
          operator?.type !== '-' ||
          operator.isNamed ||
          operands[1]!.id !== argument?.id ||
          argument?.type !== 'number' ||
          !argument.isNamed
        )
          unsupported(literal);
      }
      const descendants = [current];
      while (descendants.length) {
        const descendant = descendants.pop()!;
        if (descendant.hasError || descendant.isMissing || descendant.type === 'ERROR')
          unsupported(descendant);
        descendants.push(...descendant.children);
      }
    } else if (
      ['nested_type_identifier', 'nested_identifier', 'member_expression'].includes(current.type)
    ) {
      const parts = current.children.filter((child) => child.type !== 'comment');
      if (
        parts.length !== 3 ||
        !parts[0]!.isNamed ||
        parts[1]!.type !== '.' ||
        parts[1]!.isNamed ||
        !parts[2]!.isNamed
      )
        unsupported(current);
      pending.push(parts[0]!, parts[2]!);
    } else if (current.type === 'generic_type') {
      const name = current.childForFieldName('name');
      const argumentsNode = current.childForFieldName('type_arguments');
      const parts = current.children.filter((child) => child.type !== 'comment');
      if (
        parts.length !== 2 ||
        parts[0]!.id !== name?.id ||
        parts[1]!.id !== argumentsNode?.id ||
        !name?.isNamed ||
        !['type_identifier', 'nested_type_identifier'].includes(name.type) ||
        argumentsNode?.type !== 'type_arguments' ||
        !argumentsNode.isNamed ||
        argumentsNode.hasError ||
        argumentsNode.isMissing
      )
        unsupported(current);
      pending.push(name, argumentsNode);
    } else if (current.type === 'type_arguments') {
      const argumentsParts = current.children.filter((child) => child.type !== 'comment');
      if (
        argumentsParts.length < 3 ||
        argumentsParts[0]!.type !== '<' ||
        argumentsParts[0]!.isNamed ||
        argumentsParts.at(-1)!.type !== '>' ||
        argumentsParts.at(-1)!.isNamed ||
        argumentsParts.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      for (let index = 1; index < argumentsParts.length - 1; index++) {
        const part = argumentsParts[index]!;
        if (index % 2 === 0) {
          if (part.type !== ',' || part.isNamed) unsupported(part);
        } else {
          if (!part.isNamed) unsupported(part);
          pending.push(part);
        }
      }
    } else if (current.type === 'tuple_type') {
      const parts = current.children.filter((child) => child.type !== 'comment');
      if (
        parts.length < 2 ||
        parts[0]!.type !== '[' ||
        parts[0]!.isNamed ||
        parts.at(-1)!.type !== ']' ||
        parts.at(-1)!.isNamed ||
        parts.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      for (let index = 1; index < parts.length - 1; index++) {
        const part = parts[index]!;
        if (index % 2 === 0) {
          if (part.type !== ',' || part.isNamed) unsupported(part);
        } else {
          if (!part.isNamed) unsupported(part);
          pending.push(part);
        }
      }
    } else if (current.type === 'function_type') {
      const parameters = current.childForFieldName('parameters');
      const result = current.childForFieldName('return_type');
      const parts = current.children.filter((child) => child.type !== 'comment');
      if (
        parts.length !== 3 ||
        parameters?.type !== 'formal_parameters' ||
        !parameters.isNamed ||
        parts[0]!.id !== parameters.id ||
        parts[1]!.type !== '=>' ||
        parts[1]!.isNamed ||
        !result?.isNamed ||
        parts[2]!.id !== result.id ||
        parts.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      const entries = parameters.children.filter((child) => child.type !== 'comment');
      if (
        entries[0]?.type !== '(' ||
        entries[0].isNamed ||
        entries.at(-1)?.type !== ')' ||
        entries.at(-1)!.isNamed ||
        entries.some((child) => child.hasError || child.isMissing)
      )
        unsupported(parameters);
      for (let index = 1; index < entries.length - 1; index++) {
        const entry = entries[index]!;
        if (index % 2 === 0) {
          if (entry.type !== ',' || entry.isNamed) unsupported(entry);
          continue;
        }
        const name = entry.childForFieldName('pattern');
        const annotation = entry.childForFieldName('type');
        const optional = entry.type === 'optional_parameter';
        const tokens = entry.children.filter((child) => child.type !== 'comment');
        if (
          !entry.isNamed ||
          (!optional && entry.type !== 'required_parameter') ||
          name?.type !== 'identifier' ||
          !name.isNamed ||
          !IDENTIFIER.test(name.text) ||
          annotation?.type !== 'type_annotation' ||
          !annotation.isNamed ||
          tokens.length !== (optional ? 3 : 2) ||
          tokens[0]!.id !== name.id ||
          tokens.at(-1)!.id !== annotation.id ||
          (optional && (tokens[1]!.type !== '?' || tokens[1]!.isNamed)) ||
          tokens.some((child) => child.hasError || child.isMissing)
        )
          unsupported(entry);
        const typeParts = annotation.children.filter((child) => child.type !== 'comment');
        if (
          typeParts.length !== 2 ||
          typeParts[0]!.type !== ':' ||
          typeParts[0]!.isNamed ||
          !typeParts[1]!.isNamed ||
          typeParts.some((child) => child.hasError || child.isMissing)
        )
          unsupported(annotation);
        // Signature parameter names are type-only; only validate their types.
        pending.push(typeParts[1]!);
      }
      pending.push(result);
    } else if (current.type === 'parenthesized_type') {
      const parts = current.children.filter((child) => child.type !== 'comment');
      if (
        parts.length !== 3 ||
        parts[0]!.type !== '(' ||
        parts[0]!.isNamed ||
        !parts[1]!.isNamed ||
        parts[2]!.type !== ')' ||
        parts[2]!.isNamed ||
        parts.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      pending.push(parts[1]!);
    } else if (current.type === 'array_type' || current.type === 'readonly_type') {
      const parts = current.children.filter((child) => child.type !== 'comment');
      if (parts.some((child) => child.hasError || child.isMissing)) unsupported(current);
      if (current.type === 'array_type') {
        if (
          parts.length !== 3 ||
          !parts[0]!.isNamed ||
          parts[1]!.type !== '[' ||
          parts[1]!.isNamed ||
          parts[2]!.type !== ']' ||
          parts[2]!.isNamed
        )
          unsupported(current);
        pending.push(parts[0]!);
      } else {
        if (
          parts.length !== 2 ||
          parts[0]!.type !== 'readonly' ||
          parts[0]!.isNamed ||
          !parts[1]!.isNamed
        )
          unsupported(current);
        pending.push(parts[1]!);
      }
    } else if (current.type === 'object_type') {
      const members = current.children.filter((child) => child.type !== 'comment');
      if (
        members.length < 2 ||
        members[0]!.type !== '{' ||
        members[0]!.isNamed ||
        members.at(-1)!.type !== '}' ||
        members.at(-1)!.isNamed ||
        members.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      for (let index = 1; index < members.length - 1; index++) {
        const member = members[index]!;
        if (index % 2 === 0) {
          if (member.isNamed || ![';', ','].includes(member.type)) unsupported(member);
          continue;
        }
        if (member.type !== 'property_signature' || !member.isNamed) unsupported(member);
        const name = member.childForFieldName('name');
        const annotation = member.childForFieldName('type');
        const parts = member.children.filter((child) => child.type !== 'comment');
        const readonly = parts[0]?.type === 'readonly' && !parts[0].isNamed;
        const offset = Number(readonly);
        const optional = parts[offset + 1]?.type === '?' && !parts[offset + 1].isNamed;
        if (
          name?.type !== 'property_identifier' ||
          !name.isNamed ||
          !IDENTIFIER.test(name.text) ||
          annotation?.type !== 'type_annotation' ||
          !annotation.isNamed ||
          parts.length !== offset + Number(optional) + 2 ||
          parts[offset]!.id !== name.id ||
          parts.at(-1)!.id !== annotation.id ||
          parts.some((child) => child.hasError || child.isMissing)
        )
          unsupported(member);
        const annotationParts = annotation.children.filter((child) => child.type !== 'comment');
        const value = annotationParts[1];
        if (
          annotationParts.length !== 2 ||
          annotationParts[0]!.type !== ':' ||
          annotationParts[0]!.isNamed ||
          !value?.isNamed ||
          annotationParts.some((child) => child.hasError || child.isMissing)
        )
          unsupported(annotation);
        pending.push(value);
      }
    } else if (current.type === 'lookup_type') {
      const parts = current.children.filter((child) => child.type !== 'comment');
      if (
        parts.length !== 4 ||
        !parts[0]!.isNamed ||
        parts[1]!.type !== '[' ||
        parts[1]!.isNamed ||
        !parts[2]!.isNamed ||
        parts[3]!.type !== ']' ||
        parts[3]!.isNamed ||
        parts.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      pending.push(parts[0]!, parts[2]!);
    } else if (current.type === 'union_type') {
      const parts = current.children.filter((child) => child.type !== 'comment');
      const separator = parts.length === 2 ? 0 : 1;
      if (
        (parts.length !== 2 && parts.length !== 3) ||
        parts[separator]!.type !== '|' ||
        parts[separator]!.isNamed ||
        !parts.at(-1)!.isNamed ||
        (separator === 1 && !parts[0]!.isNamed) ||
        parts.some((child) => child.hasError || child.isMissing)
      )
        unsupported(current);
      if (separator === 1) pending.push(parts[0]!);
      pending.push(parts.at(-1)!);
    } else unsupported(current);
  }
}

function annotationCapture(declarator: SyntaxNode): CaptureMatch {
  const annotation = declarator.childForFieldName('type');
  if (!annotation) return {};
  const type = typeScriptAnnotationType(annotation);
  return { '@typescript.annotation': capture('@typescript.annotation', type, type.text) };
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

function validateStringEnum(node: SyntaxNode): void {
  const parent = node.parent;
  if (
    parent?.type !== 'program' &&
    !(
      parent?.type === 'export_statement' &&
      parent.parent?.type === 'program' &&
      parent.childForFieldName('declaration')?.id === node.id
    )
  )
    unsupported(node);
  const name = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  const children = node.children.filter((child) => child.type !== 'comment');
  if (
    children.length !== 3 ||
    children[0]!.type !== 'enum' ||
    children[0]!.isNamed ||
    children[1]!.id !== name?.id ||
    children[2]!.id !== body?.id ||
    name?.type !== 'identifier' ||
    !body?.isNamed ||
    body.type !== 'enum_body' ||
    children.some((child) => child.hasError || child.isMissing)
  )
    unsupported(node);
  const members = body.children.filter((child) => child.type !== 'comment');
  if (
    members.length < 2 ||
    members[0]!.type !== '{' ||
    members[0]!.isNamed ||
    members.at(-1)!.type !== '}' ||
    members.at(-1)!.isNamed ||
    members.some((child) => child.hasError || child.isMissing)
  )
    unsupported(body);
  const names = new Set<string>();
  for (let index = 1; index < members.length - 1; index++) {
    const member = members[index]!;
    if (index % 2 === 0) {
      if (member.type !== ',' || member.isNamed) unsupported(member);
      continue;
    }
    const memberName = member.childForFieldName('name');
    const value = member.childForFieldName('value');
    const parts = member.children.filter((child) => child.type !== 'comment');
    if (
      member.type !== 'enum_assignment' ||
      !member.isNamed ||
      memberName?.type !== 'property_identifier' ||
      !memberName.isNamed ||
      !IDENTIFIER.test(memberName.text) ||
      names.has(memberName.text) ||
      value?.type !== 'string' ||
      !value.isNamed ||
      !/^(?:"[^"\\\r\n\u2028\u2029]*"|'[^'\\\r\n\u2028\u2029]*')$/u.test(value.text) ||
      parts.length !== 3 ||
      parts[0]!.id !== memberName.id ||
      parts[1]!.type !== '=' ||
      parts[1]!.isNamed ||
      parts[2]!.id !== value.id ||
      parts.some((child) => child.hasError || child.isMissing)
    )
      unsupported(member);
    names.add(memberName.text);
  }
}

/** Type bodies are syntax-validated and opaque: no RHS evaluation or member dispatch. */
function validateNominalType(node: SyntaxNode): void {
  const parent = node.parent;
  if (
    parent?.type !== 'program' &&
    !(
      parent?.type === 'export_statement' &&
      parent.parent?.type === 'program' &&
      parent.childForFieldName('declaration')?.id === node.id
    )
  )
    unsupported(node);
  const name = node.childForFieldName('name');
  const body = node.childForFieldName(node.type === 'interface_declaration' ? 'body' : 'value');
  const parameters = node.childForFieldName('type_parameters');
  const parts = node.children.filter((child) => child.type !== 'comment');
  if (
    !name ||
    !body ||
    !body.isNamed ||
    parts[0]?.type !== (node.type === 'interface_declaration' ? 'interface' : 'type') ||
    parts[0]!.isNamed ||
    parts[1]?.id !== name.id ||
    (node.type === 'interface_declaration' && body.type !== 'interface_body') ||
    parts.some(
      (child) =>
        child.hasError ||
        child.isMissing ||
        (child.id !== name.id &&
          child.id !== body.id &&
          child.id !== parameters?.id &&
          child !== parts[0] &&
          !(node.type === 'interface_declaration' && child.type === 'extends_type_clause') &&
          (child.isNamed || !['=', ';'].includes(child.type))),
    )
  )
    unsupported(node);
  if (
    node.type === 'type_alias_declaration' &&
    parts.filter((child) => child.type === '=' && !child.isNamed).length !== 1
  )
    unsupported(node);
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.hasError || current.isMissing || current.type === 'ERROR') unsupported(current);
    pending.push(...current.children);
  }
}

export function typeScriptDeclarationNamespace(
  candidate: LocalBindingCandidate,
): BindingRef['namespace'] {
  if (['Interface', 'TypeAlias'].includes(candidate.def.type)) return 'type';
  return ['Class', 'Enum'].includes(candidate.def.type) ? 'both' : 'value';
}

/** Detach one named declaration and its lexical binding placement when needed. */
export function emitTypeScriptDeclarationCaptures(node: SyntaxNode): CaptureMatch[] {
  const declaration = DECLARATIONS.get(node.type);
  if (!declaration || !node.isNamed || node.hasError || node.isMissing) unsupported(node);
  const [kind, placement] = declaration;
  if (kind === 'enum') validateStringEnum(node);
  if (kind === 'interface' || kind === 'typealias') validateNominalType(node);
  const name = node.childForFieldName('name');
  if (!name) {
    if (placement === 'self') return [];
    return unsupported(node);
  }
  if (
    name.isMissing ||
    name.hasError ||
    !['identifier', 'type_identifier'].includes(name.type) ||
    !IDENTIFIER.test(name.text)
  )
    unsupported(name);
  const anchorKey = `@declaration.${kind}`;
  return [
    {
      [anchorKey]: capture(anchorKey, node, ''),
      '@declaration.name': capture('@declaration.name', name, name.text),
      ...(placement ? { [METADATA]: capture(METADATA, name, placement) } : {}),
    },
  ];
}

/** Signature metadata stays detached and uses the existing definition fields. */
export function typeScriptSignatureCaptures(node: SyntaxNode): CaptureMatch {
  const bindings = emitTypeScriptParameterBindingCaptures(node);
  const parameters = node.childForFieldName('parameters');
  const entries = parameters?.namedChildren.filter((child) => child.type !== 'comment') ?? [];
  let optional = false;
  let required = 0;
  for (const entry of entries) {
    if (
      entry.type === 'optional_parameter' ||
      entry.type === 'assignment_pattern' ||
      entry.childForFieldName('value')
    )
      optional = true;
    else if (optional) unsupported(entry);
    else required++;
  }
  const annotation = node.childForFieldName('return_type');
  const type = annotation ? typeScriptAnnotationType(annotation) : null;
  return {
    '@declaration.parameter_count': capture(
      '@declaration.parameter_count',
      node,
      String(parameters ? entries.length : bindings.length),
    ),
    '@declaration.required_parameter_count': capture(
      '@declaration.required_parameter_count',
      node,
      String(parameters ? required : bindings.length),
    ),
    ...(type
      ? { '@declaration.return_type': capture('@declaration.return_type', type, type.text) }
      : {}),
  };
}

/** Class members refer to the same class anchor used by the class declaration. */
export function emitTypeScriptMemberCaptures(node: SyntaxNode, owner: SyntaxNode): CaptureMatch[] {
  const name = node.childForFieldName('name');
  const ownerName = owner.childForFieldName('name');
  if (!name || name.type !== 'property_identifier' || !IDENTIFIER.test(name.text) || !ownerName)
    unsupported(node);
  const method = node.type === 'method_definition';
  const annotation = node.childForFieldName('type');
  const type = annotation ? typeScriptAnnotationType(annotation) : null;
  return [
    {
      [method ? '@declaration.method' : '@declaration.property']: capture(
        method ? '@declaration.method' : '@declaration.property',
        node,
        '',
      ),
      '@declaration.name': capture('@declaration.name', name, name.text),
      '@declaration.owner': capture('@declaration.owner', owner, ownerName.text),
      '@declaration.qualified_name': capture(
        '@declaration.qualified_name',
        name,
        `${ownerName.text}.${name.text}`,
      ),
      ...(method ? { [METADATA]: capture(METADATA, name, 'parent') } : {}),
      ...(method ? typeScriptSignatureCaptures(node) : {}),
      ...(type
        ? { '@declaration.declared_type': capture('@declaration.declared_type', type, type.text) }
        : {}),
    },
  ];
}

/** Constructor headers have no modifiers, computed names or return annotation. */
export function typeScriptConstructorDeclarationCaptures(
  node: SyntaxNode,
  owner: SyntaxNode,
): CaptureMatch[] {
  validateConstructorHeader(node, owner);
  return emitTypeScriptMemberCaptures(node, owner);
}

function validateConstructorHeader(node: SyntaxNode, owner: SyntaxNode): void {
  const name = node.childForFieldName('name');
  const parameters = node.childForFieldName('parameters');
  const body = node.childForFieldName('body');
  const parts = node.children.filter((child) => child.type !== 'comment');
  if (
    node.type !== 'method_definition' ||
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    owner.type !== 'class_declaration' ||
    node.parent?.type !== 'class_body' ||
    node.parent.parent?.id !== owner.id ||
    name?.type !== 'property_identifier' ||
    name.text !== 'constructor' ||
    !name.isNamed ||
    parameters?.type !== 'formal_parameters' ||
    !parameters.isNamed ||
    body?.type !== 'statement_block' ||
    !body.isNamed ||
    parts.length !== 3 ||
    parts[0]!.id !== name.id ||
    parts[1]!.id !== parameters.id ||
    parts[2]!.id !== body.id ||
    parts.some((child) => child.hasError || child.isMissing)
  )
    unsupported(node);
}

/** Validate flat binding names without treating object property keys as bindings. */
function flatBindingNames(name: SyntaxNode): SyntaxNode[] {
  if (!name.isNamed || name.hasError || name.isMissing) unsupported(name);
  if (name.type === 'identifier') {
    if (!IDENTIFIER.test(name.text)) unsupported(name);
    return [name];
  }
  const object = name.type === 'object_pattern';
  if (!object && name.type !== 'array_pattern') unsupported(name);
  const parts = name.children.filter((child) => child.type !== 'comment');
  if (
    parts.length < 3 ||
    parts[0]!.type !== (object ? '{' : '[') ||
    parts[0]!.isNamed ||
    parts.at(-1)!.type !== (object ? '}' : ']') ||
    parts.at(-1)!.isNamed ||
    parts.some((child) => child.hasError || child.isMissing)
  )
    unsupported(name);
  const names: SyntaxNode[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < parts.length - 1; index++) {
    const part = parts[index]!;
    if (index % 2 === 0) {
      if (part.type !== ',' || part.isNamed) unsupported(part);
      continue;
    }
    let binding = part;
    if (object && part.type === 'pair_pattern') {
      const key = part.childForFieldName('key');
      const value = part.childForFieldName('value');
      const pair = part.children.filter((child) => child.type !== 'comment');
      if (
        !part.isNamed ||
        key?.type !== 'property_identifier' ||
        !key.isNamed ||
        !IDENTIFIER.test(key.text) ||
        value?.type !== 'identifier' ||
        pair.length !== 3 ||
        pair[0]!.id !== key.id ||
        pair[1]!.type !== ':' ||
        pair[1]!.isNamed ||
        pair[2]!.id !== value.id ||
        pair.some((child) => child.hasError || child.isMissing)
      )
        unsupported(part);
      binding = value;
    } else if (part.type !== (object ? 'shorthand_property_identifier_pattern' : 'identifier')) {
      unsupported(part);
    }
    if (!binding.isNamed || !IDENTIFIER.test(binding.text) || seen.has(binding.text))
      unsupported(binding);
    seen.add(binding.text);
    names.push(binding);
  }
  if (names.length === 0) unsupported(name);
  return names;
}

/** Admit bounded declaration headers with a block or expression body. */
export function typeScriptForInDeclaration(node: SyntaxNode): {
  kind: SyntaxNode;
  left: SyntaxNode;
  right: SyntaxNode;
  body: SyntaxNode;
} {
  if (node.type !== 'for_in_statement' || !node.isNamed || node.hasError || node.isMissing)
    unsupported(node);
  const kind = node.childForFieldName('kind');
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  const body = node.childForFieldName('body');
  const children = node.children.filter((child) => child.type !== 'comment');
  if (
    !kind ||
    kind.isNamed ||
    !['let', 'const', 'var'].includes(kind.type) ||
    !left ||
    !left.isNamed ||
    !right?.isNamed ||
    !body?.isNamed ||
    !['statement_block', 'expression_statement'].includes(body.type) ||
    children.length !== 8 ||
    children[0]!.type !== 'for' ||
    children[0]!.isNamed ||
    children[1]!.type !== '(' ||
    children[1]!.isNamed ||
    children[2]!.id !== kind.id ||
    children[3]!.id !== left.id ||
    !['in', 'of'].includes(children[4]!.type) ||
    children[4]!.isNamed ||
    children[5]!.id !== right.id ||
    children[6]!.type !== ')' ||
    children[6]!.isNamed ||
    children[7]!.id !== body.id ||
    children.some((child) => child.hasError || child.isMissing)
  )
    unsupported(node);
  if (left.type !== 'identifier' && (kind.type !== 'const' || children[4]!.type !== 'of'))
    unsupported(left);
  flatBindingNames(left);
  return { kind, left, right, body };
}

/** Detach identifier let/const bindings at their names, outside initializer scopes. */
export function emitTypeScriptLexicalBindingCaptures(node: SyntaxNode): CaptureMatch[] {
  if (node.type === 'for_in_statement') {
    const { kind, left } = typeScriptForInDeclaration(node);
    if (!['let', 'const'].includes(kind.type)) unsupported(node);
    return flatBindingNames(left).map((name) => ({
      '@declaration.variable': capture('@declaration.variable', name, ''),
      '@declaration.name': capture('@declaration.name', name, name.text),
    }));
  }
  if (
    node.type !== 'lexical_declaration' ||
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    !node.children.some((child) => !child.isNamed && ['let', 'const'].includes(child.type))
  )
    unsupported(node);
  const declarators = node.namedChildren.filter((child) => child.type !== 'comment');
  if (declarators.length === 0) unsupported(node);
  return declarators.flatMap((declarator): CaptureMatch[] => {
    if (declarator.type !== 'variable_declarator' || declarator.hasError || declarator.isMissing)
      unsupported(declarator);
    const name = declarator.childForFieldName('name');
    if (!name || !name.isNamed || name.hasError || name.isMissing) unsupported(name ?? declarator);
    const names: SyntaxNode[] = [];
    if (name.type === 'identifier') {
      if (!IDENTIFIER.test(name.text)) unsupported(name);
      names.push(name);
    } else if (name.type === 'array_pattern') {
      if (
        node.parent?.type === 'ambient_declaration' ||
        (node.parent?.type === 'export_statement' &&
          node.parent.parent?.type === 'ambient_declaration') ||
        declarator.childForFieldName('type') ||
        !declarator.childForFieldName('value')
      )
        unsupported(declarator);
      names.push(...flatBindingNames(name));
    } else unsupported(name);
    const value = declarator.childForFieldName('value');
    // Mutable bindings remain Variables: an initializer cannot prove later callability.
    if (
      name.type === 'identifier' &&
      node.children.some((child) => child.type === 'const' && !child.isNamed) &&
      value &&
      ['arrow_function', 'function_expression'].includes(value.type)
    ) {
      const namedExpression = Boolean(value.childForFieldName('name'));
      return [
        {
          // A named expression already owns its function scope via its private self-name.
          '@declaration.function': capture(
            '@declaration.function',
            namedExpression ? declarator : value,
            '',
          ),
          '@declaration.name': capture('@declaration.name', name, name.text),
          ...(!namedExpression
            ? {
                [METADATA]: capture(METADATA, name, 'parent'),
                '@typescript.callable_binding': capture(
                  '@typescript.callable_binding',
                  declarator,
                  '',
                ),
              }
            : {}),
          ...typeScriptSignatureCaptures(value),
          ...annotationCapture(declarator),
        },
      ];
    }
    return names.map((bindingName) => ({
      '@declaration.variable': capture('@declaration.variable', bindingName, ''),
      '@declaration.name': capture('@declaration.name', bindingName, bindingName.text),
      ...annotationCapture(declarator),
    }));
  });
}

/** Detach a simple catch parameter in its catch scope, outside the body block. */
export function emitTypeScriptCatchBindingCaptures(node: SyntaxNode): CaptureMatch[] {
  if (node.type !== 'catch_clause' || !node.isNamed || node.hasError || node.isMissing)
    unsupported(node);
  const body = node.childForFieldName('body');
  if (!body || body.type !== 'statement_block' || body.hasError || body.isMissing)
    unsupported(node);
  const name = node.childForFieldName('parameter');
  if (!name) return [];
  if (
    node.childForFieldName('type') ||
    name.type !== 'identifier' ||
    !name.isNamed ||
    name.hasError ||
    name.isMissing ||
    !IDENTIFIER.test(name.text)
  )
    unsupported(node);
  for (const declaration of body.namedChildren) {
    if (declaration.type === 'lexical_declaration') {
      for (const binding of emitTypeScriptLexicalBindingCaptures(declaration)) {
        if (binding['@declaration.name']!.text === name.text) unsupported(node);
      }
    } else if (DECLARATIONS.has(declaration.type)) {
      for (const binding of emitTypeScriptDeclarationCaptures(declaration)) {
        if (binding['@declaration.name']!.text === name.text) unsupported(node);
      }
    }
  }
  return [
    {
      '@declaration.variable': capture('@declaration.variable', name, ''),
      '@declaration.name': capture('@declaration.name', name, name.text),
    },
  ];
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
    unsupported(node);
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
      unsupported(parameters);
    const parts = parameters.children.filter((child) => child.type !== 'comment');
    if (
      parts.length < 2 ||
      parts[0]!.type !== '(' ||
      parts[0]!.isNamed ||
      parts.at(-1)!.type !== ')' ||
      parts.at(-1)!.isNamed
    )
      unsupported(parameters);
    for (let index = 1; index < parts.length - 1; index++) {
      const part = parts[index]!;
      if (index % 2 === 0 ? part.isNamed || part.type !== ',' : !part.isNamed) unsupported(part);
    }
    bindings = parameters.namedChildren.filter((child) => child.type !== 'comment');
  } else {
    if (node.type !== 'arrow_function' || !parameter || parameter.type !== 'identifier')
      unsupported(node);
    bindings = [parameter];
  }
  const names = new Set<string>();
  let optional = false;
  let hasDefault = false;
  let hasPattern = false;
  const identifiers = bindings.flatMap((binding) => {
    if (!binding.isNamed || binding.hasError || binding.isMissing) unsupported(binding);
    let name = binding;
    const assignment = binding.type === 'assignment_pattern';
    if (
      binding.type === 'required_parameter' ||
      binding.type === 'optional_parameter' ||
      assignment
    ) {
      const pattern = binding.childForFieldName(assignment ? 'left' : 'pattern');
      const annotation = binding.childForFieldName('type');
      const value = binding.childForFieldName(assignment ? 'right' : 'value');
      if (annotation) typeScriptAnnotationType(annotation);
      const parts = binding.children.filter((child) => child.type !== 'comment');
      const readonly = parts[0]?.type === 'readonly' && !parts[0].isNamed;
      if (readonly) {
        const owner = node.parent?.parent;
        if (binding.type !== 'required_parameter' || pattern?.type !== 'identifier' || !owner)
          unsupported(binding);
        validateConstructorHeader(node, owner);
      }
      const expected = [
        ...(readonly ? ['readonly'] : []),
        pattern,
        ...(binding.type === 'optional_parameter' ? ['?'] : []),
        ...(annotation ? [annotation] : []),
        ...(value ? ['=', value] : []),
      ];
      if (
        !pattern ||
        (assignment && (!value || !!annotation)) ||
        (value && binding.type !== 'required_parameter' && !assignment) ||
        parts.length !== expected.length ||
        parts.some((child, index) => {
          const part = expected[index];
          return (
            child.isMissing ||
            child.hasError ||
            (typeof part === 'string'
              ? child.isNamed || child.type !== part
              : child.id !== part?.id)
          );
        })
      )
        unsupported(binding);
      if (value) {
        const children = value.children.filter((child) => child.type !== 'comment');
        const constructor = value.childForFieldName('constructor');
        const args = value.childForFieldName('arguments');
        const simpleNew =
          value.type === 'new_expression' &&
          constructor?.type === 'identifier' &&
          constructor.isNamed &&
          IDENTIFIER.test(constructor.text) &&
          children.length === 2 + Number(!!args) &&
          children[0]!.type === 'new' &&
          !children[0]!.isNamed &&
          children[1]!.id === constructor.id &&
          (!args || (args.type === 'arguments' && args.isNamed && children[2]!.id === args.id)) &&
          children.every((child) => !child.hasError && !child.isMissing);
        const boolean =
          ['true', 'false'].includes(value.type) &&
          value.text === value.type &&
          children.length === 0;
        if (
          !value.isNamed ||
          value.hasError ||
          value.isMissing ||
          (!boolean &&
            !simpleNew &&
            (value.type !== 'object' ||
              children.length !== 2 ||
              children[0]!.type !== '{' ||
              children[1]!.type !== '}' ||
              children.some((child) => child.isNamed || child.hasError || child.isMissing)))
        )
          unsupported(value);
        hasDefault = true;
      }
      name = pattern;
    }
    if (binding.type === 'optional_parameter' || assignment || binding.childForFieldName('value'))
      optional = true;
    else if (optional) unsupported(binding);
    const destructured = name.type === 'array_pattern' || name.type === 'object_pattern';
    if (destructured) {
      if (binding.type === 'optional_parameter' || assignment || binding.childForFieldName('value'))
        unsupported(binding);
      hasPattern = true;
    }
    return flatBindingNames(name).map((identifier) => {
      if (identifier.text === 'this' || names.has(identifier.text)) unsupported(identifier);
      names.add(identifier.text);
      return { name: identifier, binding: destructured ? undefined : binding };
    });
  });
  if (hasDefault || hasPattern) {
    const body = node.childForFieldName('body');
    if (body?.type === 'statement_block') {
      // A strict directive is an early error with a non-simple parameter list.
      for (const statement of body.namedChildren) {
        if (statement.type === 'comment') continue;
        const expression = statement.namedChildren.filter((child) => child.type !== 'comment');
        if (
          statement.type !== 'expression_statement' ||
          expression.length !== 1 ||
          expression[0]!.type !== 'string'
        )
          break;
        if (['"use strict"', "'use strict'"].includes(expression[0]!.text)) unsupported(statement);
      }
      // Body vars have a separate environment with defaults; do not merge them
      // into the parameter scope. Nested function/class environments are distinct.
      const pending = hasDefault ? [...body.namedChildren] : [];
      while (pending.length) {
        const current = pending.pop()!;
        if (
          FUNCTIONS.has(current.type) ||
          ['class', 'class_declaration', 'abstract_class_declaration'].includes(current.type)
        )
          continue;
        if (
          current.type === 'variable_declaration' ||
          (current.type === 'for_in_statement' && current.childForFieldName('kind')?.type === 'var')
        )
          unsupported(current);
        pending.push(...current.namedChildren);
      }
    }
  }
  return identifiers.map(({ name, binding }) => ({
    '@declaration.variable': capture('@declaration.variable', name, ''),
    '@declaration.name': capture('@declaration.name', name, name.text),
    [BINDING_KIND]: capture(BINDING_KIND, name, 'parameter'),
    ...(binding ? annotationCapture(binding) : {}),
  }));
}

/** Detach identifier var declarations with their actual variable environment. */
export function emitTypeScriptVarBindingCaptures(node: SyntaxNode): CaptureMatch[] {
  return emitVarBindingCaptures(node, new Map(), new Set());
}

/** Share visited environment validation within one borrowed program root. */
export function emitTypeScriptVarBindingCapturesForFile(root: SyntaxNode): CaptureMatch[] {
  if (root.type !== 'program' || !root.isNamed || root.hasError || root.isMissing)
    unsupported(root);
  return emitTypeScriptVarBindingCapturesForNodes(
    root.descendantsOfType(['variable_declaration', 'for_in_statement']),
  ).flat();
}

/** Share environment validation only among selected nodes in one borrowed tree. */
export function emitTypeScriptVarBindingCapturesForNodes(
  nodes: readonly SyntaxNode[],
): CaptureMatch[][] {
  const tree = nodes[0]?.tree;
  if (tree) {
    const root = tree.rootNode;
    if (root.type !== 'program' || !root.isNamed || root.hasError || root.isMissing)
      unsupported(root);
    if (nodes.some((node) => node.tree !== tree)) unsupported(root);
  }
  const siblingNames = new Map<number, ReadonlySet<string>>();
  const validatedSignatures = new Set<number>();
  return nodes.map((node) => emitVarBindingCaptures(node, siblingNames, validatedSignatures));
}

function emitVarBindingCaptures(
  node: SyntaxNode,
  siblingNames: Map<number, ReadonlySet<string>>,
  validatedSignatures: Set<number>,
): CaptureMatch[] {
  if (!node.isNamed || node.hasError || node.isMissing) unsupported(node);
  let names: SyntaxNode[];
  if (node.type === 'for_in_statement') {
    const kind = node.childForFieldName('kind');
    if (!kind) return [];
    if (kind.type !== 'var') unsupported(kind);
    const left = node.childForFieldName('left');
    if (!left) unsupported(node);
    names = [left];
  } else {
    if (
      node.type !== 'variable_declaration' ||
      !node.children.some((child) => !child.isNamed && child.type === 'var')
    )
      unsupported(node);
    const declarators = node.namedChildren.filter((child) => child.type !== 'comment');
    if (declarators.length === 0) unsupported(node);
    names = declarators.map((declarator) => {
      if (declarator.type !== 'variable_declarator' || declarator.hasError || declarator.isMissing)
        unsupported(declarator);
      const name = declarator.childForFieldName('name');
      if (!name) unsupported(declarator);
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
      unsupported(name);
  }
  const declaredNames = new Set(names.map((name) => name.text));
  let ancestor = node.parent;
  let host: SyntaxNode | null = null;
  let kind = '';
  while (ancestor) {
    if (ancestor.hasError || ancestor.isMissing) unsupported(ancestor);
    if (['program', 'statement_block', 'for_statement'].includes(ancestor.type)) {
      let collisions = siblingNames.get(ancestor.id);
      if (!collisions) {
        const collected = new Set<string>();
        for (const sibling of ancestor.namedChildren) {
          let declaration =
            sibling.type === 'export_statement'
              ? (sibling.childForFieldName('declaration') ?? sibling)
              : sibling;
          if (declaration.type === 'ambient_declaration') {
            const children = declaration.namedChildren.filter((child) => child.type !== 'comment');
            if (children.length !== 1 || children[0]!.type !== 'lexical_declaration')
              unsupported(declaration);
            declaration = children[0]!;
          }
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
      for (const name of declaredNames) if (collisions.has(name)) unsupported(ancestor);
    }
    if (ancestor.type === 'switch_body') unsupported(ancestor);
    if (
      (ancestor.type === 'for_in_statement' &&
        ['let', 'const'].includes(ancestor.childForFieldName('kind')?.type ?? '')) ||
      (ancestor.type === 'for_statement' &&
        ancestor.childForFieldName('initializer')?.type === 'lexical_declaration')
    ) {
      const declaration =
        ancestor.type === 'for_statement' ? ancestor.childForFieldName('initializer')! : ancestor;
      for (const binding of emitTypeScriptLexicalBindingCaptures(declaration)) {
        if (declaredNames.has(binding['@declaration.name']!.text)) unsupported(ancestor);
      }
    }
    if (FUNCTIONS.has(ancestor.type)) {
      // The signature gate rejects body vars in defaulted parameter environments.
      if (!validatedSignatures.has(ancestor.id)) {
        emitTypeScriptParameterBindingCaptures(ancestor);
        validatedSignatures.add(ancestor.id);
      }
      if (
        ['function_expression', 'generator_function'].includes(ancestor.type) &&
        declaredNames.has(ancestor.childForFieldName('name')?.text ?? '')
      )
        unsupported(ancestor);
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
        unsupported(ancestor);
    }
    // Refuse malformed class field initializers instead of leaking outward.
    if (['class_body', 'internal_module', 'class_static_block'].includes(ancestor.type))
      unsupported(ancestor);
    ancestor = ancestor.parent;
  }
  if (!host) unsupported(node);
  return names.map((name) => ({
    '@declaration.variable': capture('@declaration.variable', name, ''),
    '@declaration.name': capture('@declaration.name', name, name.text),
    [BINDING_KIND]: capture(BINDING_KIND, name, 'var'),
    [VAR_HOST]: capture(VAR_HOST, host, kind),
    ...annotationCapture(name.parent!),
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
  if (metadataKeys.length === 0) {
    // A callable marker is only valid together with its binding-scope metadata.
    if (match['@typescript.callable_binding']) unsupported();
    return null;
  }
  if (metadataKeys.length !== 1 || metadataKeys[0] !== METADATA) unsupported();
  const metadata = match[METADATA];
  const name = match['@declaration.name'];
  const anchors = Object.keys(match).filter((key) =>
    [
      '@declaration.function',
      '@declaration.class',
      '@declaration.method',
      '@declaration.interface',
    ].includes(key),
  );
  if (anchors.length !== 1) unsupported();
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
  const callableBinding = match['@typescript.callable_binding'];
  if (
    callableBinding &&
    (anchors[0] !== '@declaration.function' ||
      metadata.text !== 'parent' ||
      callableBinding.name !== '@typescript.callable_binding' ||
      callableBinding.text !== '' ||
      !validRange(callableBinding.range) ||
      !contains(callableBinding.range, anchor.range) ||
      !contains(callableBinding.range, name.range) ||
      contains(anchor.range, name.range) ||
      callableBinding.range.endLine !== anchor.range.endLine ||
      callableBinding.range.endCol !== anchor.range.endCol ||
      callableBinding.range.startLine !== name.range.startLine ||
      callableBinding.range.startCol !== name.range.startCol)
  )
    unsupported();
  if (
    !['parent', 'self'].includes(metadata.text) ||
    !IDENTIFIER.test(name.text) ||
    anchor.text !== '' ||
    !sameRange(metadata.range, name.range) ||
    (!callableBinding && !contains(anchor.range, name.range))
  )
    unsupported();
  const kind = ['@declaration.class', '@declaration.interface'].includes(anchors[0])
    ? 'Class'
    : 'Function';
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
    !contains(parent.range, stored.range) ||
    (callableBinding && !contains(parent.range, callableBinding.range))
  )
    unsupported();
  return parent.id;
}
