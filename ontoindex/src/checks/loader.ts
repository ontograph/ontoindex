import { createRequire } from 'node:module';
import fs from 'fs/promises';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

export interface CheckDefinition {
  id: string;
  type: string;
  args: Record<string, unknown>;
}

interface ChecksFile {
  checks?: unknown;
}

interface RawCheckDefinition {
  id?: unknown;
  type?: unknown;
  args?: unknown;
}

export async function loadChecks(filePath: string): Promise<CheckDefinition[]> {
  const content = await fs.readFile(filePath, 'utf8');

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse checks YAML: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const checks = (parsed as ChecksFile).checks;
  if (!Array.isArray(checks)) {
    return [];
  }

  return checks.map((c: unknown, index: number) => {
    const check = c as RawCheckDefinition;
    if (!check.id || !check.type) {
      throw new Error(`Check at index ${index} is missing required 'id' or 'type' fields`);
    }
    return {
      id: String(check.id),
      type: String(check.type),
      args:
        check.args && typeof check.args === 'object' ? (check.args as Record<string, unknown>) : {},
    };
  });
}
