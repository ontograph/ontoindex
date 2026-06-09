import type { SyntaxNode } from '../utils/ast-helpers.js';

/** Known single-arg nullable wrapper types that unwrap to their inner type
 *  for receiver resolution. Optional<User> → "User", Option<User> → "User".
 *  Only nullable wrappers — NOT containers (List, Vec) or async wrappers (Promise, Future).
 *  See WRAPPER_GENERICS in return-type-extractor for the full set used in return-type inference. */
export const NULLABLE_WRAPPER_TYPES = new Set([
  'Optional', // Java
  'Option', // Rust, Scala
  'Maybe', // Haskell-style, Kotlin Arrow
]);

/**
 * Extract the simple type name from a type AST node.
 * Handles generic types (e.g., List<User> → List), qualified names
 * (e.g., models.User → User), and nullable types (e.g., User? → User).
 * Returns undefined for complex types (unions, intersections, function types).
 */
export const extractSimpleTypeName = (typeNode: SyntaxNode, depth = 0): string | undefined => {
  if (depth > 50 || typeNode.text.length > 2048) return undefined;
  // Direct type identifier (includes Ruby 'constant' for class names)
  if (
    typeNode.type === 'type_identifier' ||
    typeNode.type === 'identifier' ||
    typeNode.type === 'simple_identifier' ||
    typeNode.type === 'constant'
  ) {
    return typeNode.text;
  }

  // Qualified/scoped names: take the last segment (e.g., models.User → User, Models::User → User)
  if (
    typeNode.type === 'scoped_identifier' ||
    typeNode.type === 'qualified_identifier' ||
    typeNode.type === 'scoped_type_identifier' ||
    typeNode.type === 'qualified_name' ||
    typeNode.type === 'qualified_type' ||
    typeNode.type === 'member_expression' ||
    typeNode.type === 'member_access_expression' ||
    typeNode.type === 'attribute' ||
    typeNode.type === 'scope_resolution' ||
    typeNode.type === 'selector_expression'
  ) {
    const last = typeNode.lastNamedChild;
    if (
      last &&
      (last.type === 'type_identifier' ||
        last.type === 'identifier' ||
        last.type === 'simple_identifier' ||
        last.type === 'name' ||
        last.type === 'constant' ||
        last.type === 'property_identifier' ||
        last.type === 'field_identifier')
    ) {
      return last.text;
    }
  }

  // C++ template_type (e.g., vector<User>, map<string, User>): extract base name
  if (typeNode.type === 'template_type') {
    const base = typeNode.childForFieldName('name') ?? typeNode.firstNamedChild;
    if (base) return extractSimpleTypeName(base, depth + 1);
  }

  // Generic types: extract the base type (e.g., List<User> → List)
  // For nullable wrappers (Optional<User>, Option<User>), unwrap to inner type.
  if (
    typeNode.type === 'generic_type' ||
    typeNode.type === 'parameterized_type' ||
    typeNode.type === 'generic_name'
  ) {
    const base =
      typeNode.childForFieldName('name') ??
      typeNode.childForFieldName('type') ??
      typeNode.firstNamedChild;
    if (!base) return undefined;
    const baseName = extractSimpleTypeName(base, depth + 1);
    // Unwrap known nullable wrappers: Optional<User> → User, Option<User> → User
    if (baseName && NULLABLE_WRAPPER_TYPES.has(baseName)) {
      const args = extractGenericTypeArgs(typeNode);
      if (args.length >= 1) return args[0];
    }
    return baseName;
  }

  // Nullable types (Kotlin User?, C# User?)
  if (typeNode.type === 'nullable_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner, depth + 1);
  }

  // Nullable union types (TS/JS: User | null, User | undefined, User | null | undefined)
  // Extract the single non-null/undefined type from the union.
  if (typeNode.type === 'union_type') {
    const nonNullTypes: SyntaxNode[] = [];
    for (let i = 0; i < typeNode.namedChildCount; i++) {
      const child = typeNode.namedChild(i);
      if (!child) continue;
      // Skip null/undefined/void literal types
      const text = child.text;
      if (text === 'null' || text === 'undefined' || text === 'void') continue;
      nonNullTypes.push(child);
    }
    // Only unwrap if exactly one meaningful type remains
    if (nonNullTypes.length === 1) {
      return extractSimpleTypeName(nonNullTypes[0], depth + 1);
    }
  }

  // Type annotations that wrap the actual type (TS/Python: `: Foo`, Kotlin: user_type)
  if (
    typeNode.type === 'type_annotation' ||
    typeNode.type === 'type' ||
    typeNode.type === 'user_type'
  ) {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner, depth + 1);
  }

  // Pointer/reference types (C++, Rust): User*, &User, &mut User
  if (typeNode.type === 'pointer_type' || typeNode.type === 'reference_type') {
    // Skip mutable_specifier for Rust &mut references — firstNamedChild would be
    // `mutable_specifier` not the actual type. Walk named children to find the type.
    for (let i = 0; i < typeNode.namedChildCount; i++) {
      const child = typeNode.namedChild(i);
      if (child && child.type !== 'mutable_specifier') {
        return extractSimpleTypeName(child, depth + 1);
      }
    }
  }

  // Primitive/predefined types: string, int, float, bool, number, unknown, any
  // PHP: primitive_type; TS/JS: predefined_type
  // Java: integral_type (int/long/short/byte), floating_point_type (float/double),
  //       boolean_type (boolean), void_type (void)
  if (
    typeNode.type === 'primitive_type' ||
    typeNode.type === 'predefined_type' ||
    typeNode.type === 'integral_type' ||
    typeNode.type === 'floating_point_type' ||
    typeNode.type === 'boolean_type' ||
    typeNode.type === 'void_type'
  ) {
    return typeNode.text;
  }

  // PHP named_type / optional_type
  if (typeNode.type === 'named_type' || typeNode.type === 'optional_type') {
    const inner = typeNode.childForFieldName('name') ?? typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner, depth + 1);
  }

  // Name node (PHP)
  if (typeNode.type === 'name') {
    return typeNode.text;
  }

  return undefined;
};

