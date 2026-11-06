import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  forEachPatternName,
  isNameShadowed,
} from '../../src/core/ingestion/type-extractors/shared.js';

describe.each([
  ['TypeScript', TypeScript.typescript],
  ['JavaScript', JavaScript],
] as const)('%s name shadowing', (_language, grammar) => {
  const parser = new Parser();
  parser.setLanguage(grammar as Parameters<Parser['setLanguage']>[0]);

  it.each([
    ['parameter', 'function f(User) { probe(); }', true],
    ['destructured parameter', 'function f({ key: [User = fallback] }) { probe(); }', true],
    ['rest parameter', 'function f(...User) { probe(); }', true],
    ['catch parameter', 'try {} catch (User) { probe(); }', true],
    ['for-of binding', 'for (const User of users) { probe(); }', true],
    ['for initializer', 'for (let User = factory();;) { probe(); }', true],
    ['switch case', 'switch (value) { case 1: const User = factory(); probe(); }', true],
    ['switch default', 'switch (value) { default: const User = factory(); probe(); }', true],
    [
      'sibling switch case',
      'switch (value) { case 1: const User = factory(); case 2: { probe(); } }',
      true,
    ],
    ['sibling switch default', 'switch (value) { case 1: probe(); default: let User; }', true],
    ['block const', '{ const User = factory(); probe(); }', true],
    ['hoisted block var', 'function f() { probe(); if (true) { var User; } }', true],
    ['hoisted block function', 'function f() { if (true) { function User() {} } probe(); }', true],
    [
      'intervening block let prevents promotion',
      'function f() { { let User; { function User() {} } } probe(); }',
      false,
    ],
    [
      'intervening destructured const prevents promotion',
      'function f() { { const { User } = other; { function User() {} } } probe(); }',
      false,
    ],
    [
      'intervening class prevents promotion',
      'function f() { { class User {} { function User() {} } } probe(); }',
      false,
    ],
    [
      'intervening async block function prevents promotion',
      'function f() { { async function User() {} { function User() {} } } probe(); }',
      false,
    ],
    [
      'destructured catch parameter prevents promotion',
      'function f() { try {} catch ({ User }) { { function User() {} } } probe(); }',
      false,
    ],
    [
      'simple catch parameter permits promotion',
      'function f() { try {} catch (User) { { function User() {} } } probe(); }',
      true,
    ],
    [
      'for initializer lexical binding prevents promotion',
      'function f() { for (let User = 0; User < 1; User++) { { function User() {} } } probe(); }',
      false,
    ],
    [
      'for-of lexical binding prevents promotion',
      'function f() { for (const User of []) { { function User() {} } } probe(); }',
      false,
    ],
    [
      'for-of var permits promotion',
      'function f() { for (var other of []) { { function User() {} } } probe(); }',
      true,
    ],
    [
      'for-of assignment permits promotion',
      'function f() { for (User of []) { { function User() {} } } probe(); }',
      true,
    ],
    [
      'sibling switch clause lexical binding prevents promotion',
      'function f() { switch (value) { case 1: let User; break; default: { function User() {} } } probe(); }',
      false,
    ],
    [
      'unrelated sibling lexical binding permits promotion',
      'function f() { { let User; } { function User() {} } probe(); }',
      true,
    ],
    [
      'nested function lexical binding permits promotion',
      'function f() { { function inner() { let User; } { function User() {} } } probe(); }',
      true,
    ],
    [
      'blocked candidate does not suppress eligible sibling',
      'function f() { { let User; { function User() {} } } { function User() {} } probe(); }',
      true,
    ],
    [
      'block function still binds inside its block when promotion is blocked',
      'function f() { { let User; { function User() {} probe(); } } }',
      true,
    ],
    [
      'hoisted block generator',
      'function f() { if (true) { function* User() {} } probe(); }',
      false,
    ],
    [
      'strict function block function',
      'function f() { "use strict"; if (true) { function User() {} } probe(); }',
      false,
    ],
    [
      'strict script block function',
      '"use strict"; function f() { if (true) { function User() {} } probe(); }',
      false,
    ],
    [
      'non-directive string block function',
      'function f() { x(); "use strict"; if (true) { function User() {} } probe(); }',
      true,
    ],
    [
      'plain block "use strict" is not a directive',
      'function f() { { "use strict"; } if (true) { function User() {} } probe(); }',
      true,
    ],
    [
      'escaped "use strict" is not strict',
      'function f() { "use\\x20strict"; if (true) { function User() {} } probe(); }',
      true,
    ],
    [
      'single-quoted strict function block function',
      "function f() { 'use strict'; if (true) { function User() {} } probe(); }",
      false,
    ],
    [
      'hashbang strict script block function',
      '#!/usr/bin/env node\n"use strict"; function f() { if (true) { function User() {} } probe(); }',
      false,
    ],
    [
      'hoisted async block function',
      'function f() { if (true) { async function User() {} } probe(); }',
      false,
    ],
    [
      'module block function',
      'import x from "y"; function f() { if (true) { function User() {} } probe(); }',
      false,
    ],
    [
      'nested import.meta makes program a module',
      'function f() { import.meta; { function User() {} } probe(); }',
      false,
    ],
    [
      'new.target does not make program a module',
      'function f() { new.target; { function User() {} } probe(); }',
      true,
    ],
    [
      'dynamic import does not make program a module',
      'function f() { import("other"); { function User() {} } probe(); }',
      true,
    ],
    [
      'import.meta text does not make program a module',
      'function f() { "import.meta"; /* import.meta */ { function User() {} } probe(); }',
      true,
    ],
    [
      'exported block function',
      'export function f() { if (true) { function User() {} } probe(); }',
      false,
    ],
    [
      'class method block function',
      'class C { m() { if (true) { function User() {} } probe(); } }',
      false,
    ],
    [
      'block function in a nested function',
      'function f() { function inner() { { function User() {} } } probe(); }',
      false,
    ],
    [
      'block generator in a nested function',
      'function f() { function inner() { { function* User() {} } } probe(); }',
      false,
    ],
    ['hoisted for-of var', 'function f() { for (var User of []) {} probe(); }', true],
    ['hoisted static block var', 'class Holder { static { probe(); { var User; } } }', true],
    ['static block sibling let', 'class Holder { static { { let User; } probe(); } }', false],
    [
      'static block nested function var',
      'class Holder { static { function f() { var User; } probe(); } }',
      false,
    ],
    [
      'static block nested class var',
      'class Holder { static { class Inner { static { var User; } } probe(); } }',
      false,
    ],
    [
      'static block var stays inside class',
      'function f() { class Holder { static { { var User; } } } probe(); }',
      false,
    ],
    [
      'hoisted destructured var',
      'function f() { if (true) { var { key: User } = other; } probe(); }',
      true,
    ],
    ['sibling block let', 'function f() { { let User; } probe(); }', false],
    ['expired catch parameter', 'function f() { try {} catch (User) {} probe(); }', false],
    ['expired loop const', 'function f() { for (const User of []) {} probe(); }', false],
    ['nested function var', 'function f() { function inner() { var User; } probe(); }', false],
    ['nested arrow var', 'function f() { const inner = () => { var User; }; probe(); }', false],
    ['nested class var', 'function f() { class Inner { method() { var User; } } probe(); }', false],
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

  it('recognizes a local class in a static block at the constructor use', () => {
    const tree = parser.parse(`
      class User { save() {} }
      class Other { save() {} }
      class Holder { static { class User { save() {} } const u = new User(); u.save(); } }
    `);
    expect(tree.rootNode.hasError).toBe(false);
    const constructor = tree.rootNode
      .descendantsOfType('new_expression')[0]
      .childForFieldName('constructor')!;
    expect(isNameShadowed(constructor, 'User')).toBe(true);
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

describe('JavaScript retained Annex B qualification fixtures', () => {
  const parser = new Parser();
  parser.setLanguage(JavaScript as Parser.Language);

  it.each([
    [
      'strict-html-comment',
      '<!-- legacy comment\n"use strict"; const User="outer"; function f(){ {function User(){}} return User; } f()',
    ],
    [
      'intervening-lexical-binding',
      'const User="outer"; function f(){ {let User; {function User(){}}} return User; } f()',
    ],
    [
      'module-import-meta',
      'import.meta; const User="outer"; function f(){ {function User(){}} return User; } globalThis.__ontoindex254Oracle=f();',
    ],
  ])('%s resolves the outer binding', (_label, source) => {
    const tree = parser.parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    const reference = tree.rootNode.descendantsOfType('return_statement')[0].firstNamedChild!;
    expect(isNameShadowed(reference, 'User')).toBe(false);
  });

  it.each([
    [
      'function directive after HTML comment',
      'function f() { <!-- legacy\n"use strict"; { function User() {} } probe(); }',
      false,
    ],
    [
      'closing HTML comment before directive',
      '--> legacy\n"use strict"; function f() { { function User() {} } probe(); }',
      false,
    ],
    [
      'HTML comment without strict directive',
      '<!-- legacy\nfunction f() { { function User() {} } probe(); }',
      true,
    ],
    [
      'HTML comment after directive prologue ended',
      '0; <!-- legacy\n"use strict"; function f() { { function User() {} } probe(); }',
      true,
    ],
  ] as const)('%s', (_label, source, expected) => {
    const tree = parser.parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    const call = tree.rootNode.descendantsOfType('call_expression')[0];
    expect(isNameShadowed(call, 'User')).toBe(expected);
  });
});

describe('JavaScript using declaration shadowing', () => {
  const parser = new Parser();
  parser.setLanguage(JavaScript as Parser.Language);

  it.each([
    ['enclosing block', 'function f() { using User = getRes(); return new User(); }', true],
    ['sibling block', 'function f() { { using User = getRes(); } return new User(); }', false],
  ] as const)('%s', (_label, source, expected) => {
    const tree = parser.parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('using_declaration')).toHaveLength(1);
    const constructor = tree.rootNode
      .descendantsOfType('new_expression')[0]
      .childForFieldName('constructor')!;
    expect(isNameShadowed(constructor, 'User')).toBe(expected);
  });
});

describe('scope-aware constructor and factory call inference', () => {
  it.each([
    [
      'block function shadows factory return',
      'js',
      'function factory(){if(true){function User(){}} return new User()} function probe(){const u=factory();u.save()}',
      false,
    ],
    [
      'block function in another function does not shadow factory return',
      'js',
      'function other(){if(true){function User(){}}} function factory(){return new User()} function probe(){const u=factory();u.save()}',
      true,
    ],
    [
      'HTML comment preserves strict factory return inference',
      'js',
      'function factory(){<!-- legacy\n"use strict"; {function User(){}} return new User()} function probe(){const u=factory();u.save()}',
      true,
    ],
    [
      'intervening lexical binding preserves factory return inference',
      'js',
      'function factory(){{let User;{function User(){}}} return new User()} function probe(){const u=factory();u.save()}',
      true,
    ],
    [
      'import.meta preserves module factory return inference',
      'js',
      'import.meta; function factory(){{function User(){}} return new User()} function probe(){const u=factory();u.save()}',
      true,
    ],
    [
      'using binding shadows factory return',
      'js',
      'function factory(){using User=getRes();return new User()} function probe(){const u=factory();u.save()}',
      false,
    ],
    [
      'sibling using binding does not shadow factory return',
      'js',
      'function factory(){{using User=getRes();}return new User()} function probe(){const u=factory();u.save()}',
      true,
    ],
    [
      'catch binding ends before factory return',
      'js',
      'function factory(){try{throw Other}catch(User){} return new User()} function probe(){const u=factory();u.save()}',
      true,
    ],
    [
      'loop binding ends before factory return',
      'js',
      'function factory(){for(const User of []){} return new User()} function probe(){const u=factory();u.save()}',
      true,
    ],
    [
      'hoisted var shadows constructor field type',
      'js',
      'class Store{constructor(){if(true){var User=Other;} this.item=new User()}} function probe(){const s=new Store();const {item}=s;item.save()}',
      false,
    ],
    [
      'sibling switch binding shadows iterable factory',
      'ts',
      'function getUsers(): Array<User>{return []} function probe(){switch(1){case 1: const getUsers=()=>[new Other()];case 2:{const users=getUsers();for(const u of users){u.save()}}}}',
      false,
    ],
  ] as const)(
    '%s',
    async (_name, extension, source, expected) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'ontoindex-name-shadowing-'));
      try {
        await writeFile(
          path.join(directory, `main.${extension}`),
          `class User{save(){}} class Other{save(){}}\n${source}`,
        );
        const { graph } = await runPipelineFromRepo(directory, () => {}, {
          skipGraphPhases: true,
          skipWorkers: true,
        });
        const userCalls = graph.relationships.filter(
          (edge) =>
            edge.type === 'CALLS' &&
            graph.getNode(edge.sourceId)?.properties.name === 'probe' &&
            graph.getNode(edge.targetId)?.properties.name === 'save' &&
            /User[.#]save/.test(edge.targetId),
        );
        expect(userCalls.length > 0).toBe(expected);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    60000,
  );
});
