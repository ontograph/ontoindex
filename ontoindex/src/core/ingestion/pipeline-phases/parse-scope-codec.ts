import type { ParsedFile, RelationshipType } from 'ontoindex-shared';
import { types } from 'node:util';

// Parsed files repeat scope/definition metadata; keep their bound separate from graph records.
export const MAX_PARSED_FILE_RECORD_BYTES = 1024 * 1024;
export const MAX_GRAPH_RECORD_BYTES = 256 * 1024;

export class ParsedFileRecordError extends Error {
  constructor(readonly reason: string) {
    super(`Scope retention: ${reason}`);
  }
}

type Shape = string | { [key: string]: Shape };
const range = { startLine: 'number', startCol: 'number', endLine: 'number', endCol: 'number' };
const definition = {
  nodeId: 'string',
  filePath: 'string',
  type: 'node-label',
  'qualifiedName?': 'string',
  'parameterCount?': 'number',
  'requiredParameterCount?': 'number',
  'parameterTypes?': 'strings',
  'returnType?': 'string',
  'declaredType?': 'string',
  'ownerId?': 'string',
};
const edge = {
  localName: 'string',
  targetFile: 'nullable-string',
  targetExportedName: 'string',
  'targetModuleScope?': 'string',
  'targetDefId?': 'string',
  kind: 'edge-kind',
  'transitiveVia?': 'strings',
  'linkStatus?': 'unresolved',
  'namespace?': 'binding-namespace',
};
const schemas: Record<string, Shape> = {
  file: {
    filePath: 'string',
    moduleScope: 'string',
    scopes: 'scopes',
    parsedImports: 'imports',
    localDefs: 'definitions',
    'declarationSources?': 'declaration-sources',
    'definitionNodeIds?': 'definition-node-ids',
    'exports?': 'export-map',
    'exportsByNamespace?': { type: 'export-map', value: 'export-map' },
    referenceSites: 'references',
  },
  scope: {
    id: 'string',
    parent: 'nullable-string',
    kind: 'scope-kind',
    range,
    filePath: 'string',
    bindings: 'binding-map',
    'ownerDefId?': 'nullable-string',
    ownedDefs: 'definitions',
    imports: 'edges',
    typeBindings: 'type-map',
  },
  definition,
  'declaration-source': { defId: 'string', range, name: 'string', type: 'node-label' },
  'definition-node-id': { defId: 'string', nodeId: 'string' },
  edge,
  binding: { def: definition, origin: 'origin', 'via?': edge, 'namespace?': 'binding-namespace' },
  type: {
    rawName: 'string',
    declaredAtScope: 'string',
    source: 'type-source',
    'typeArgs?': 'types',
  },
  reference: {
    name: 'string',
    atRange: range,
    inScope: 'string',
    kind: 'reference-kind',
    'callForm?': 'call-form',
    'explicitReceiver?': 'explicit-receiver',
    'arity?': 'number',
  },
  'computed-reference': {
    kind: 'computed-read-kind',
    selection: 'computed-selection',
    atRange: 'computed-range',
    inScope: 'string',
  },
  'computed-selection': {
    kind: 'computed-selection-kind',
    objectRange: 'computed-range',
    indexRange: 'computed-range',
  },
  'computed-range': {
    startLine: 'computed-line',
    startCol: 'computed-column',
    endLine: 'computed-line',
    endCol: 'computed-column',
  },
  evidence: { kind: 'string', weight: 'number', 'note?': 'string' },
};
const arrays: Record<string, Shape> = {
  strings: 'string',
  scopes: 'scope',
  imports: 'import',
  definitions: 'definition',
  'declaration-sources': 'declaration-source',
  'definition-node-ids': 'definition-node-id',
  references: 'reference',
  edges: 'edge',
  types: 'type',
  bindings: 'binding',
  evidences: 'evidence',
  'receiver-steps': 'receiver-step',
};
const enums: Record<string, readonly string[]> = {
  'relationship-type': [
    'CONTAINS',
    'CALLS',
    'INHERITS',
    'METHOD_OVERRIDES',
    'METHOD_IMPLEMENTS',
    'IMPORTS',
    'USES',
    'DEFINES',
    'DECORATES',
    'IMPLEMENTS',
    'EXTENDS',
    'HAS_METHOD',
    'HAS_PROPERTY',
    'ACCESSES',
    'MEMBER_OF',
    'STEP_IN_PROCESS',
    'HANDLES_ROUTE',
    'FETCHES',
    'HANDLES_TOOL',
    'ENTRY_POINT_OF',
    'WRAPS',
    'QUERIES',
    'EXPLAINED_BY',
    'SUMMARIZES',
    'MENTIONS',
    'CO_CHANGED_WITH',
  ] satisfies readonly RelationshipType[],
  'node-label': [
    'Project',
    'Package',
    'Module',
    'Folder',
    'File',
    'Class',
    'Function',
    'Method',
    'Variable',
    'Interface',
    'Enum',
    'Decorator',
    'Import',
    'Type',
    'CodeElement',
    'Community',
    'Concept',
    'Process',
    'SummaryNode',
    'Struct',
    'Macro',
    'Typedef',
    'Union',
    'Namespace',
    'Trait',
    'Impl',
    'TypeAlias',
    'Const',
    'Static',
    'Property',
    'Record',
    'Delegate',
    'Annotation',
    'Constructor',
    'Template',
    'Section',
    'Route',
    'Tool',
  ],
  'scope-kind': ['Module', 'Namespace', 'Class', 'Function', 'Block', 'Expression'],
  'edge-kind': [
    'named',
    'alias',
    'namespace',
    'wildcard-expanded',
    'reexport',
    'dynamic-unresolved',
  ],
  origin: ['local', 'import', 'namespace', 'wildcard', 'reexport'],
  'binding-namespace': ['type', 'value', 'both'],
  'type-source': [
    'annotation',
    'parameter-annotation',
    'return-annotation',
    'self',
    'assignment-inferred',
    'constructor-inferred',
    'receiver-propagated',
  ],
  'reference-kind': ['call', 'read', 'write', 'type-reference', 'inherits', 'import-use'],
  'computed-read-kind': ['read'],
  'computed-selection-kind': ['computed'],
  'call-form': ['free', 'member', 'constructor', 'index'],
  unresolved: ['unresolved'],
};
const fail = (reason: string): never => {
  throw new ParsedFileRecordError(reason);
};

