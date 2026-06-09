import fs from 'node:fs';
import path from 'node:path';

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
};

export function loadJsonFixture(relativePath: string): JsonSchema {
  const fixturePath = path.join(process.cwd(), 'test', 'fixtures', relativePath);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as JsonSchema;
}

export function expectSchemaMatch(schema: JsonSchema, value: unknown): void {
  const errors = validateJsonSchema(schema, value, '$');
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

function validateJsonSchema(schema: JsonSchema, value: unknown, pointer: string): string[] {
  const errors: string[] = [];

  if (schema.const !== undefined && !sameJson(value, schema.const)) {
    errors.push(`${pointer} must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }

  if (schema.enum !== undefined && !schema.enum.some((item) => sameJson(item, value))) {
    errors.push(
      `${pointer} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`,
    );
    return errors;
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push(
      `${pointer} must be ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}`,
    );
    return errors;
  }

  if (isObjectSchema(schema, value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        errors.push(`${pointer}.${key} is required`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        errors.push(...validateJsonSchema(childSchema, value[key], `${pointer}.${key}`));
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(schema.items as JsonSchema, item, `${pointer}[${index}]`));
    });
  }

  return errors;
}

function matchesType(expected: string | string[], value: unknown): boolean {
  const allowed = Array.isArray(expected) ? expected : [expected];
  return allowed.some((type) => {
    switch (type) {
      case 'null':
        return value === null;
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      default:
        return typeof value === type;
    }
  });
}

function isObjectSchema(schema: JsonSchema, value: unknown): value is Record<string, unknown> {
  return (
    schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
