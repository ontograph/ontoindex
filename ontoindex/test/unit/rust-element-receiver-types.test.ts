import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';
import { buildTypeEnv } from '../../src/core/ingestion/type-env.js';
import {
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from '../integration/resolvers/helpers.js';

describe('Rust element receiver types', () => {
  let directory: string;
  let result: PipelineResult;
  let tree: Parser.Tree;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ontoindex-rust-elements-'));
    const source = `
struct Foo;
impl Foo { fn bar(&self) {} }
struct Other;
impl Other { fn bar(&self) {} fn area(&self) {} }
fn mk() -> Foo { Foo }
fn rc_vec(v: Vec<Foo>) { v[0].bar(); }
fn rc_map(v: Vec<Foo>) { v.iter().map(|x| x.bar()).count(); }
fn rc_filter(v: Vec<Foo>) { v.iter().filter(|x| { x.bar(); true }).count(); }
fn rc_for_each(v: Vec<Foo>) { v.iter().for_each(|x| x.bar()); }
fn rc_any(v: Vec<Foo>) { v.iter().any(|x| { x.bar(); true }); }
fn rc_all(v: Vec<Foo>) { v.iter().all(|x| { x.bar(); true }); }
fn rc_find(v: Vec<Foo>) { v.iter().find(|x| { x.bar(); true }); }
fn rc_closure() { let g = |f| f.bar(); }
fn rc_foreign() { make_sq(2).area(); }
fn rc_shadow_factory() { let f = mk(); let g = |f| f.bar(); g(Other {}); }
fn rc_shadow_local() { let f = Other {}; let g = |f| f.bar(); }
fn rc_typed_closure() { let g = |f: Other| f.bar(); }
fn rc_plain() { let f = mk(); f.bar(); }
fn rc_after_closure() { let f = Foo {}; let g = |f: Other| {}; f.bar(); }
fn rc_sibling_closure(v: Vec<Foo>) { v.iter().map(|x| x.bar()); let g = |x| x.area(); }
`;
    await writeFile(path.join(directory, 'main.rs'), source);
    const parser = new Parser();
    parser.setLanguage(Rust);
    tree = parser.parse(source);
    result = await runPipelineFromRepo(directory, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(['rc_vec', 'rc_map', 'rc_filter', 'rc_for_each', 'rc_any', 'rc_all', 'rc_find'])(
    '%s resolves the typed container element method',
    (caller) => {
      const calls = getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === caller && edge.target === 'bar',
      );
      expect(calls).toHaveLength(1);
      const target = result.graph.getNode(calls[0].rel.targetId);
      expect(target?.id).toContain('Foo.bar');
      const fn = tree.rootNode.namedChildren.find(
        (node) => node.childForFieldName('name')?.text === caller,
      )!;
      const method = fn
        .descendantsOfType('field_expression')
        .find((node) => node.childForFieldName('field')?.text === 'bar')!;
      const receiver = method.childForFieldName('value')!;
      expect(buildTypeEnv(tree, 'rust').lookup(receiver.text, method.parent!)).toBe('Foo');
    },
  );

  it.each(['rc_closure', 'rc_foreign', 'rc_shadow_factory', 'rc_shadow_local'])(
    '%s does not borrow a method from an unrelated local receiver',
    (caller) => {
      expect(
        getRelationships(result, 'CALLS').filter(
          (edge) => edge.source === caller && ['bar', 'area'].includes(edge.target),
        ),
      ).toHaveLength(0);
    },
  );

  it('does not leak adapter parameter types into sibling closures', () => {
    expect(
      getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === 'rc_sibling_closure' && edge.target === 'area',
      ),
    ).toHaveLength(0);
  });

  it.each([
    ['rc_typed_closure', 'Other.bar'],
    ['rc_plain', 'Foo.bar'],
    ['rc_after_closure', 'Foo.bar'],
  ])('%s retains its known receiver type', (caller, method) => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === 'bar',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].rel.targetId).toContain(method);
  });
});
