/**
 * Semantic Model
 *
 * Top-level orchestrator for all resolution-time data. Owns:
 *
 *   - Three owner-scoped registries (types, methods, fields)
 *   - A nested SymbolTable (file + callable name indexes) wrapped so
 *     that `add()` fans out into the registries via the dispatch table
 *
 * ## Dependency direction
 *
 *     ontoindex-shared (NodeLabel)             — leaf
 *          ↑
 *     symbol-table.ts                         — pure file/callable index
 *          ↑
 *     model/type-registry / method-registry / field-registry
 *          ↑
 *     model/registration-table.ts             — dispatch table factory
 *          ↑
 *     model/semantic-model.ts                 — THIS FILE (orchestrator)
 *          ↑
 *     resolve.ts, call-processor.ts, resolution-context.ts, ...
 *
 * `symbol-table.ts` is a leaf — it never imports from `./model/`. This
 * file (semantic-model.ts) is the ONLY place where SymbolTable and the
 * owner-scoped registries are composed. Upstream consumers pass around
 * the `SemanticModel` interface and reach into `.symbols` for file-scoped
 * operations or `.types` / `.methods` / `.fields` for owner-scoped ones.
 *
 * ## Fan-out via wrapped add()
 *
 * `createSemanticModel()` creates a pure SymbolTable, creates the three
 * registries, builds a dispatch table via `createRegistrationTable`, and
 * exposes a SymbolTable-shaped façade whose `add()`:
 *
 *   1. Calls `rawSymbols.add()` — writes the fileIndex + callable index
 *      and returns the fully-built `SymbolDefinition`.
 *   2. Runs pre-dispatch normalization (`Function`-with-`ownerId` routes
 *      as `Method`).
 *   3. Looks up the dispatch table and invokes the hook, which writes to
 *      the appropriate owner-scoped registry.
 *
 * The wrapper is the only place where the two layers are combined. A
 * direct `createSymbolTable()` caller (e.g. an isolated unit test) gets
 * the pure, registry-free behavior — no surprises, no hidden side
 * effects.
 */

import { types as utilTypes } from 'node:util';
import type { NodeLabel } from 'ontoindex-shared';
import type { TypeRegistry, MutableTypeRegistry } from './type-registry.js';
import type { MethodRegistry, MutableMethodRegistry } from './method-registry.js';
import type { FieldRegistry, MutableFieldRegistry } from './field-registry.js';
import { createTypeRegistry } from './type-registry.js';
import { createMethodRegistry } from './method-registry.js';
import { createFieldRegistry } from './field-registry.js';
import type { SymbolDefinition } from 'ontoindex-shared';
import type { SymbolTableReader, SymbolTableWriter, AddMetadata } from './symbol-table.js';
import { createSymbolTable } from './symbol-table.js';
import { ALL_NODE_LABELS, createRegistrationTable } from './registration-table.js';
import type { ScopeResolutionIndexes } from './scope-resolution-indexes.js';

// ---------------------------------------------------------------------------
// Public read-only interface
// ---------------------------------------------------------------------------

/**
 * Aggregated read-only view of the semantic registries plus the nested
 * file/callable SymbolTable.
 *
 * `symbols` is typed as {@link SymbolTableReader} — consumers can query
 * symbols but cannot register new ones or trigger a reset. Callers that
 * need to register symbols or reset state must hold a
 * {@link MutableSemanticModel} reference instead, which widens
 * `symbols` back to {@link SymbolTableWriter} and adds `clear()` on the
 * model itself.
 *
 * This segregation is the runtime half of the principle of least
 * authority: a resolver that receives `SemanticModel` physically cannot
 * mutate the index, so it cannot desync the leaf from the owner-scoped
 * registries even accidentally.
 */
export interface SemanticModel {
  readonly types: TypeRegistry;
  readonly methods: MethodRegistry;
  readonly fields: FieldRegistry;
  readonly symbols: SymbolTableReader;
  /**
   * Materialized scope-resolution indexes from RFC #909 Ring 2 PKG #921.
   *
   * `undefined` until the finalize-orchestrator attaches them. While
   * `undefined`, the legacy DAG is the sole resolution surface; once set,
   * resolvers whose language has `REGISTRY_PRIMARY_<LANG>=true` consult
   * these indexes instead.
   *
   * The attach is a one-shot write (see `MutableSemanticModel`). Callers
   * holding a read-only `SemanticModel` handle see either `undefined` or
   * the final frozen bundle — never a half-populated view.
   */
  readonly scopes?: ScopeResolutionIndexes;
}

