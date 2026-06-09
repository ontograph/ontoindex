// ── TypeArgPosition ──────────────────────────────────────────────────────────

/** Which type argument to extract from a multi-arg generic container.
 *  - 'first': key type (e.g., K from Map<K,V>) — used for .keys(), .keySet()
 *  - 'last':  value type (e.g., V from Map<K,V>) — used for .values(), .items(), .iter() */
export type TypeArgPosition = 'first' | 'last';

// ── extractElementTypeFromString ─────────────────────────────────────────────

// Internal helper: extract the first comma-separated argument from a string,
// respecting nested angle-bracket and square-bracket depth.
function extractFirstArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '<' || ch === '[') depth++;
    else if (ch === '>' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/**
 * Extract element type from a container type string.
 * Uses bracket-balanced parsing (no regex) for generic argument extraction.
 * Returns undefined for ambiguous or unparseable strings.
 *
 * Handles:
 * - Array<User>    → User  (generic angle brackets)
 * - User[]         → User  (array suffix)
 * - []User         → User  (Go slice prefix)
 * - List[User]     → User  (Python subscript)
 * - [User]         → User  (Swift array sugar)
 * - vector<User>   → User  (C++ container)
 * - Vec<User>      → User  (Rust container)
 *
 * For multi-argument generics (Map<K, V>), returns the first or last type arg
 * based on `pos` ('first' for keys, 'last' for values — default 'last').
 * Returns undefined when the extracted type is not a simple word.
 */
export function extractElementTypeFromString(
  typeStr: string,
  pos: TypeArgPosition = 'last',
): string | undefined {
  if (!typeStr || typeStr.length === 0 || typeStr.length > 2048) return undefined;

  // 1. Array suffix: User[] → User
  if (typeStr.endsWith('[]')) {
    const base = typeStr.slice(0, -2).trim();
    return base && /^\w+$/.test(base) ? base : undefined;
  }

  // 2. Go slice prefix: []User → User
  if (typeStr.startsWith('[]')) {
    const element = typeStr.slice(2).trim();
    return element && /^\w+$/.test(element) ? element : undefined;
  }

  // 3. Swift array sugar: [User] → User
  //    Must start with '[', end with ']', and contain no angle brackets
  //    (to avoid confusing with List[User] handled below).
  if (typeStr.startsWith('[') && typeStr.endsWith(']') && !typeStr.includes('<')) {
    const element = typeStr.slice(1, -1).trim();
    return element && /^\w+$/.test(element) ? element : undefined;
  }

  // 4. Generic bracket-balanced extraction: Array<User> / List[User] / Vec<User>
  //    Find the first opening bracket (< or [) and pick the one that appears first.
  const openAngle = typeStr.indexOf('<');
  const openSquare = typeStr.indexOf('[');

  let openIdx = -1;
  let openChar = '';
  let closeChar = '';

  if (openAngle >= 0 && (openSquare < 0 || openAngle < openSquare)) {
    openIdx = openAngle;
    openChar = '<';
    closeChar = '>';
  } else if (openSquare >= 0) {
    openIdx = openSquare;
    openChar = '[';
    closeChar = ']';
  }

  if (openIdx < 0) return undefined;

  // Walk bracket-balanced from the character after the opening bracket to find
  // the matching close bracket, tracking depth for nested brackets.
  // All bracket types (<, >, [, ]) contribute to depth uniformly, but only the
  // selected closeChar can match at depth 0 (prevents cross-bracket miscounting).
  let depth = 0;
  const start = openIdx + 1;
  let lastCommaIdx = -1; // Track last top-level comma for 'last' position
  for (let i = start; i < typeStr.length; i++) {
    const ch = typeStr[i];
    if (ch === '<' || ch === '[') {
      depth++;
    } else if (ch === '>' || ch === ']') {
      if (depth === 0) {
        // At depth 0 — only match if it is our selected close bracket.
        if (ch !== closeChar) return undefined; // mismatched bracket = malformed
        if (pos === 'last' && lastCommaIdx >= 0) {
          // Return last arg (text after last comma)
          const lastArg = typeStr.slice(lastCommaIdx + 1, i).trim();
          return lastArg && /^\w+$/.test(lastArg) ? lastArg : undefined;
        }
        const inner = typeStr.slice(start, i).trim();
        const firstArg = extractFirstArg(inner);
        return firstArg && /^\w+$/.test(firstArg) ? firstArg : undefined;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      if (pos === 'first') {
        // Return first arg (text before first comma)
        const arg = typeStr.slice(start, i).trim();
        return arg && /^\w+$/.test(arg) ? arg : undefined;
      }
      lastCommaIdx = i;
    }
  }

  // Suppress unused variable warning — openChar is used implicitly via the logic above
  void openChar;

  return undefined;
}

// ── extractReturnTypeName ─────────────────────────────────────────────────────
// Works on raw return-type text already stored in SymbolDefinition
// (e.g. "User", "Promise<User>", "User | null", "*User").
// Extracts the base user-defined type name.

/** Primitive / built-in types that should NOT produce a receiver binding. */
const PRIMITIVE_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'void',
  'int',
  'float',
  'double',
  'long',
  'short',
  'byte',
  'char',
  'bool',
  'str',
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
  'f32',
  'f64',
  'usize',
  'isize',
  'undefined',
  'null',
  'None',
  'nil',
]);

