import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import {
  forEachPatternName,
  isNameShadowed,
} from '../../src/core/ingestion/type-extractors/shared.js';

describe.each([
  ['TypeScript', TypeScript.typescript],
  ['JavaScript', JavaScript],
] as const)('%s name shadowing', (_language, grammar) => {
  const parser = new Parser();
  parser.setLanguage(grammar);

  it.each([
    ['parameter', 'function f(User) { probe(); }', true],
    ['destructured parameter', 'function f({ key: [User = fallback] }) { probe(); }', true],
    ['rest parameter', 'function f(...User) { probe(); }', true],
    ['catch parameter', 'try {} catch (User) { probe(); }', true],
    ['for-of binding', 'for (const User of users) { probe(); }', true],
    ['for initializer', 'for (let User = factory();;) { probe(); }', true],
    ['switch case', 'switch (value) { case 1: const User = factory(); probe(); }', true],
    ['switch default', 'switch (value) { default: const User = factory(); probe(); }', true],
    ['block const', '{ const User = factory(); probe(); }', true],
    ['top-level class', 'class User {} function f() { probe(); }', false],
    ['unrelated inner name', 'function f(Other) { const other = 1; probe(); }', false],
    ['property key', 'function f({ User: Other }) { probe(); }', false],
    ['default expression', 'function f(other = User) { probe(); }', false],
  ])('%s', (_label, source, expected) => {
    const tree = parser.parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    const call = tree.rootNode
      .descendantsOfType('call_expression')
      .find((node) => node.childForFieldName('function')?.text === 'probe')!;
    expect(isNameShadowed(call, 'User')).toBe(expected);
  });

  it('visits bindings only and stops as soon as requested', () => {
    const tree = parser.parse('function f({ key: [User = fallback], ...rest }, Other) {}');
    const parameters = tree.rootNode.firstNamedChild!.childForFieldName('parameters');
    const names: string[] = [];
    expect(
      forEachPatternName(parameters, (name) => {
        names.push(name);
      }),
    ).toBe(false);
    expect(names.sort()).toEqual(['Other', 'User', 'rest']);
    let visits = 0;
    expect(
      forEachPatternName(parameters, () => {
        visits++;
        return true;
      }),
    ).toBe(true);
    expect(visits).toBe(1);
    expect(
      forEachPatternName(null, () => {
        throw new Error('unexpected visit');
      }),
    ).toBe(false);
  });
});