// ---------------------------------------------------------------------------
// Mutable interface
// ---------------------------------------------------------------------------

/** Mutable variant — exposes the MutableX registries, a Writer-typed
 *  `symbols` facade, and a full-cascade reset. This is the interface
 *  held by the lifecycle owner (pipeline, resolution-context); resolvers
 *  that only query should hold the narrower {@link SemanticModel}. */
export interface MutableSemanticModel extends SemanticModel {
  readonly types: MutableTypeRegistry;
  readonly methods: MutableMethodRegistry;
  readonly fields: MutableFieldRegistry;
  readonly symbols: SymbolTableWriter;
  /** Clear all registries AND the nested SymbolTable. */
  clear(): void;
  /** Registration-time inputs only; later mutations of live definitions are not captured. */
  snapshotRegistrations(): SemanticModelRegistrationSnapshot | undefined;
  /**
   * Stamp the finalize-orchestrator's output onto this model.
   *
   * **One-shot write.** Throws when called a second time — the indexes are
   * meant to be materialized once per ingestion run. `Object.freeze` is
   * applied to the attached bundle so consumers cannot mutate after attach.
   *
   * `clear()` resets the attached bundle back to `undefined`, enabling a
   * fresh re-ingestion to attach a new bundle.
   */
  attachScopeIndexes(indexes: ScopeResolutionIndexes): void;
}

export type SemanticModelRegistrationEvent =
  | {
      kind: 'symbol.add';
      filePath: string;
      name: string;
      nodeId: string;
      type: NodeLabel;
      metadata?: AddMetadata;
    }
  | { kind: 'type.registerClass'; name: string; qualifiedName: string; def: SymbolDefinition }
  | { kind: 'type.registerImpl'; name: string; def: SymbolDefinition }
  | {
      kind: 'method.register' | 'field.register';
      ownerNodeId: string;
      name: string;
      def: SymbolDefinition;
    }
  | { kind: 'type.clear' | 'method.clear' | 'field.clear' };

export interface SemanticModelRegistrationSnapshot {
  version: 1;
  events: SemanticModelRegistrationEvent[];
}

const MAX_REGISTRATION_EVENTS = 100_000;
const MAX_REGISTRATION_EVENT_BYTES = 256 * 1024;
const MAX_REGISTRATION_BYTES = 64 * 1024 * 1024;
const EMPTY_REGISTRATION_BYTES = 25; // {"version":1,"events":[]}
const LABELS = new Set<string>(ALL_NODE_LABELS);
const METADATA_FIELDS = {
  parameterCount: 'count',
  requiredParameterCount: 'count',
  parameterTypes: 'strings',
  returnType: 'string',
  declaredType: 'string',
  ownerId: 'string',
  qualifiedName: 'string',
} as const;
type RegistrationShape = Record<
  string,
  'string' | 'label' | 'count' | 'strings' | 'metadata' | 'def'
>;

const invalidRegistration = (): never => {
  throw Object.assign(new Error('Invalid or oversized semantic model registration snapshot'), {
    code: 'INVALID_SEMANTIC_MODEL_REGISTRATIONS' as const,
  });
};

/** Validate descriptors before reading values; no getters or user serialization hooks run. */
const registrationRecord = (input: unknown): Record<string, PropertyDescriptor> => {
  if (
    input === null ||
    typeof input !== 'object' ||
    utilTypes.isProxy(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    return invalidRegistration();
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length > 10) return invalidRegistration();
  const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') return invalidRegistration();
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!('value' in descriptor)) return invalidRegistration();
    descriptors[key] = descriptor;
  }
  return descriptors;
};

// Count JSON string bytes without encoding or copying a potentially oversized value.
const registrationStringBytes = (value: string): number => {
  if (value.length > MAX_REGISTRATION_EVENT_BYTES) return invalidRegistration();
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 2;
    else if (c < 32) bytes += 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else if (c >= 0xd800 && c <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > MAX_REGISTRATION_EVENT_BYTES) invalidRegistration();
  }
  return bytes;
};

