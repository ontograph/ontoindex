// Pure re-export barrel — no logic lives here.
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
