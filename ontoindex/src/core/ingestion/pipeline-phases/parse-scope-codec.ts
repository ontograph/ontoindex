import type { ParsedFile } from 'ontoindex-shared';
import { types } from 'node:util';

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
};
const schemas: Record<string, Shape> = {
  file: {
    filePath: 'string',
    moduleScope: 'string',
    scopes: 'scopes',
    parsedImports: 'imports',
    localDefs: 'definitions',
    referenceSites: 'references',
  },
  scope: {
    id: 'string',
    parent: 'nullable-string',
    kind: 'scope-kind',
    range,
    filePath: 'string',
    bindings: 'binding-map',
    ownedDefs: 'definitions',
    imports: 'edges',
    typeBindings: 'type-map',
  },
  definition,
  edge,
  binding: { def: definition, origin: 'origin', 'via?': edge },
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
    'explicitReceiver?': { name: 'string' },
    'arity?': 'number',
  },
};
const arrays: Record<string, Shape> = {
  strings: 'string',
  scopes: 'scope',
  imports: 'import',
  definitions: 'definition',
  references: 'reference',
  edges: 'edge',
  types: 'type',
  bindings: 'binding',
};
const enums: Record<string, readonly string[]> = {
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
  'call-form': ['free', 'member', 'constructor', 'index'],
  unresolved: ['unresolved'],
};
const fail = (reason: string): never => {
  throw new ParsedFileRecordError(reason);
};

/** Two passes: exact bounded byte admission, then bounded encoding. Never calls user toJSON.
 * Only enumerable string-key semantic fields are represented; symbol and nonenumerable metadata is outside this format.
 */
export function encodeParsedFileRecord(value: unknown, maxBytes = 256 * 1024): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024)
    fail('invalid-limit');
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
      if (shape === 'number') {
        if (typeof input !== 'number' || !Number.isFinite(input) || Object.is(input, -0))
          fail('invalid-number');
        emit(String(input));
        return;
      }
    }
    if (!input || typeof input !== 'object' || types.isProxy(input) || ancestors.has(input))
      return fail('invalid-object-or-cycle');
    ancestors.add(input);
    try {
      if (shape === 'binding-map' || shape === 'type-map') {
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
          visit(entry, shape === 'binding-map' ? 'bindings' : 'type', depth + 1);
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
        emit('[');
        for (let i = 0; i < input.length; i++) {
          const item = Object.getOwnPropertyDescriptor(input, String(i));
          if (!item || !('value' in item)) fail('invalid-array');
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
      let objectShape: Shape | undefined = typeof shape === 'string' ? schemas[shape] : shape;
      if (shape === 'import') {
        const kind = Object.getOwnPropertyDescriptor(input, 'kind')?.value;
        const common = {
          kind: 'string',
          targetRaw: kind === 'dynamic-unresolved' ? 'nullable-string' : 'string',
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
        if (!first) emit(',');
        first = false;
        string(key);
        emit(':');
        if (optional && descriptor.value === undefined) emit('{"$undefined":true}');
        else visit(descriptor.value, childShape, depth + 1);
      }
      emit('}');
    } finally {
      ancestors.delete(input);
    }
  };
  const pass = () => {
    emit('{"version":1,"parsedFile":');
    visit(value, 'file');
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
  if (line.length > 256 * 1024 || Buffer.byteLength(line, 'utf8') > 256 * 1024)
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
  return file as ParsedFile;
}