const cloneRegistrationEvent = (
  input: unknown,
): { event: SemanticModelRegistrationEvent; bytes: number } => {
  let bytes = 0;
  const charge = (amount: number): void => {
    bytes += amount;
    if (bytes > MAX_REGISTRATION_EVENT_BYTES) invalidRegistration();
  };
  const string = (value: unknown): string => {
    if (typeof value !== 'string') return invalidRegistration();
    charge(registrationStringBytes(value));
    return value;
  };
  const record = (
    value: unknown,
    shape: RegistrationShape,
    required: readonly string[],
  ): Record<string, unknown> => {
    const descriptors = registrationRecord(value);
    for (const key of required) if (!Object.hasOwn(descriptors, key)) invalidRegistration();
    const result: Record<string, unknown> = {};
    charge(2);
    let count = 0;
    for (const key of Object.keys(descriptors)) {
      if (!Object.hasOwn(shape, key)) invalidRegistration();
      const item = descriptors[key].value;
      if (item === undefined && !required.includes(key)) continue;
      charge((count++ ? 1 : 0) + registrationStringBytes(key) + 1);
      switch (shape[key]) {
        case 'string':
          result[key] = string(item);
          break;
        case 'label': {
          const label = string(item);
          if (!LABELS.has(label)) invalidRegistration();
          result[key] = label;
          break;
        }
        case 'count':
          if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)
            invalidRegistration();
          charge(String(item).length);
          result[key] = item;
          break;
        case 'strings': {
          if (
            !Array.isArray(item) ||
            utilTypes.isProxy(item) ||
            Object.getPrototypeOf(item) !== Array.prototype ||
            item.length > MAX_REGISTRATION_EVENT_BYTES / 3
          )
            invalidRegistration();
          if (Reflect.ownKeys(item).length !== item.length + 1) invalidRegistration();
          charge(2);
          const values: string[] = [];
          for (let i = 0; i < item.length; i++) {
            const part = Object.getOwnPropertyDescriptor(item, String(i));
            if (!part || !('value' in part)) invalidRegistration();
            if (i) charge(1);
            values.push(string(part.value));
          }
          result[key] = values;
          break;
        }
        case 'metadata':
          result[key] = record(item, METADATA_FIELDS, []);
          break;
        case 'def':
          result[key] = record(
            item,
            { ...METADATA_FIELDS, nodeId: 'string', filePath: 'string', type: 'label' },
            ['nodeId', 'filePath', 'type'],
          );
          break;
      }
    }
    return result;
  };
  const descriptors = registrationRecord(input);
  const kind = descriptors.kind?.value;
  let shape: RegistrationShape;
  let required: string[];
  switch (kind) {
    case 'symbol.add':
      shape = {
        kind: 'string',
        filePath: 'string',
        name: 'string',
        nodeId: 'string',
        type: 'label',
        metadata: 'metadata',
      };
      required = ['kind', 'filePath', 'name', 'nodeId', 'type'];
      break;
    case 'type.registerClass':
      shape = { kind: 'string', name: 'string', qualifiedName: 'string', def: 'def' };
      required = Object.keys(shape);
      break;
    case 'type.registerImpl':
      shape = { kind: 'string', name: 'string', def: 'def' };
      required = Object.keys(shape);
      break;
    case 'method.register':
    case 'field.register':
      shape = { kind: 'string', ownerNodeId: 'string', name: 'string', def: 'def' };
      required = Object.keys(shape);
      break;
    case 'type.clear':
    case 'method.clear':
    case 'field.clear':
      shape = { kind: 'string' };
      required = ['kind'];
      break;
    default:
      return invalidRegistration();
  }
  return { event: record(input, shape, required) as SemanticModelRegistrationEvent, bytes };
};

