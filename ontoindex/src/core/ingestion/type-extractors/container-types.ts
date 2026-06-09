import type { SyntaxNode } from '../utils/ast-helpers.js';
import { extractElementTypeFromString } from './return-type-extractor.js';
import type { TypeArgPosition } from './return-type-extractor.js';

export type { TypeArgPosition };

// ---------------------------------------------------------------------------
// Container type descriptors — maps container base names to type parameter
// semantics per access method. Replaces the simple KEY_METHODS heuristic.
//
// For user-defined generics (MyCache<K,V> extends Map<K,V>), heritage-aware
// fallback can walk the EXTENDS chain to find a matching descriptor.
// ---------------------------------------------------------------------------

/** Describes which type parameter position each access method yields. */
interface ContainerDescriptor {
  /** Number of type parameters (1 = single-element, 2 = key-value) */
  arity: number;
  /** Methods that yield the first type parameter (key type for maps) */
  keyMethods: ReadonlySet<string>;
  /** Methods that yield the last type parameter (value type) */
  valueMethods: ReadonlySet<string>;
}

/** Empty set for containers that have no key-yielding methods */
const NO_KEYS: ReadonlySet<string> = new Set();

/** Standard key-yielding methods across languages */
const STD_KEY_METHODS: ReadonlySet<string> = new Set(['keys']);
const JAVA_KEY_METHODS: ReadonlySet<string> = new Set(['keySet']);
const CSHARP_KEY_METHODS: ReadonlySet<string> = new Set(['Keys']);

/** Standard value-yielding methods across languages */
const STD_VALUE_METHODS: ReadonlySet<string> = new Set(['values', 'get', 'pop', 'remove']);
const CSHARP_VALUE_METHODS: ReadonlySet<string> = new Set(['Values', 'TryGetValue']);
const SINGLE_ELEMENT_METHODS: ReadonlySet<string> = new Set([
  'iter',
  'into_iter',
  'iterator',
  'get',
  'first',
  'last',
  'pop',
  'peek',
  'poll',
  'find',
  'filter',
  'map',
]);

const CONTAINER_DESCRIPTORS: ReadonlyMap<string, ContainerDescriptor> = new Map([
  // --- Map / Dict types (arity 2: key + value) ---
  ['Map', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['WeakMap', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['HashMap', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['BTreeMap', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['LinkedHashMap', { arity: 2, keyMethods: JAVA_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['TreeMap', { arity: 2, keyMethods: JAVA_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['dict', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['Dict', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['Dictionary', { arity: 2, keyMethods: CSHARP_KEY_METHODS, valueMethods: CSHARP_VALUE_METHODS }],
  [
    'SortedDictionary',
    { arity: 2, keyMethods: CSHARP_KEY_METHODS, valueMethods: CSHARP_VALUE_METHODS },
  ],
  ['Record', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['OrderedDict', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  [
    'ConcurrentHashMap',
    { arity: 2, keyMethods: JAVA_KEY_METHODS, valueMethods: STD_VALUE_METHODS },
  ],
  [
    'ConcurrentDictionary',
    { arity: 2, keyMethods: CSHARP_KEY_METHODS, valueMethods: CSHARP_VALUE_METHODS },
  ],

  // --- Single-element containers (arity 1) ---
  ['Array', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['List', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['ArrayList', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['LinkedList', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Vec', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['VecDeque', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Set', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['HashSet', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['BTreeSet', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['TreeSet', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Queue', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Deque', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Stack', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Sequence', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Iterable', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Iterator', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['IEnumerable', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['IList', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['ICollection', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Collection', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['ObservableCollection', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['IEnumerator', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['SortedSet', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Stream', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['MutableList', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['MutableSet', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['LinkedHashSet', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['ArrayDeque', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['PriorityQueue', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['MutableMap', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['list', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['set', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['tuple', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['frozenset', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
]);

/** Determine which type arg to extract based on container type name and access method.
 *
 *  Resolution order:
 *  1. If container is known and method is in keyMethods → 'first'
 *  2. If container is known with arity 1 → 'last' (same as 'first' for single-arg)
 *  3. If container is unknown → fall back to method name heuristic
 *  4. Default: 'last' (value type)
 */
export function methodToTypeArgPosition(
  methodName: string | undefined,
  containerTypeName?: string,
): TypeArgPosition {
  if (containerTypeName) {
    const desc = CONTAINER_DESCRIPTORS.get(containerTypeName);
    if (desc) {
      // Single-element container: always 'last' (= only arg)
      if (desc.arity === 1) return 'last';
      // Multi-element: check if method yields key type
      if (methodName && desc.keyMethods.has(methodName)) return 'first';
      // Default for multi-element: value type
      return 'last';
    }
  }
  // Fallback for unknown containers: simple method name heuristic
  if (methodName && (methodName === 'keys' || methodName === 'keySet' || methodName === 'Keys')) {
    return 'first';
  }
  return 'last';
}

/** Look up the container descriptor for a type name. Exported for heritage-chain lookups. */
export function getContainerDescriptor(typeName: string): ContainerDescriptor | undefined {
  return CONTAINER_DESCRIPTORS.get(typeName);
}

/**
 * Shared 3-strategy fallback for resolving the element type of a container variable.
 * Used by all for-loop extractors to resolve the loop variable's type from the iterable.
 *
 * Strategy 1: declarationTypeNodes — raw AST type annotation node (handles container types
 *             where extractSimpleTypeName returned undefined, e.g., User[], List[User])
 * Strategy 2: scopeEnv string — extractElementTypeFromString on the stored type string
 * Strategy 3: AST walk — language-specific upward walk to enclosing function parameters
 *
 * @param extractFromTypeNode Language-specific function to extract element type from AST node
 * @param findParamElementType Optional language-specific AST walk to find parameter type
 * @param typeArgPos Which generic type arg to extract: 'first' for keys, 'last' for values (default)
 */
export function resolveIterableElementType(
  iterableName: string,
  node: SyntaxNode,
  scopeEnv: ReadonlyMap<string, string>,
  declarationTypeNodes: ReadonlyMap<string, SyntaxNode>,
  scope: string,
  extractFromTypeNode: (typeNode: SyntaxNode, pos?: TypeArgPosition) => string | undefined,
  findParamElementType?: (
    name: string,
    startNode: SyntaxNode,
    pos?: TypeArgPosition,
  ) => string | undefined,
  typeArgPos: TypeArgPosition = 'last',
): string | undefined {
  // Strategy 1: declarationTypeNodes AST node (check current scope, then file scope)
  const typeNode =
    declarationTypeNodes.get(`${scope}\0${iterableName}`) ??
    (scope !== '' ? declarationTypeNodes.get(`\0${iterableName}`) : undefined);
  if (typeNode) {
    const t = extractFromTypeNode(typeNode, typeArgPos);
    if (t) return t;
  }
  // Strategy 2: scopeEnv string → extractElementTypeFromString
  const iterableType = scopeEnv.get(iterableName);
  if (iterableType) {
    const el = extractElementTypeFromString(iterableType, typeArgPos);
    if (el) return el;
  }
  // Strategy 3: AST walk to function parameters
  if (findParamElementType) return findParamElementType(iterableName, node, typeArgPos);
  return undefined;
}