/**
 * Extract variable name from a declarator or pattern node.
 * Returns the simple identifier text, or undefined for destructuring/complex patterns.
 */
export const extractVarName = (node: SyntaxNode): string | undefined => {
  let current: SyntaxNode | null = node;
  let depth = 0;

  while (current && depth <= 50) {
    if (
      current.type === 'identifier' ||
      current.type === 'simple_identifier' ||
      current.type === 'variable_name' ||
      current.type === 'name' ||
      current.type === 'constant' ||
      current.type === 'property_identifier'
    ) {
      return current.text;
    }

    // variable_declarator (Java/C#): has a 'name' field
    if (current.type === 'variable_declarator') {
      current = current.childForFieldName('name');
      depth++;
      continue;
    }

    // Rust: let mut x = ... — mut_pattern wraps an identifier
    // Swift: pattern node wraps a simple_identifier
    if (current.type === 'mut_pattern' || current.type === 'pattern') {
      current = current.firstNamedChild;
      depth++;
      continue;
    }

    return undefined;
  }

  return undefined;
};

/** Node types for function/method parameters with type annotations */
export const TYPED_PARAMETER_TYPES = new Set([
  'required_parameter', // TS: (x: Foo)
  'optional_parameter', // TS: (x?: Foo)
  'formal_parameter', // Java/Kotlin
  'parameter', // C#/Rust/Go/Python/Swift
  'typed_parameter', // Python: def f(x: Foo) — distinct from 'parameter' in tree-sitter-python
  'parameter_declaration', // C/C++ void f(Type name)
  'simple_parameter', // PHP function(Foo $x)
  'property_promotion_parameter', // PHP 8.0+ constructor promotion: __construct(private Foo $x)
  'closure_parameter', // Rust: |user: User| — typed closure parameters
]);

/**
 * Extract type arguments from a generic type node.
 * e.g., List<User, String> → ['User', 'String'], Vec<User> → ['User']
 *
 * Used by extractSimpleTypeName to unwrap nullable wrappers (Optional<User> → User).
 *
 * Handles language-specific AST structures:
 * - TS/Java/Rust/Go: generic_type > type_arguments > type nodes
 * - C#:              generic_type > type_argument_list > type nodes
 * - Kotlin:          generic_type > type_arguments > type_projection > type nodes
 *
 * Note: Go slices/maps use slice_type/map_type, not generic_type — those are
 * NOT handled here. Use language-specific extractors for Go container types.
 *
 * @param typeNode A generic_type or parameterized_type AST node (or any node —
 *   returns [] for non-generic types).
 * @returns Array of resolved type argument names. Unresolvable arguments are omitted.
 */