/** Replay validated registration inputs into a fresh model with capture disabled. */
export const restoreSemanticModelRegistrations = (input: unknown): MutableSemanticModel => {
  const descriptors = registrationRecord(input);
  if (
    Reflect.ownKeys(descriptors).length !== 2 ||
    descriptors.version?.value !== 1 ||
    !Object.hasOwn(descriptors, 'events')
  )
    return invalidRegistration();
  const events: unknown = descriptors.events.value;
  if (
    !Array.isArray(events) ||
    utilTypes.isProxy(events) ||
    Object.getPrototypeOf(events) !== Array.prototype ||
    events.length > MAX_REGISTRATION_EVENTS
  )
    return invalidRegistration();
  if (Reflect.ownKeys(events).length !== events.length + 1) return invalidRegistration();
  const model = createSemanticModel();
  let bytes = EMPTY_REGISTRATION_BYTES;
  for (let i = 0; i < events.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(events, String(i));
    if (!entry || !('value' in entry)) return invalidRegistration();
    const staged = cloneRegistrationEvent(entry.value);
    bytes += staged.bytes + (i ? 1 : 0);
    if (bytes > MAX_REGISTRATION_BYTES) return invalidRegistration();
    const event = staged.event;
    switch (event.kind) {
      case 'symbol.add':
        model.symbols.add(event.filePath, event.name, event.nodeId, event.type, event.metadata);
        break;
      case 'type.registerClass':
        model.types.registerClass(event.name, event.qualifiedName, event.def);
        break;
      case 'type.registerImpl':
        model.types.registerImpl(event.name, event.def);
        break;
      case 'method.register':
        model.methods.register(event.ownerNodeId, event.name, event.def);
        break;
      case 'field.register':
        model.fields.register(event.ownerNodeId, event.name, event.def);
        break;
      case 'type.clear':
        model.types.clear();
        break;
      case 'method.clear':
        model.methods.clear();
        break;
      case 'field.clear':
        model.fields.clear();
        break;
    }
  }
  return model;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
//
// NodeLabel taxonomy drift detection lives in `registration-table.ts` as a
// pure compile-time check — the `LABEL_BEHAVIOR` map is
// `Record<NodeLabel, LabelBehavior>` with `as const satisfies`, which proves
// coverage, uniqueness, and no-extra-keys at build time. No runtime guard
// is needed because drift is structurally impossible in the source.

export const createSemanticModel = (options?: {
  captureRegistrations?: boolean;
}): MutableSemanticModel => {
  // 1. Create the pure, registry-unaware SymbolTable leaf.
  // rawSymbols is the only handle in the codebase whose type (the
  // internal createSymbolTable return) includes `.clear()`. cascadeClear
  // below reaches it here; no external caller receives this variable.
  const rawSymbols = createSymbolTable();

  // 2. Create the three owner-scoped registries.
  const types = createTypeRegistry();
  const methods = createMethodRegistry();
  const fields = createFieldRegistry();

  const registrations: SemanticModelRegistrationEvent[] | undefined = options?.captureRegistrations
    ? []
    : undefined;
  let registrationBytes = EMPTY_REGISTRATION_BYTES;
  let suppressCapture = false;
  const capture = <T>(input: SemanticModelRegistrationEvent, mutate: () => T): T => {
    if (!registrations || suppressCapture) return mutate();
    if (registrations.length >= MAX_REGISTRATION_EVENTS) return invalidRegistration();
    const staged = cloneRegistrationEvent(input);
    const nextBytes = registrationBytes + staged.bytes + (registrations.length ? 1 : 0);
    if (nextBytes > MAX_REGISTRATION_BYTES) return invalidRegistration();
    suppressCapture = true;
    try {
      const result = mutate();
      registrations.push(staged.event);
      registrationBytes = nextBytes;
      return result;
    } finally {
      suppressCapture = false;
    }
  };
  if (registrations) {
    const registerClass = types.registerClass;
    types.registerClass = (name, qualifiedName, def) =>
      capture({ kind: 'type.registerClass', name, qualifiedName, def }, () =>
        registerClass(name, qualifiedName, def),
      );
    const registerImpl = types.registerImpl;
    types.registerImpl = (name, def) =>
      capture({ kind: 'type.registerImpl', name, def }, () => registerImpl(name, def));
    const registerMethod = methods.register;
    methods.register = (ownerNodeId, name, def) =>
      capture({ kind: 'method.register', ownerNodeId, name, def }, () =>
        registerMethod(ownerNodeId, name, def),
      );
    const registerField = fields.register;
    fields.register = (ownerNodeId, name, def) =>
      capture({ kind: 'field.register', ownerNodeId, name, def }, () =>
        registerField(ownerNodeId, name, def),
      );
    const clearTypes = types.clear;
    types.clear = () => capture({ kind: 'type.clear' }, clearTypes);
    const clearMethods = methods.clear;
    methods.clear = () => capture({ kind: 'method.clear' }, clearMethods);
    const clearFields = fields.clear;
    fields.clear = () => capture({ kind: 'field.clear' }, clearFields);
  }

  // 3. Build the dispatch table, closed over THIS instance's registries.
  const dispatchTable = createRegistrationTable({ types, methods, fields });

  // 4. Wrap rawSymbols so `add()` fans out into the registries via the
  //    dispatch table. See module JSDoc for the three-step contract.
  const wrappedAdd = (
    filePath: string,
    name: string,
    nodeId: string,
    type: NodeLabel,
    metadata?: AddMetadata,
  ): SymbolDefinition => {
    const def = rawSymbols.add(filePath, name, nodeId, type, metadata);

    // Function-with-ownerId (Python `def` in a class body, Rust trait
    // method, Kotlin companion method) routes as Method. Keeps the
    // dispatch table single-purpose.
    const dispatchKey: NodeLabel =
      type === 'Function' && metadata?.ownerId !== undefined ? 'Method' : type;

    const hook = dispatchTable.get(dispatchKey);
    if (hook) {
      hook(name, def);
    }

    return def;
  };

  // Scope-resolution bundle slot. Starts `undefined`; populated by a
  // one-shot `attachScopeIndexes(...)` from the finalize-orchestrator.
  // Held inside the factory closure so the returned `SemanticModel`
  // surface exposes it as a plain `readonly` property without a setter.
  let attachedScopes: ScopeResolutionIndexes | undefined;

  const attachScopeIndexes = (indexes: ScopeResolutionIndexes): void => {
    if (attachedScopes !== undefined) {
      throw new Error(
        'SemanticModel: scope indexes already attached. ' + 'Call `clear()` before re-attaching.',
      );
    }
    attachedScopes = Object.freeze(indexes);
  };

  // Cascade clear: single source of truth for "reset the entire model".
  // Wired into both `model.clear()` AND `model.symbols.clear()` so that a
  // caller holding only a SymbolTable reference can't leave the
  // owner-scoped registries populated while the file/callable indexes go
  // empty (the phantom-resolution failure mode).
  const cascadeClear = (): void => {
    suppressCapture = true;
    try {
      types.clear();
      methods.clear();
      fields.clear();
      rawSymbols.clear();
      attachedScopes = undefined;
      if (registrations) registrations.length = 0;
      registrationBytes = EMPTY_REGISTRATION_BYTES;
    } finally {
      suppressCapture = false;
    }
  };

  // Writer-typed facade: exposes reads + add, but NO `clear` field.
  // Callers holding a `SemanticModel.symbols` reference cannot desync
  // the leaf indexes from the owner-scoped registries. Consumers that
  // only query should widen their annotation to SymbolTableReader for
  // least-authority clarity.
  const symbols: SymbolTableWriter = {
    add: registrations
      ? (filePath, name, nodeId, type, metadata) =>
          capture({ kind: 'symbol.add', filePath, name, nodeId, type, metadata }, () =>
            wrappedAdd(filePath, name, nodeId, type, metadata),
          )
      : wrappedAdd,
    lookupExact: rawSymbols.lookupExact,
    lookupExactFull: rawSymbols.lookupExactFull,
    lookupExactAll: rawSymbols.lookupExactAll,
    lookupCallableByName: rawSymbols.lookupCallableByName,
    getFiles: rawSymbols.getFiles,
    getStats: rawSymbols.getStats,
  };

  return {
    types,
    methods,
    fields,
    symbols,
    get scopes() {
      return attachedScopes;
    },
    clear: cascadeClear,
    snapshotRegistrations: () =>
      registrations
        ? {
            version: 1,
            events: registrations.map((event) => cloneRegistrationEvent(event).event),
          }
        : undefined,
    attachScopeIndexes,
  };
};