/** Two passes: exact bounded byte admission, then bounded encoding. Never calls user toJSON.
 * Only enumerable string-key semantic fields are represented; symbol and nonenumerable metadata is outside this format.
 */
export function encodeParsedFileRecord(
  value: unknown,
  maxBytes = MAX_PARSED_FILE_RECORD_BYTES,
): string {
  return encodeRecord(value, 'file', 'parsedFile', maxBytes);
}

export function encodeGraphNodeRecord(value: unknown, maxBytes = MAX_GRAPH_RECORD_BYTES): string {
  return encodeRecord(
    value,
    { id: 'string', label: 'node-label', properties: 'graph-properties' },
    'graphNode',
    maxBytes,
  );
}

export function encodeGraphRelationshipRecord(
  value: unknown,
  maxBytes = MAX_GRAPH_RECORD_BYTES,
): string {
  return encodeRecord(
    value,
    {
      id: 'string',
      sourceId: 'string',
      targetId: 'string',
      type: 'relationship-type',
      confidence: 'number',
      reason: 'string',
      'step?': 'number',
      'evidence?': 'evidences',
    },
    'graphRelationship',
    maxBytes,
  );
}

function encodeRecord(
  value: unknown,
  recordShape: Shape,
  envelopeKey: 'parsedFile' | 'graphNode' | 'graphRelationship',
  maxBytes: number,
): string {
  const ceiling =
    envelopeKey === 'parsedFile' ? MAX_PARSED_FILE_RECORD_BYTES : MAX_GRAPH_RECORD_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling) fail('invalid-limit');
  let bytes = 0;
  let work = 0;
  let output: string[] | undefined = undefined;
  const ancestors = new Set<object>();
  const emit = (text: string, count = text.length) => {
    bytes += count;
    if (bytes > maxBytes) fail('record-byte-limit');
    output?.push(text);
  };
  const string = (text: string) => {
    // Every UTF-16 code unit costs at least one byte, so refuse before scanning huge strings.
    if (text.length > maxBytes - bytes) fail('record-byte-limit');
    let count = 2;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 32 || c === 34 || c === 92)
        count += c < 32 && ![8, 9, 10, 12, 13].includes(c) ? 6 : 2;
      else if (c < 128) count++;
      else if (c < 2048) count += 2;
      else if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        count += 4;
        i++;
      } else count += c >= 0xd800 && c <= 0xdfff ? 6 : 3;
      if (bytes + count > maxBytes) fail('record-byte-limit');
    }
    emit(output ? JSON.stringify(text) : '', count);
  };
  const visit = (input: unknown, shape: Shape, depth = 0): void => {
    if (++work > 100_000 || depth > 64) fail('record-work-limit');
    if (typeof shape === 'string') {
      if (shape === 'json') {
        if (input === null || typeof input === 'boolean') {
          emit(String(input));
          return;
        }
        if (typeof input === 'string') {
          string(input);
          return;
        }
        if (typeof input === 'number') {
          if (!Number.isFinite(input) || Object.is(input, -0)) fail('invalid-number');
          emit(String(input));
          return;
        }
      }
      if (shape === 'string' || shape === 'nullable-string' || enums[shape]) {
        if (input === null && shape === 'nullable-string') {
          emit('null');
          return;
        }
        if (typeof input !== 'string' || (enums[shape] && !enums[shape].includes(input)))
          fail('invalid-field');
        string(input as string);
        return;
      }
      if (
        shape === 'number' ||
        shape === 'receiver-arity' ||
        shape === 'computed-line' ||
        shape === 'computed-column'
      ) {
        if (typeof input !== 'number' || !Number.isFinite(input) || Object.is(input, -0))
          fail('invalid-number');
        if (shape === 'receiver-arity' && (!Number.isSafeInteger(input) || (input as number) < 0))
          fail('invalid-receiver-arity');
        if (
          (shape === 'computed-line' || shape === 'computed-column') &&
          (!Number.isSafeInteger(input) || (input as number) < (shape === 'computed-line' ? 1 : 0))
        )
          fail('invalid-computed-range');
        emit(String(input));
        return;
      }
    }
    if (!input || typeof input !== 'object' || types.isProxy(input) || ancestors.has(input))
      return fail('invalid-object-or-cycle');
    ancestors.add(input);
    try {
      if (shape === 'json' && Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype || input.length > maxBytes / 2)
          return fail('invalid-array');
        emit('[');
        for (let i = 0; i < input.length; i++) {
          const item = Object.getOwnPropertyDescriptor(input, String(i));
          if (!item || !('value' in item) || !item.enumerable) fail('invalid-array');
          if (i) emit(',');
          visit(item.value, 'json', depth + 1);
        }
        for (const key in input) {
          if (++work > 100_000) fail('record-work-limit');
          if (
            !Object.hasOwn(input, key) ||
            !/^(0|[1-9]\d*)$/.test(key) ||
            Number(key) >= input.length
          )
            fail('unknown-field');
        }
        emit(']');
        return;
      }
      if (shape === 'binding-map' || shape === 'type-map' || shape === 'export-map') {
        if (Object.getPrototypeOf(input) !== Map.prototype) fail('invalid-map');
        const map = input as Map<unknown, unknown>;
        if (map.size > maxBytes / 4) fail('record-byte-limit');
        for (const _key in map) fail('unknown-field');
        emit('{"$map":[');
        let first = true;
        for (const [key, entry] of Map.prototype.entries.call(map)) {
          if (!first) emit(',');
          first = false;
          emit('[');
          visit(key, 'string', depth + 1);
          emit(',');
          visit(
            entry,
            shape === 'binding-map' ? 'bindings' : shape === 'type-map' ? 'type' : 'string',
            depth + 1,
          );
          emit(']');
        }
        emit(']}');
        return;
      }
      if (typeof shape === 'string' && arrays[shape]) {
        if (
          !Array.isArray(input) ||
          Object.getPrototypeOf(input) !== Array.prototype ||
          input.length > maxBytes / 2
        )
          return fail('invalid-array');
        if (shape === 'receiver-steps' && (input.length < 1 || input.length > 64))
          fail('invalid-receiver-steps');
        emit('[');
        for (let i = 0; i < input.length; i++) {
          const item = Object.getOwnPropertyDescriptor(input, String(i));
          if (
            !item ||
            !('value' in item) ||
            ((shape === 'evidences' || shape === 'receiver-steps') && !item.enumerable)
          )
            fail('invalid-array');
          if (i) emit(',');
          visit(item.value, arrays[shape], depth + 1);
        }
        for (const key in input)
          if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length) fail('unknown-field');
        emit(']');
        return;
      }
      if (
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null
      )
        fail('invalid-prototype');
      if (shape === 'json' || shape === 'graph-properties') {
        if (shape === 'graph-properties') {
          for (const key of ['name', 'filePath']) {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (!descriptor) fail('missing-field');
            if (!('value' in descriptor) || !descriptor.enumerable) fail('invalid-property');
            if (typeof descriptor.value !== 'string') fail('invalid-field');
          }
        }
        emit('{');
        let first = true;
        for (const key in input) {
          if (++work > 100_000) fail('record-work-limit');
          if (!Object.hasOwn(input, key)) fail('unknown-field');
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            fail('invalid-property');
          if (descriptor.value === undefined) continue;
          if (!first) emit(',');
          first = false;
          string(key);
          emit(':');
          visit(descriptor.value, 'json', depth + 1);
        }
        emit('}');
        return;
      }
      let objectShape: Shape | undefined = typeof shape === 'string' ? schemas[shape] : shape;
      let computedReference = false;
      if (shape === 'reference') {
        const descriptor = Object.getOwnPropertyDescriptor(input, 'selection');
        if (descriptor) {
          if (!('value' in descriptor) || !descriptor.enumerable) fail('invalid-property');
          objectShape = schemas['computed-reference'];
          computedReference = true;
        }
      }
      if (shape === 'explicit-receiver' || shape === 'receiver-step') {
        const descriptor = Object.getOwnPropertyDescriptor(input, 'kind');
        if (descriptor && (!('value' in descriptor) || !descriptor.enumerable))
          fail('invalid-property');
        const kind = descriptor?.value;
        if (shape === 'explicit-receiver') {
          if (!descriptor) objectShape = { name: 'string' };
          else if (kind === 'unknown') objectShape = { kind: 'string' };
          else if (kind === 'chain')
            objectShape = {
              kind: 'string',
              root: { name: 'string', range },
              steps: 'receiver-steps',
            };
          else fail('invalid-receiver-kind');
        } else if (kind === 'member') objectShape = { kind: 'string', name: 'string', range };
        else if (kind === 'call') objectShape = { kind: 'string', arity: 'receiver-arity', range };
        else fail('invalid-receiver-step-kind');
      }
      if (shape === 'import') {
        const kind = Object.getOwnPropertyDescriptor(input, 'kind')?.value;
        const common = {
          kind: 'string',
          targetRaw: kind === 'dynamic-unresolved' ? 'nullable-string' : 'string',
          'namespace?': 'binding-namespace',
        };
        if (kind === 'wildcard') objectShape = common;
        else if (kind === 'dynamic-unresolved') objectShape = { ...common, localName: 'string' };
        else if (['named', 'alias', 'namespace', 'reexport'].includes(kind))
          objectShape = {
            ...common,
            localName: 'string',
            importedName: 'string',
            ...(kind === 'alias'
              ? { alias: 'string' }
              : kind === 'reexport'
                ? { 'alias?': 'string' }
                : {}),
          };
        else fail('invalid-import-kind');
      }
      if (!objectShape || typeof objectShape === 'string') fail('invalid-schema');
      const fields = objectShape as Record<string, Shape>;
      if (computedReference || shape === 'computed-selection' || shape === 'computed-range') {
        for (const key of Reflect.ownKeys(input)) {
          if (typeof key !== 'string' || !Object.hasOwn(fields, key)) fail('unknown-field');
        }
      }
      let keys = 0;
      for (const key in input) {
        if (
          ++keys > 32 ||
          !Object.hasOwn(input, key) ||
          (!Object.hasOwn(fields, key) && !Object.hasOwn(fields, `${key}?`))
        )
          fail('unknown-field');
      }
      emit('{');
      let first = true;
      for (const [field, childShape] of Object.entries(fields)) {
        const optional = field.endsWith('?');
        const key = optional ? field.slice(0, -1) : field;
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor) {
          if (!optional) fail('missing-field');
          continue;
        }
        if (!('value' in descriptor) || !descriptor.enumerable) fail('invalid-property');
        if (optional && descriptor.value === undefined && envelopeKey === 'graphRelationship')
          continue;
        if (!first) emit(',');
        first = false;
        string(key);
        emit(':');
        if (optional && descriptor.value === undefined) emit('{"$undefined":true}');
        else visit(descriptor.value, childShape, depth + 1);
      }
      emit('}');
      if (shape === 'computed-range' || computedReference) {
        // Fields have been validated above; descriptor reads never execute user code.
        const data = (object: object, key: string) =>
          Object.getOwnPropertyDescriptor(object, key)!.value;
        const before = (left: object, end: boolean, right: object, rightEnd: boolean) => {
          const line = data(left, end ? 'endLine' : 'startLine');
          const otherLine = data(right, rightEnd ? 'endLine' : 'startLine');
          return (
            line < otherLine ||
            (line === otherLine &&
              data(left, end ? 'endCol' : 'startCol') <
                data(right, rightEnd ? 'endCol' : 'startCol'))
          );
        };
        if (shape === 'computed-range') {
          if (!before(input, false, input, true)) fail('invalid-computed-range');
        } else {
          const selection = data(input, 'selection');
          const expression = data(input, 'atRange');
          const object = data(selection, 'objectRange');
          const index = data(selection, 'indexRange');
          if (
            before(object, false, expression, false) ||
            !before(object, true, index, false) ||
            !before(index, true, expression, true)
          )
            fail('invalid-computed-range');
        }
      }
    } finally {
      ancestors.delete(input);
    }
  };
  const pass = () => {
    emit(`{"version":1,"${envelopeKey}":`);
    visit(value, recordShape);
    emit('}\n');
  };
  pass();
  bytes = 0;
  work = 0;
  output = [];
  pass();
  return output.join('');
}