export const extractGenericTypeArgs = (typeNode: SyntaxNode, depth = 0): string[] => {
  if (depth > 50) return [];
  // Unwrap wrapper nodes that may sit above the generic_type
  if (
    typeNode.type === 'type_annotation' ||
    typeNode.type === 'type' ||
    typeNode.type === 'user_type' ||
    typeNode.type === 'nullable_type' ||
    typeNode.type === 'optional_type'
  ) {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractGenericTypeArgs(inner, depth + 1);
    return [];
  }

  // Only process generic/parameterized type nodes (includes C#'s generic_name)
  if (
    typeNode.type !== 'generic_type' &&
    typeNode.type !== 'parameterized_type' &&
    typeNode.type !== 'generic_name'
  ) {
    return [];
  }

  // Find the type_arguments / type_argument_list child
  let argsNode: SyntaxNode | null = null;
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (child && (child.type === 'type_arguments' || child.type === 'type_argument_list')) {
      argsNode = child;
      break;
    }
  }
  if (!argsNode) return [];

  const result: string[] = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    let argNode = argsNode.namedChild(i);
    if (!argNode) continue;

    // Kotlin: type_arguments > type_projection > user_type > type_identifier
    if (argNode.type === 'type_projection') {
      argNode = argNode.firstNamedChild;
      if (!argNode) continue;
    }

    const name = extractSimpleTypeName(argNode);
    if (name) result.push(name);
  }

  return result;
};

/**
 * Match Ruby constructor assignment: `user = User.new` or `service = Models::User.new`.
 * Returns { varName, calleeName } or undefined if the node is not a Ruby constructor assignment.
 * Handles both simple constants and scope_resolution (namespaced) receivers.
 */
export const extractRubyConstructorAssignment = (
  node: SyntaxNode,
): { varName: string; calleeName: string } | undefined => {
  if (node.type !== 'assignment') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  if (left.type !== 'identifier' && left.type !== 'constant') return undefined;
  if (right.type !== 'call') return undefined;
  const method = right.childForFieldName('method');
  if (!method || method.text !== 'new') return undefined;
  const receiver = right.childForFieldName('receiver');
  if (!receiver) return undefined;
  let calleeName: string;
  if (receiver.type === 'constant') {
    calleeName = receiver.text;
  } else if (receiver.type === 'scope_resolution') {
    // Models::User → extract last segment "User"
    const last = receiver.lastNamedChild;
    if (!last || last.type !== 'constant') return undefined;
    calleeName = last.text;
  } else {
    return undefined;
  }
  return { varName: left.text, calleeName };
};

/**
 * Check if an AST node has an explicit type annotation.
 * Checks both named fields ('type') and child nodes ('type_annotation').
 * Used by constructor binding scanners to skip annotated declarations.
 */
export const hasTypeAnnotation = (node: SyntaxNode): boolean => {
  if (node.childForFieldName('type')) return true;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'type_annotation') return true;
  }
  return false;
};

/** Bare nullable keywords that should not produce a receiver binding. */
export const NULLABLE_KEYWORDS = new Set(['null', 'undefined', 'void', 'None', 'nil']);

/**
 * Strip nullable wrappers from a type name string.
 * Used by both lookupInEnv (TypeEnv annotations) and extractReturnTypeName
 * (return-type text) to normalize types before receiver lookup.
 *
 *   "User | null"           → "User"
 *   "User | undefined"      → "User"
 *   "User | null | undefined" → "User"
 *   "User?"                 → "User"
 *   "User | Repo"           → undefined  (genuine union — refuse)
 *   "null"                  → undefined
 */
export const stripNullable = (typeName: string): string | undefined => {
  let text = typeName.trim();
  if (!text) return undefined;

  if (NULLABLE_KEYWORDS.has(text)) return undefined;

  // Strip nullable suffix: User? → User
  if (text.endsWith('?')) text = text.slice(0, -1).trim();

  // Strip union with null/undefined/None/nil/void
  if (text.includes('|')) {
    const parts = text
      .split('|')
      .map((p) => p.trim())
      .filter((p) => p !== '' && !NULLABLE_KEYWORDS.has(p));
    if (parts.length === 1) return parts[0];
    return undefined; // genuine union or all-nullable — refuse
  }

  return text || undefined;
};
