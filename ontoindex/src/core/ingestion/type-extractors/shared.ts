import type { SyntaxNode } from '../utils/ast-helpers.js';

/** Whether a nearer TS/JS value binding hides a program-level name. */
export function isNameShadowed(node: SyntaxNode, name: string): boolean {
  const binds = (pattern: SyntaxNode | null): boolean => {
    const pending = pattern ? [pattern] : [];
    while (pending.length) {
      const current = pending.pop()!;
      if (
        ['identifier', 'type_identifier', 'shorthand_property_identifier_pattern'].includes(
          current.type,
        )
      ) {
        if (current.text === name) return true;
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
  };

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
    if (current.type !== 'statement_block') continue;
    for (const statement of current.namedChildren) {
      if (
        ['class_declaration', 'function_declaration', 'generator_function_declaration'].includes(
          statement.type,
        )
      ) {
        if (binds(statement.childForFieldName('name'))) return true;
      } else if (['lexical_declaration', 'variable_declaration'].includes(statement.type)) {
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