export function decodeParsedFileRecord(line: string): ParsedFile {
  if (
    line.length > MAX_PARSED_FILE_RECORD_BYTES ||
    Buffer.byteLength(line, 'utf8') > MAX_PARSED_FILE_RECORD_BYTES
  )
    fail('record-byte-limit');
  let nesting = 0;
  let quoted = false;
  let escaped = false;
  for (const char of line) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') {
      if (++nesting > 128) fail('record-work-limit');
    } else if (char === ']' || char === '}') nesting--;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(line);
  } catch {
    return fail('malformed-record');
  }
  let work = 0;
  const restore = (value: unknown, depth = 0): unknown => {
    if (++work > 100_000 || depth > 64) fail('record-work-limit');
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => restore(item, depth + 1));
    const obj = value as Record<string, unknown>;
    if (Object.hasOwn(obj, '$undefined')) {
      if (Object.keys(obj).length !== 1 || obj.$undefined !== true) fail('invalid-undefined');
      return undefined;
    }
    if (Object.hasOwn(obj, '$map')) {
      if (Object.keys(obj).length !== 1 || !Array.isArray(obj.$map)) fail('invalid-map');
      const map = new Map<string, unknown>();
      for (const pair of obj.$map as unknown[]) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== 'string' ||
          map.has(pair[0])
        )
          fail('invalid-map');
        map.set(pair[0], restore(pair[1], depth + 1));
      }
      return map;
    }
    for (const key of Object.keys(obj))
      Object.defineProperty(obj, key, {
        value: restore(obj[key], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return obj;
  };
  const record = envelope as Record<string, unknown>;
  if (
    !record ||
    typeof record !== 'object' ||
    Object.keys(record).length !== 2 ||
    record.version !== 1 ||
    !Object.hasOwn(record, 'parsedFile')
  )
    fail('invalid-version-or-envelope');
  const file = restore(record.parsedFile);
  encodeParsedFileRecord(file);
  const parsedFile = file as ParsedFile;
  if (parsedFile.definitionNodeIds !== undefined) {
    for (const correspondence of parsedFile.definitionNodeIds) Object.freeze(correspondence);
    Object.freeze(parsedFile.definitionNodeIds);
    Object.freeze(parsedFile);
  }
  return parsedFile;
}
