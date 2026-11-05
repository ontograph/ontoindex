import type { RelationshipType } from 'ontoindex-shared';
import { types } from 'node:util';

export const MAX_SCOPE_RETENTION_BYTES = 512 * 1024 * 1024;
export const MAX_SCOPE_RETENTION_RECORDS = 1_000_000;
export const MAX_SCOPE_RETENTION_TIMEOUT_MS = 600_000;
export const MAX_IMPORT_STATE_RECORD_BYTES = 32 * 1024 * 1024;
export const MAX_GRAPH_RECORD_BYTES = 256 * 1024;

export class ParsedFileRecordError extends Error {
  constructor(readonly reason: string) {
    super(`Scope retention: ${reason}`);
  }
}

type Shape = string | { [key: string]: Shape };
const schemas: Record<string, Shape> = {
  evidence: { kind: 'string', weight: 'number', 'note?': 'string' },
};
const arrays: Record<string, Shape> = { evidences: 'evidence' };
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
};
const fail = (reason: string): never => {
  throw new ParsedFileRecordError(reason);
};

/** Two passes: exact bounded byte admission, then bounded encoding. Never calls user toJSON.
 * Only enumerable string-key semantic fields are represented; symbol and nonenumerable metadata is outside this format.
 */
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
  envelopeKey: 'graphNode' | 'graphRelationship',
  maxBytes: number,
): string {
  const ceiling = MAX_GRAPH_RECORD_BYTES;
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
          if (!item || !('value' in item) || (shape === 'evidences' && !item.enumerable))
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
      const objectShape = typeof shape === 'string' ? schemas[shape] : shape;
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
