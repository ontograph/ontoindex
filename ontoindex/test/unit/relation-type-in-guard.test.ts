import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  relationTypeParamPredicate,
  relationTypePredicate,
} from '../../src/core/lbug/relation-type-predicate.js';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const PREDICATE_FILE = path.join(SRC_ROOT, 'core/lbug/relation-type-predicate.ts');

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

// LadybugDB 0.17.1 returns wrong rows for `<rel>.type IN ...` (literal list
// or parameter); see scripts/repro/ladybug-rel-type-in.mjs. `labels(x)[0]` is
// always '' because labels() returns a STRING indexed from 1; use label(x).
describe('Cypher text in src/ avoids known LadybugDB traps', () => {
  const files = listSourceFiles(SRC_ROOT);

  it('never filters a relationship type with IN', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === PREDICATE_FILE) continue;
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\b[a-z]\w*\.type\s+IN\b/.test(line) && !/^\s*(\*|\/\/)/.test(line)) {
            offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('never projects labels(x)[0]', () => {
    const offenders = files.flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          /labels\(\s*\w+\s*\)\s*\[\s*0\s*\]/.test(line) && !/^\s*(\*|\/\/)/.test(line)
            ? [`${path.relative(SRC_ROOT, file)}:${i + 1}`]
            : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});

describe('relation-type predicates', () => {
  it('builds a deduplicated OR chain of equality checks', () => {
    expect(relationTypePredicate('r', ['CALLS'])).toBe("r.type = 'CALLS'");
    expect(relationTypePredicate('inc', ['CALLS', 'REFERENCES', 'CALLS'])).toBe(
      "(inc.type = 'CALLS' OR inc.type = 'REFERENCES')",
    );
  });

  it('rejects values that are not relation-type identifiers', () => {
    expect(() => relationTypePredicate('r', ["CALLS' OR 1=1 //"])).toThrow(/Invalid relation type/);
    expect(() => relationTypePredicate('r', [])).toThrow();
  });

  it('binds caller-supplied types as parameters', () => {
    expect(relationTypeParamPredicate('r', ['CALLS', "x'y", 'CALLS'], 'edgeType')).toEqual({
      predicate: '(r.type = $edgeType0 OR r.type = $edgeType1)',
      params: { edgeType0: 'CALLS', edgeType1: "x'y" },
    });
  });
});
