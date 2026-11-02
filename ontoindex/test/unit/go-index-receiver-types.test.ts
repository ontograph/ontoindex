import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import { buildTypeEnv } from '../../src/core/ingestion/type-env.js';
import { goCallConfig } from '../../src/core/ingestion/call-extractors/configs/go.js';
import {
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from '../integration/resolvers/helpers.js';

describe('Go indexed receiver types', () => {
  let directory: string;
  let result: PipelineResult;
  let tree: Parser.Tree;
  const source = `package main
type User struct {}
func (u User) Save() {}
func (u User) Greet() {}
type Other struct {}
func (o Other) Save() {}
func (o Other) OnlyOther() {}
func makeSlice() { sl := make([]User, 1); sl[0].Save() }
func makeMap() { m := make(map[string]User); m["key"].Greet() }
func localSlice() { var sl []User; sl[0].Save() }
func localArray() { var sl [2]User; sl[0].Save() }
func localMap() { var m map[string]User; m["key"].Save() }
func paramSlice(sl []User) { sl[0].Save() }
func paramArray(sl [2]User) { sl[0].Save() }
func paramMap(m map[string]User) { m["key"].Save() }
func pointerSlice(sl []*User) { sl[0].Save() }
func otherSlice(sl []Other) { sl[0].Save() }
func qualifiedSlice(sl []remote.User) { sl[0].Save() }
func qualifiedPointerSlice(sl []*remote.User) { sl[0].Save() }
func unknown() { unknown[0].Greet() }
func scalar(sl User) { sl[0].Greet() }
func stringIndex(sl string) { sl[0].Greet() }
func channelIndex(sl chan User) { sl[0].Greet() }
func nestedIndex(sl [][]User) { sl[0][0].Greet() }
func nestedElement(sl [][]User) { sl[0].Greet() }
func wrongOwner(sl []User) { sl[0].OnlyOther() }
func shadow(sl []User) { { var sl []Other; sl[0].Save() } }
func nestedFirst() { { var sl []Other }; var sl []User; sl[0].Save() }
func closure(sl []User) { f := func(sl []Other) { sl[0].Save() }; _ = f }
func opaque() { factory()[0].Greet() }
func later() { sl[0].Greet(); var sl []User }
var global []User
func globalIndex() { global[0].Greet() }
func multiMake() { sl, other := make([]User, 1), make([]Other, 1); sl[0].Greet(); _ = other }
func plain() { u := User{}; u.Save() }
`;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ontoindex-go-index-'));
    await writeFile(path.join(directory, 'main.go'), source);
    const parser = new Parser();
    parser.setLanguage(Go);
    tree = parser.parse(source);
    result = await runPipelineFromRepo(directory, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const selectorFor = (caller: string) =>
    tree.rootNode.namedChildren
      .find((node) => node.childForFieldName('name')?.text === caller)!
      .descendantsOfType('selector_expression')[0];

  it.each([
    ['makeSlice', 'Save', 'User'],
    ['makeMap', 'Greet', 'User'],
    ['localSlice', 'Save', 'User'],
    ['localArray', 'Save', 'User'],
    ['localMap', 'Save', 'User'],
    ['paramSlice', 'Save', 'User'],
    ['paramArray', 'Save', 'User'],
    ['paramMap', 'Save', 'User'],
    ['pointerSlice', 'Save', 'User'],
    ['otherSlice', 'Save', 'Other'],
  ])('%s binds the indexed expression to %s on %s', (caller, method, owner) => {
    const selector = selectorFor(caller);
    const receiver = selector.childForFieldName('operand')!;
    expect(buildTypeEnv(tree, 'go').lookup(receiver.text, selector.parent!)).toBe(owner);
    expect(goCallConfig.extractLanguageCallSite!(selector.parent!)).toEqual({
      calledName: method,
      callForm: 'member',
      receiverName: receiver.text,
      argCount: 0,
    });
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === method,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].rel.targetId).toBe(`Method:main.go:${owner}.${method}#0`);
    expect(result.graph.getNode(calls[0].rel.targetId)?.properties.filePath).toBe('main.go');
  });

  it.each([
    'unknown',
    'scalar',
    'stringIndex',
    'channelIndex',
    'nestedIndex',
    'nestedElement',
    'wrongOwner',
    'shadow',
    'nestedFirst',
    'closure',
    'opaque',
    'later',
    'globalIndex',
    'multiMake',
    'qualifiedSlice',
    'qualifiedPointerSlice',
  ])('%s abstains instead of borrowing a name-only method', (caller) => {
    expect(
      getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === caller && ['Save', 'Greet', 'OnlyOther'].includes(edge.target),
      ),
    ).toHaveLength(0);
    if (caller !== 'wrongOwner') {
      const selector = selectorFor(caller);
      expect(
        buildTypeEnv(tree, 'go').lookup(
          selector.childForFieldName('operand')!.text,
          selector.parent!,
        ),
      ).toBeUndefined();
    }
  });

  it('retains the existing make element binding without leaking the expression binding', () => {
    const selector = selectorFor('makeSlice');
    const env = buildTypeEnv(tree, 'go');
    expect(env.lookup('sl', selector.parent!)).toBe('User');
    const fn = tree.rootNode.namedChildren.find(
      (node) => node.childForFieldName('name')?.text === 'makeSlice',
    )!;
    expect(env.lookup('sl[0]', fn)).toBeUndefined();
  });

  it('preserves plain receiver resolution', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'plain' && edge.target === 'Save',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].rel.targetId).toBe('Method:main.go:User.Save#0');
  });
});