/**
 * Extract a simple type name from raw return-type text.
 * Handles common patterns:
 *   "User"                → "User"
 *   "Promise<User>"       → "User"   (unwrap wrapper generics)
 *   "Option<User>"        → "User"
 *   "Result<User, Error>" → "User"   (first type arg)
 *   "User | null"         → "User"   (strip nullable union)
 *   "User?"               → "User"   (strip nullable suffix)
 *   "*User"               → "User"   (Go pointer)
 *   "&User"               → "User"   (Rust reference)
 * Returns undefined for complex types or primitives.
 */
const WRAPPER_GENERICS = new Set([
  'Promise',
  'Observable',
  'Future',
  'CompletableFuture',
  'Task',
  'ValueTask', // async wrappers
  'Option',
  'Some',
  'Optional',
  'Maybe', // nullable wrappers
  'Result',
  'Either', // result wrappers
  // Rust smart pointers (Deref to inner type)
  'Rc',
  'Arc',
  'Weak', // pointer types
  'MutexGuard',
  'RwLockReadGuard',
  'RwLockWriteGuard', // guard types
  'Ref',
  'RefMut', // RefCell guards
  'Cow', // copy-on-write
  // Containers (List, Array, Vec, Set, etc.) are intentionally excluded —
  // methods are called on the container, not the element type.
  // Non-wrapper generics return the base type (e.g., List) via the else branch.
]);

/**
 * Extracts the first type argument from a comma-separated generic argument string,
 * respecting nested angle brackets. For example:
 *   "Result<User, Error>"  → "Result<User, Error>"  (no top-level comma)
 *   "User, Error"          → "User"
 *   "Map<K, V>, string"    → "Map<K, V>"
 */
function extractFirstGenericArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '<') depth++;
    else if (args[i] === '>') depth--;
    else if (args[i] === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/**
 * Extract the first non-lifetime type argument from a generic argument string.
 * Skips Rust lifetime parameters (e.g., `'a`, `'_`) to find the actual type.
 *   "'_, User"       → "User"
 *   "'a, User"       → "User"
 *   "User, Error"    → "User"  (no lifetime — delegates to extractFirstGenericArg)
 */
function extractFirstTypeArg(args: string): string {
  let remaining = args;
  while (remaining) {
    const first = extractFirstGenericArg(remaining);
    if (!first.startsWith("'")) return first;
    // Skip past this lifetime arg + the comma separator
    const commaIdx = remaining.indexOf(',', first.length);
    if (commaIdx < 0) return first; // only lifetimes — fall through
    remaining = remaining.slice(commaIdx + 1).trim();
  }
  return args.trim();
}

const MAX_RETURN_TYPE_INPUT_LENGTH = 2048;
const MAX_RETURN_TYPE_LENGTH = 512;

export const extractReturnTypeName = (raw: string, depth = 0): string | undefined => {
  if (depth > 10) return undefined;
  if (raw.length > MAX_RETURN_TYPE_INPUT_LENGTH) return undefined;
  let text = raw.trim();
  if (!text) return undefined;

  // Strip pointer/reference prefixes: *User, &User, &mut User
  text = text.replace(/^[&*]+\s*(mut\s+)?/, '');

  // Strip nullable suffix: User?
  text = text.replace(/\?$/, '');

  // Handle union types: "User | null" → "User"
  if (text.includes('|')) {
    const parts = text
      .split('|')
      .map((p) => p.trim())
      .filter(
        (p) => p !== 'null' && p !== 'undefined' && p !== 'void' && p !== 'None' && p !== 'nil',
      );
    if (parts.length === 1) text = parts[0];
    else return undefined; // genuine union — too complex
  }

  // Handle generics: Promise<User> → unwrap if wrapper, else take base
  const genericMatch = text.match(/^(\w+)\s*<(.+)>$/);
  if (genericMatch) {
    const [, base, args] = genericMatch;
    if (WRAPPER_GENERICS.has(base)) {
      // Take the first non-lifetime type argument, using bracket-balanced splitting
      // so that nested generics like Result<User, Error> are not split at the inner
      // comma. Lifetime parameters (Rust 'a, '_) are skipped.
      const firstArg = extractFirstTypeArg(args);
      return extractReturnTypeName(firstArg, depth + 1);
    }
    // Non-wrapper generic: return the base type (e.g., Map<K,V> → Map)
    return PRIMITIVE_TYPES.has(base.toLowerCase()) ? undefined : base;
  }

  // Bare wrapper type without generic argument (e.g. Task, Promise, Option)
  // should not produce a binding — these are meaningless without a type parameter
  if (WRAPPER_GENERICS.has(text)) return undefined;

  // Handle qualified names: models.User → User, Models::User → User, \App\Models\User → User
  if (text.includes('::') || text.includes('.') || text.includes('\\')) {
    text = text.split(/::|[.\\]/).pop()!;
  }

  // Final check: skip primitives
  if (PRIMITIVE_TYPES.has(text) || PRIMITIVE_TYPES.has(text.toLowerCase())) return undefined;

  // Must start with uppercase (class/type convention) or be a valid identifier
  if (!/^[A-Z_]\w*$/.test(text)) return undefined;

  // If the final extracted type name is too long, reject it
  if (text.length > MAX_RETURN_TYPE_LENGTH) return undefined;

  return text;
};
