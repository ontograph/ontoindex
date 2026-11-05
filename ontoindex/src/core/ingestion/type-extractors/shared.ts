import type { SyntaxNode } from '../utils/ast-helpers.js';

/** Visit TS/JS binding names, stopping when the visitor returns true. */
export function forEachPatternName(
  pattern: SyntaxNode | null,
  visit: (name: string) => boolean | void,
): boolean {
  const pending = pattern ? [pattern] : [];
  while (pending.length) {
    const current = pending.pop()!;
    if (
      ['identifier', 'type_identifier', 'shorthand_property_identifier_pattern'].includes(
        current.type,
      )
    ) {
      if (visit(current.text) === true) return true;
    } else if (current.type === 'pair_pattern') {
      const value = current.childForFieldName('value');
      if (value) pending.push(value);
    } else if (['assignment_pattern', 'object_assignment_pattern'].includes(current.type)) {
      const left = current.childForFieldName('left');
      if (left) pending.push(left);
    } else if (
      ['required_parameter', 'optional_parameter', 'rest_parameter'].includes(current.type)
    ) {
      const parameter = current.childForFieldName('pattern');
      if (parameter) pending.push(parameter);
    } else if (
      ['formal_parameters', 'rest_pattern', 'object_pattern', 'array_pattern'].includes(
        current.type,
      )
    ) {
      pending.push(...current.namedChildren);
    }
  }
  return false;
}

/** Whether a nearer TS/JS value binding hides a program-level name. */
export function isNameShadowed(node: SyntaxNode, name: string): boolean {
  const binds = (pattern: SyntaxNode | null): boolean =>
    forEachPatternName(pattern, (binding) => binding === name);

  for (
    let current: SyntaxNode | null = node;
    current && current.type !== 'program';
    current = current.parent
  ) {
    if (binds(current.childForFieldName('parameters'))) return true;
    if (current.type === 'arrow_function' && binds(current.childForFieldName('parameter')))
      return true;
    if (current.type === 'catch_clause' && binds(current.childForFieldName('parameter')))
      return true;
    if (current.type === 'for_in_statement' && binds(current.childForFieldName('left')))
      return true;
    if (
      current.type === 'class_static_block' ||
      (current.type === 'statement_block' &&
        current.parent?.childForFieldName('body')?.id === current.id &&
        [
          'function_declaration',
          'function_expression',
          'generator_function_declaration',
          'generator_function',
          'arrow_function',
          'method_definition',
        ].includes(current.parent.type))
    ) {
      // var is hoisted through blocks, but never out of a nested function, class, or static block.
      const pending = [...current.namedChildren];
      while (pending.length) {
        const descendant = pending.pop()!;
        // Conservatively include Annex B block-function bindings before skipping their bodies.
        if (
          ['function_declaration', 'generator_function_declaration'].includes(descendant.type) &&
          binds(descendant.childForFieldName('name'))
        )
          return true;
        if (
          [
            'function_declaration',
            'function_expression',
            'generator_function_declaration',
            'generator_function',
            'arrow_function',
            'method_definition',
            'class_declaration',
            'class',
            'class_body',
            'class_static_block',
          ].includes(descendant.type)
        )
          continue;
        if (descendant.type === 'variable_declaration') {
          for (const declaration of descendant.namedChildren) {
            if (binds(declaration.childForFieldName('name'))) return true;
          }
        }
        if (
          descendant.type === 'for_in_statement' &&
          descendant.children.some((child) => child.type === 'var') &&
          binds(descendant.childForFieldName('left'))
        )
          return true;
        pending.push(...descendant.namedChildren);
      }
    }
    const initializer =
      current.type === 'for_statement' ? current.childForFieldName('initializer') : null;
    const statements = initializer
      ? [initializer]
      : current.type === 'switch_body'
        ? current.namedChildren.flatMap((clause) => clause.namedChildren)
        : ['statement_block', 'class_static_block', 'switch_case', 'switch_default'].includes(
              current.type,
            )
          ? current.namedChildren
          : [];
    for (const statement of statements) {
      if (
        ['class_declaration', 'function_declaration', 'generator_function_declaration'].includes(
          statement.type,
        )
      ) {
        if (binds(statement.childForFieldName('name'))) return true;
      } else if (
        ['lexical_declaration', 'variable_declaration', 'using_declaration'].includes(
          statement.type,
        )
      ) {
        for (const declaration of statement.namedChildren) {
          if (
            declaration.type === 'variable_declarator' &&
            binds(declaration.childForFieldName('name'))
          )
            return true;
        }
      }
    }
  }
  return false;
}

// All symbols are split into focused modules:
//   container-types.ts      — container/iterable type descriptors and resolution
//   type-name-extractor.ts  — name extraction functions and AST type helpers
//   ast-call-helpers.ts     — AST traversal and call expression helpers
//   return-type-extractor.ts — return type and element type extraction

export type { TypeArgPosition } from './return-type-extractor.js';
export {
  methodToTypeArgPosition,
  getContainerDescriptor,
  resolveIterableElementType,
} from './container-types.js';
export {
  NULLABLE_WRAPPER_TYPES,
  extractSimpleTypeName,
  extractVarName,
  TYPED_PARAMETER_TYPES,
  extractGenericTypeArgs,
  extractRubyConstructorAssignment,
  hasTypeAnnotation,
  NULLABLE_KEYWORDS,
  stripNullable,
} from './type-name-extractor.js';
export { unwrapAwait, extractCalleeName } from './ast-call-helpers.js';
export { extractElementTypeFromString, extractReturnTypeName } from './return-type-extractor.js';
