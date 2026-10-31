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
fn rc_enumerate(v: Vec<Foo>) { for (i, x) in v.iter().enumerate() { x.bar(); } }
fn rc_enumerate_map(v: Vec<Foo>) { v.iter().enumerate().map(|(i, x)| x.bar()).count(); }
fn rc_array(a: [Foo; 3]) { a[0].bar(); }
fn rc_slice(s: &[Foo]) { s[0].bar(); }
fn rc_values(m: std::collections::HashMap<u32, Foo>) { m.values().map(|x| x.bar()).count(); }
fn rc_values_for_each(m: std::collections::HashMap<u32, Foo>) { m.values().for_each(|x| x.bar()); }
fn rc_values_mut_map(mut m: std::collections::HashMap<u32, Foo>) { m.values_mut().map(|x| x.bar()).count(); }
fn rc_values_mut_each(m: &mut std::collections::HashMap<u32, Foo>) { m.values_mut().for_each(|x| x.bar()); }
fn rc_values_mut_filter(m: &mut std::collections::HashMap<u32, Foo>) { m.values_mut().filter(|x| { x.bar(); true }).count(); }
fn rc_values_mut_loop(m: &mut std::collections::HashMap<u32, Foo>) { for x in m.values_mut() { x.bar(); } }
fn rc_filter_map(v: Vec<Foo>) { v.iter().filter_map(|x| { x.bar(); Some(x) }).count(); }
fn rc_flat_map(v: Vec<Foo>) { v.iter().flat_map(|x| { x.bar(); vec![x] }).count(); }
fn rc_inspect(v: Vec<Foo>) { v.iter().inspect(|x| x.bar()).count(); }
fn rc_position(v: Vec<Foo>) { v.iter().position(|x| { x.bar(); true }); }
fn rc_take_while(v: Vec<Foo>) { v.iter().take_while(|x| { x.bar(); true }).count(); }
fn rc_skip_while(v: Vec<Foo>) { v.iter().skip_while(|x| { x.bar(); true }).count(); }
fn rc_wrong_enumerate(v: Vec<Foo>) { v.iter().enumerate().map(|(_, x)| x.area()).count(); }
fn rc_wrong_values(m: std::collections::HashMap<u32, Foo>) { m.values().for_each(|x| x.area()); }
fn rc_wrong_values_mut(m: &mut std::collections::HashMap<u32, Foo>) { m.values_mut().for_each(|x| x.area()); }
fn rc_wrong_values_mut_filter(m: &mut std::collections::HashMap<u32, Foo>) { m.values_mut().filter(|x| { x.area(); true }).count(); }
fn rc_wrong_values_mut_loop(m: &mut std::collections::HashMap<u32, Foo>) { for x in m.values_mut() { x.area(); } }
fn rc_enumerate_index(v: Vec<Foo>) { v.iter().enumerate().map(|(i, _)| i.bar()).count(); }
fn rc_loop_index(v: Vec<Foo>) { for (i, _) in v.iter().enumerate() { i.bar(); } }
fn rc_loop_unknown(v) { for (_, x) in v.iter().enumerate() { x.bar(); } }
fn rc_keys(m: std::collections::HashMap<Foo, Other>) { m.keys().map(|x| x.bar()).count(); }
fn rc_other_values(m: std::collections::HashMap<Foo, Other>) { m.values().for_each(|x| x.area()); }
fn rc_map_tuple(m: std::collections::HashMap<Other, Foo>) { m.iter().map(|x| x.bar()).count(); }
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

  it.each([
    'rc_vec',
    'rc_map',
    'rc_filter',
    'rc_for_each',
    'rc_any',
    'rc_all',
    'rc_find',
    'rc_enumerate',
    'rc_enumerate_map',
    'rc_array',
    'rc_slice',
    'rc_values',
    'rc_values_for_each',
    'rc_values_mut_map',
    'rc_values_mut_each',
    'rc_values_mut_filter',
    'rc_values_mut_loop',
    'rc_filter_map',
    'rc_flat_map',
    'rc_inspect',
    'rc_position',
    'rc_take_while',
    'rc_skip_while',
    'rc_keys',
  ])('%s resolves the typed container element method', (caller) => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === 'bar',
    );
    expect(calls).toHaveLength(1);
    const target = result.graph.getNode(calls[0].rel.targetId);
    expect(target?.properties.filePath).toBe('main.rs');
    expect(target?.id).toContain('Foo.bar');
    const fn = tree.rootNode.namedChildren.find(
      (node) => node.childForFieldName('name')?.text === caller,
    )!;
    const method = fn
      .descendantsOfType('field_expression')
      .find((node) => node.childForFieldName('field')?.text === 'bar')!;
    const receiver = method.childForFieldName('value')!;
    expect(buildTypeEnv(tree, 'rust').lookup(receiver.text, method.parent!)).toBe('Foo');
  });

  it.each([
    'rc_closure',
    'rc_foreign',
    'rc_shadow_factory',
    'rc_shadow_local',
    'rc_wrong_enumerate',
    'rc_wrong_values',
    'rc_wrong_values_mut',
    'rc_wrong_values_mut_filter',
    'rc_wrong_values_mut_loop',
    'rc_enumerate_index',
    'rc_loop_index',
    'rc_loop_unknown',
    'rc_map_tuple',
  ])('%s does not borrow a method from an unrelated local receiver', (caller) => {
    expect(
      getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === caller && ['bar', 'area'].includes(edge.target),
      ),
    ).toHaveLength(0);
  });

  it('does not leak adapter parameter types into sibling closures', () => {
    expect(
      getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === 'rc_sibling_closure' && edge.target === 'area',
      ),
    ).toHaveLength(0);
  });

  it('resolves the value type independently from the map key type', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'rc_other_values' && edge.target === 'area',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].rel.targetId).toContain('Other.area');
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
