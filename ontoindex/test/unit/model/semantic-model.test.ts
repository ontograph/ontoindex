/**
 * Unit tests for SemanticModel factory and lifecycle.
 *
 * Focused on behaviors that are NOT covered by the transitive
 * ingestion-pipeline tests in symbol-table.test.ts:
 *
 *   1. model.clear() must cascade to all four stores (types, methods,
 *      fields, rawSymbols). Post-A2 (plan 006 Unit 7), this is the only
 *      path that resets the leaf AND the registries. External consumers
 *      hold a SymbolTableReader which has no `clear()` method, so the
 *      phantom-resolution failure mode is statically impossible.
 *
 *   2. createSemanticModel() must construct successfully against the
 *      real ALL_NODE_LABELS and current registration-table allowlists.
 *      A failure here means the dev-time exhaustiveness guard is
 *      flagging real drift that needs a registration-table fix.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createSemanticModel,
  restoreSemanticModelRegistrations,
} from '../../../src/core/ingestion/model/semantic-model.js';
import type { SymbolDefinition } from 'ontoindex-shared';

describe('createSemanticModel', () => {
  it('constructs successfully — no drift between ALL_NODE_LABELS and the registration-table allowlists', () => {
    expect(() => createSemanticModel()).not.toThrow();
  });
});

describe('model.clear() cascade (A2 / Unit 7)', () => {
  it('clears the type registry', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');

    expect(model.types.lookupClassByName('User')).toHaveLength(1);

    model.clear();

    expect(model.types.lookupClassByName('User')).toHaveLength(0);
  });

  it('clears the field registry', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
      ownerId: 'class:User',
      declaredType: 'string',
    });

    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeDefined();

    model.clear();

    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
  });

  it('clears the method registry', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'greet', 'method:User.greet', 'Method', {
      ownerId: 'class:User',
    });

    expect(model.methods.lookupMethodByOwner('class:User', 'greet')).toBeDefined();

    model.clear();

    expect(model.methods.lookupMethodByOwner('class:User', 'greet')).toBeUndefined();
  });

  it('clears the file and callable indexes', () => {
    const model = createSemanticModel();
    model.symbols.add('src/utils.ts', 'format', 'fn:format', 'Function');

    expect(model.symbols.lookupCallableByName('format')).toHaveLength(1);
    expect(Array.from(model.symbols.getFiles())).toContain('src/utils.ts');

    model.clear();

    expect(model.symbols.lookupCallableByName('format')).toHaveLength(0);
    expect(Array.from(model.symbols.getFiles())).not.toContain('src/utils.ts');
  });

  it('is idempotent — calling twice leaves every store empty', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
      ownerId: 'class:User',
    });

    model.clear();
    model.clear();

    expect(model.types.lookupClassByName('User')).toHaveLength(0);
    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
    expect(model.symbols.lookupCallableByName('User')).toHaveLength(0);
  });

  it('post-A2: model.symbols exposes no clear() method', () => {
    // Static guarantee enforced by the SymbolTableReader interface — this
    // runtime assertion documents the contract.
    const model = createSemanticModel();
    expect('clear' in model.symbols).toBe(false);
  });
});

describe('model.clear() cascade', () => {
  it('clears every store — types, methods, fields, symbols', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'name', 'prop:User.name', 'Property', {
      ownerId: 'class:User',
    });
    model.symbols.add('src/user.ts', 'greet', 'method:User.greet', 'Method', {
      ownerId: 'class:User',
    });

    model.clear();

    expect(model.types.lookupClassByName('User')).toHaveLength(0);
    expect(model.fields.lookupFieldByOwner('class:User', 'name')).toBeUndefined();
    expect(model.methods.lookupMethodByOwner('class:User', 'greet')).toBeUndefined();
    expect(model.symbols.lookupCallableByName('User')).toHaveLength(0);
    expect(Array.from(model.symbols.getFiles())).not.toContain('src/user.ts');
  });
});

describe('semantic registration observation', () => {
  it('observes successful mutations once in order, including duplicates, without local capture', () => {
    const events: string[] = [];
    const model: ReturnType<typeof createSemanticModel> = createSemanticModel({
      onRegistration: (encoded) => {
        const event = JSON.parse(encoded);
        if (event.kind === 'symbol.add')
          expect(model.symbols.lookupExact(event.filePath, event.name)).toBe(event.nodeId);
        events.push(encoded);
        return true;
      },
    });
    model.symbols.add('src/é😀.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/é😀.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/é😀.ts', 'save', 'method:save', 'Function', { ownerId: 'class:User' });
    expect(events.map((event) => JSON.parse(event))).toEqual([
      {
        kind: 'symbol.add',
        filePath: 'src/é😀.ts',
        name: 'User',
        nodeId: 'class:User',
        type: 'Class',
      },
      {
        kind: 'symbol.add',
        filePath: 'src/é😀.ts',
        name: 'User',
        nodeId: 'class:User',
        type: 'Class',
      },
      {
        kind: 'symbol.add',
        filePath: 'src/é😀.ts',
        name: 'save',
        nodeId: 'method:save',
        type: 'Function',
        metadata: { ownerId: 'class:User' },
      },
    ]);
    expect(model.snapshotRegistrations()).toBeUndefined();
    const restored = restoreSemanticModelRegistrations({
      version: 1,
      events: events.map((event) => JSON.parse(event)),
    });
    expect(restored.types.lookupClassByName('User')).toEqual(model.types.lookupClassByName('User'));
    expect(restored.types.lookupClassByName('User')).toHaveLength(2);
    expect(restored.symbols.lookupExactAll('src/é😀.ts', 'User')).toHaveLength(1);
    expect(restored.methods.lookupMethodByName('save')).toEqual(
      model.methods.lookupMethodByName('save'),
    );
  });

  it('replays direct writes, individual clears and full clear in chronological order', () => {
    const events: string[] = [];
    const model = createSemanticModel({
      captureRegistrations: true,
      onRegistration: (encoded) => {
        events.push(encoded);
        return true;
      },
    });
    const def: SymbolDefinition = { nodeId: 'direct:User', filePath: 'direct.ts', type: 'Class' };
    model.types.registerClass('User', 'direct.User', def);
    model.types.registerImpl('User', { ...def, nodeId: 'impl:User', type: 'Impl' });
    model.methods.register('direct:User', 'save', {
      ...def,
      nodeId: 'method:save',
      type: 'Method',
    });
    model.fields.register('direct:User', 'id', { ...def, nodeId: 'field:id', type: 'Property' });
    model.types.clear();
    model.methods.clear();
    model.fields.clear();
    model.symbols.add('old.ts', 'Old', 'class:Old', 'Class');
    model.clear();
    expect(model.snapshotRegistrations()).toEqual({ version: 1, events: [] });
    model.symbols.add('new.ts', 'New', 'class:New', 'Class');
    model.methods.register('class:New', 'save', { ...def, nodeId: 'new:save', type: 'Method' });
    expect(events.map((event) => JSON.parse(event).kind)).toEqual([
      'type.registerClass',
      'type.registerImpl',
      'method.register',
      'field.register',
      'type.clear',
      'method.clear',
      'field.clear',
      'symbol.add',
      'model.clear',
      'symbol.add',
      'method.register',
    ]);
    const restored = restoreSemanticModelRegistrations({
      version: 1,
      events: events.map((event) => JSON.parse(event)),
    });
    expect([...restored.symbols.getFiles()]).toEqual(['new.ts']);
    expect(restored.symbols.getStats()).toEqual(model.symbols.getStats());
    for (const name of ['User', 'Old', 'New'])
      expect(restored.types.lookupClassByName(name)).toEqual(model.types.lookupClassByName(name));
    expect(restored.methods.lookupMethodByOwner('direct:User', 'save')).toBeUndefined();
    expect(restored.fields.lookupFieldByOwner('direct:User', 'id')).toBeUndefined();
    expect(restored.methods.lookupMethodByOwner('class:New', 'save')).toEqual(
      model.methods.lookupMethodByOwner('class:New', 'save'),
    );
    expect(model.snapshotRegistrations()!.events.map((event) => event.kind)).toEqual([
      'symbol.add',
      'method.register',
    ]);
  });

  it('detaches encoded observer metadata from producer and replay mutations', () => {
    const events: string[] = [];
    const parameterTypes = ['服务😀'];
    const model = createSemanticModel({
      onRegistration: (encoded) => {
        events.push(encoded);
        return true;
      },
    });
    model.symbols.add('one.ts', 'save', 'method:save', 'Method', {
      ownerId: 'class:User',
      parameterTypes,
    });
    const encoded = events[0]!;
    parameterTypes[0] = 'Changed';
    expect(events[0]).toBe(encoded);
    const restored = restoreSemanticModelRegistrations({
      version: 1,
      events: events.map((event) => JSON.parse(event)),
    });
    expect(restored.methods.lookupMethodByOwner('class:User', 'save')!.parameterTypes).toEqual([
      '服务😀',
    ]);
    restored.methods.lookupMethodByOwner('class:User', 'save')!.parameterTypes![0] =
      'Replay mutation';
    expect(JSON.parse(events[0]!).metadata.parameterTypes).toEqual(['服务😀']);
  });

  it.each(['false', 'throw'] as const)(
    'disables a rejected observer once on %s while preserving mutations and local capture',
    (failure) => {
      const observer = vi.fn(() => {
        if (failure === 'throw') throw new Error('observer failure');
        return false;
      });
      const onRegistrationError = vi.fn(() => {
        throw new Error('error handler failure');
      });
      const model = createSemanticModel({
        captureRegistrations: true,
        onRegistration: observer,
        onRegistrationError,
      });
      expect(() => model.symbols.add('old.ts', 'Old', 'class:Old', 'Class')).not.toThrow();
      model.symbols.add('old.ts', 'Other', 'class:Other', 'Class');
      expect(model.snapshotRegistrations()!.events).toHaveLength(2);
      model.clear();
      expect(model.snapshotRegistrations()).toEqual({ version: 1, events: [] });
      expect(() => model.symbols.add('new.ts', 'New', 'class:New', 'Class')).not.toThrow();
      expect(observer).toHaveBeenCalledTimes(1);
      expect(onRegistrationError).toHaveBeenCalledTimes(1);
      expect(model.types.lookupClassByName('New')).toHaveLength(1);
      const restored = restoreSemanticModelRegistrations(model.snapshotRegistrations());
      expect(restored.types.lookupClassByName('New')).toEqual(model.types.lookupClassByName('New'));
    },
  );

  it('disables oversized observation without preventing the legacy mutation or later registrations', () => {
    const onRegistration = vi.fn(() => true);
    const onRegistrationError = vi.fn();
    const model = createSemanticModel({ onRegistration, onRegistrationError });
    const qualifiedName = '界'.repeat(300_000);
    expect(() =>
      model.symbols.add('one.ts', 'Huge', 'class:Huge', 'Class', { qualifiedName }),
    ).not.toThrow();
    expect(model.types.lookupClassByQualifiedName(qualifiedName)).toHaveLength(1);
    expect(() => model.symbols.add('one.ts', 'Next', 'class:Next', 'Class')).not.toThrow();
    expect(model.types.lookupClassByName('Next')).toHaveLength(1);
    expect(onRegistration).not.toHaveBeenCalled();
    expect(onRegistrationError).toHaveBeenCalledTimes(1);
    expect(model.snapshotRegistrations()).toBeUndefined();
  });

  it('preserves local registration chronology when an observer writes reentrantly', () => {
    const onRegistrationError = vi.fn();
    const onRegistration = vi.fn(() => {
      model.symbols.add('nested.ts', 'Nested', 'class:Nested', 'Class');
      return true;
    });
    const model: ReturnType<typeof createSemanticModel> = createSemanticModel({
      captureRegistrations: true,
      onRegistration,
      onRegistrationError,
    });
    model.symbols.add('outer.ts', 'Outer', 'class:Outer', 'Class');
    model.symbols.add('later.ts', 'Later', 'class:Later', 'Class');
    expect(onRegistration).toHaveBeenCalledTimes(1);
    expect(onRegistrationError).toHaveBeenCalledTimes(1);
    const snapshot = model.snapshotRegistrations()!;
    expect(
      snapshot.events.map((event) => (event.kind === 'symbol.add' ? event.name : event.kind)),
    ).toEqual(['Outer', 'Nested', 'Later']);
    const restored = restoreSemanticModelRegistrations(snapshot);
    for (const name of ['Outer', 'Nested', 'Later'])
      expect(restored.types.lookupClassByName(name)).toEqual(model.types.lookupClassByName(name));
    expect(restored.symbols.getStats()).toEqual(model.symbols.getStats());
  });

  it('disables observation on reentrant full clear and captures only subsequent registrations', () => {
    const onRegistrationError = vi.fn();
    const onRegistration = vi.fn(() => {
      model.clear();
      model.symbols.add('nested.ts', 'Nested', 'class:Nested', 'Class');
      return true;
    });
    const model: ReturnType<typeof createSemanticModel> = createSemanticModel({
      captureRegistrations: true,
      onRegistration,
      onRegistrationError,
    });
    model.symbols.add('outer.ts', 'Outer', 'class:Outer', 'Class');
    model.symbols.add('later.ts', 'Later', 'class:Later', 'Class');
    expect(onRegistration).toHaveBeenCalledTimes(1);
    expect(onRegistrationError).toHaveBeenCalledTimes(1);
    expect(
      model
        .snapshotRegistrations()!
        .events.map((event) => (event.kind === 'symbol.add' ? event.name : event.kind)),
    ).toEqual(['Nested', 'Later']);
    const restored = restoreSemanticModelRegistrations(model.snapshotRegistrations());
    expect(restored.types.lookupClassByName('Outer')).toEqual([]);
    expect([...restored.symbols.getFiles()]).toEqual(['nested.ts', 'later.ts']);
    expect(restored.symbols.getStats()).toEqual(model.symbols.getStats());
  });

  it('runs rejection error callbacks after committing local capture so callback clear and writes survive', () => {
    const onRegistration = vi.fn(() => false);
    const onRegistrationError = vi.fn(() => {
      expect(model.snapshotRegistrations()!.events).toHaveLength(1);
      expect(model.types.lookupClassByName('Outer')).toHaveLength(1);
      model.clear();
      model.symbols.add('nested.ts', 'Nested', 'class:Nested', 'Class');
    });
    const model: ReturnType<typeof createSemanticModel> = createSemanticModel({
      captureRegistrations: true,
      onRegistration,
      onRegistrationError,
    });
    model.symbols.add('outer.ts', 'Outer', 'class:Outer', 'Class');
    model.symbols.add('later.ts', 'Later', 'class:Later', 'Class');
    expect(onRegistration).toHaveBeenCalledTimes(1);
    expect(onRegistrationError).toHaveBeenCalledTimes(1);
    expect(
      model
        .snapshotRegistrations()!
        .events.map((event) => (event.kind === 'symbol.add' ? event.name : event.kind)),
    ).toEqual(['Nested', 'Later']);
    const restored = restoreSemanticModelRegistrations(model.snapshotRegistrations());
    expect(restored.types.lookupClassByName('Outer')).toEqual([]);
    expect([...restored.symbols.getFiles()]).toEqual(['nested.ts', 'later.ts']);
    expect(restored.types.lookupClassByName('Nested')).toEqual(
      model.types.lookupClassByName('Nested'),
    );
  });

  it('runs invalid-observation error callbacks after the legacy mutation without losing callback writes', () => {
    const onRegistration = vi.fn(() => true);
    const onRegistrationError = vi.fn(() => {
      expect(model.types.lookupClassByName('Huge')).toHaveLength(1);
      model.clear();
      model.symbols.add('nested.ts', 'Nested', 'class:Nested', 'Class');
    });
    const model: ReturnType<typeof createSemanticModel> = createSemanticModel({
      onRegistration,
      onRegistrationError,
    });
    model.symbols.add('outer.ts', 'Huge', 'class:Huge', 'Class', {
      qualifiedName: 'x'.repeat(300_000),
    });
    model.symbols.add('later.ts', 'Later', 'class:Later', 'Class');
    expect(onRegistration).not.toHaveBeenCalled();
    expect(onRegistrationError).toHaveBeenCalledTimes(1);
    expect(model.snapshotRegistrations()).toBeUndefined();
    expect(model.types.lookupClassByName('Huge')).toEqual([]);
    expect(model.types.lookupClassByName('Nested')).toHaveLength(1);
    expect([...model.symbols.getFiles()]).toEqual(['nested.ts', 'later.ts']);
  });

  it('keeps explicit local capture validation strict even when an observer is configured', () => {
    const onRegistration = vi.fn(() => true);
    const model = createSemanticModel({ captureRegistrations: true, onRegistration });
    expect(() =>
      model.symbols.add('one.ts', 'Huge', 'class:Huge', 'Class', {
        qualifiedName: 'x'.repeat(300_000),
      }),
    ).toThrow();
    expect(model.types.lookupClassByName('Huge')).toEqual([]);
    expect(model.snapshotRegistrations()).toEqual({ version: 1, events: [] });
    expect(onRegistration).not.toHaveBeenCalled();
  });
});

describe('semantic registration capture and replay', () => {
  const symbolEvent = {
    kind: 'symbol.add',
    filePath: 'src/user.ts',
    name: 'User',
    nodeId: 'class:User',
    type: 'Class',
  };

  it('leaves capture disabled by default without changing registration behavior', () => {
    const model = createSemanticModel();
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    expect(model.snapshotRegistrations()).toBeUndefined();
    expect(model.types.lookupClassByName('User')).toHaveLength(1);
  });

  it('replays JSON-roundtripped registrations with original labels, qualified names and overloads', () => {
    const model = createSemanticModel({ captureRegistrations: true });
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class', { qualifiedName: 'app.User' });
    model.symbols.add('src/user.ts', 'greet', 'fn:greet:0', 'Function', {
      ownerId: 'class:User',
      parameterCount: 0,
      returnType: 'string',
    });
    model.symbols.add('src/user.ts', 'greet', 'fn:greet:1', 'Function', {
      ownerId: 'class:User',
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['number'],
      returnType: 'number',
    });
    model.symbols.add('src/user.ts', 'name', 'prop:name', 'Property', {
      ownerId: 'class:User',
      declaredType: 'string',
    });
    const restored = restoreSemanticModelRegistrations(
      JSON.parse(JSON.stringify(model.snapshotRegistrations())),
    );

    expect(restored.types.lookupClassByQualifiedName('app.User')).toEqual(
      model.types.lookupClassByName('User'),
    );
    expect(restored.methods.lookupMethodByOwner('class:User', 'greet')).toBeUndefined();
    for (const arity of [0, 1]) {
      expect(restored.methods.lookupMethodByOwner('class:User', 'greet', arity)).toEqual(
        model.methods.lookupMethodByOwner('class:User', 'greet', arity),
      );
    }
    expect(restored.methods.lookupMethodByName('greet')).toEqual(
      model.methods.lookupMethodByName('greet'),
    );
    expect(restored.methods.lookupMethodByName('greet').map((def) => def.type)).toEqual([
      'Function',
      'Function',
    ]);
    expect(restored.methods.hasFunctionMethods).toBe(true);
    expect(restored.fields.lookupFieldByOwner('class:User', 'name')).toEqual(
      model.fields.lookupFieldByOwner('class:User', 'name'),
    );
    expect(restored.symbols.lookupCallableByName('greet')).toEqual(
      model.symbols.lookupCallableByName('greet'),
    );
    expect(restored.symbols.lookupExactAll('src/user.ts', 'greet')).toEqual(
      model.symbols.lookupExactAll('src/user.ts', 'greet'),
    );
    expect([...restored.symbols.getFiles()]).toEqual([...model.symbols.getFiles()]);
    expect(restored.symbols.getStats()).toEqual(model.symbols.getStats());
  });

  it('retains repeated fan-out even when the raw symbol index deduplicates', () => {
    const model = createSemanticModel({ captureRegistrations: true });
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    const restored = restoreSemanticModelRegistrations(model.snapshotRegistrations());
    expect(restored.symbols.lookupExactAll('src/user.ts', 'User')).toHaveLength(1);
    expect(restored.types.lookupClassByName('User')).toHaveLength(2);
    expect(restored.types.lookupClassByName('User')).toEqual(model.types.lookupClassByName('User'));
  });

  it('captures direct registry writes without adding them to file or callable indexes', () => {
    const model = createSemanticModel({ captureRegistrations: true });
    const def: SymbolDefinition = {
      nodeId: 'direct:User',
      filePath: 'src/direct.ts',
      type: 'Class',
    };
    model.types.registerClass('User', 'direct.User', def);
    model.types.registerImpl('User', { ...def, nodeId: 'impl:User', type: 'Impl' });
    model.methods.register('direct:User', 'save', {
      ...def,
      nodeId: 'method:save',
      type: 'Method',
      returnType: 'void',
    });
    model.fields.register('direct:User', 'id', {
      ...def,
      nodeId: 'field:id',
      type: 'Property',
      declaredType: 'number',
    });
    const restored = restoreSemanticModelRegistrations(model.snapshotRegistrations());
    expect(restored.types.lookupClassByName('User')).toEqual([def]);
    expect(restored.types.lookupClassByQualifiedName('direct.User')).toEqual([def]);
    expect(restored.types.lookupImplByName('User')).toEqual(model.types.lookupImplByName('User'));
    expect(restored.methods.lookupMethodByOwner('direct:User', 'save')).toEqual(
      model.methods.lookupMethodByOwner('direct:User', 'save'),
    );
    expect(restored.fields.lookupFieldByOwner('direct:User', 'id')).toEqual(
      model.fields.lookupFieldByOwner('direct:User', 'id'),
    );
    expect(restored.symbols.getStats()).toEqual({ fileCount: 0 });
    expect(restored.symbols.lookupCallableByName('save')).toEqual([]);
  });

  it('preserves individual registry clears in chronological order', () => {
    const model = createSemanticModel({ captureRegistrations: true });
    model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    model.symbols.add('src/user.ts', 'save', 'method:save', 'Function', { ownerId: 'class:User' });
    model.symbols.add('src/user.ts', 'id', 'field:id', 'Property', { ownerId: 'class:User' });
    model.types.clear();
    model.methods.clear();
    model.fields.clear();
    model.symbols.add('src/user.ts', 'User', 'class:User:new', 'Class');
    const restored = restoreSemanticModelRegistrations(model.snapshotRegistrations());
    expect(restored.types.lookupClassByName('User').map((def) => def.nodeId)).toEqual([
      'class:User:new',
    ]);
    expect(restored.methods.lookupMethodByName('save')).toEqual([]);
    expect(restored.methods.hasFunctionMethods).toBe(false);
    expect(restored.fields.lookupFieldByOwner('class:User', 'id')).toBeUndefined();
    expect(restored.symbols.lookupExact('src/user.ts', 'save')).toBe('method:save');
    expect(restored.symbols.lookupExactAll('src/user.ts', 'User')).toHaveLength(2);
  });

  it('resets the capture on full clear and accepts later registrations', () => {
    const model = createSemanticModel({ captureRegistrations: true });
    model.symbols.add('old.ts', 'Old', 'class:Old', 'Class');
    model.clear();
    expect(model.snapshotRegistrations()).toEqual({ version: 1, events: [] });
    model.symbols.add('new.ts', 'New', 'class:New', 'Class');
    const restored = restoreSemanticModelRegistrations(model.snapshotRegistrations());
    expect([...restored.symbols.getFiles()]).toEqual(['new.ts']);
    expect(restored.types.lookupClassByName('Old')).toEqual([]);
    expect(restored.types.lookupClassByName('New')).toHaveLength(1);
  });

  it('isolates registration-time metadata from caller, export and restore mutations', () => {
    const model = createSemanticModel({ captureRegistrations: true });
    const parameterTypes = ['string'];
    model.symbols.add('src/user.ts', 'save', 'method:save', 'Method', {
      ownerId: 'class:User',
      parameterTypes,
    });
    parameterTypes[0] = 'caller mutation';
    const exported = model.snapshotRegistrations()!;
    const restored = restoreSemanticModelRegistrations(exported);
    const event = exported.events[0];
    if (event.kind !== 'symbol.add') throw new Error('expected symbol registration');
    event.metadata!.parameterTypes![0] = 'export mutation';
    const secondRestore = restoreSemanticModelRegistrations(model.snapshotRegistrations());
    expect(restored.methods.lookupMethodByOwner('class:User', 'save')?.parameterTypes).toEqual([
      'string',
    ]);
    expect(secondRestore.methods.lookupMethodByOwner('class:User', 'save')?.parameterTypes).toEqual(
      ['string'],
    );
    restored.methods.lookupMethodByOwner('class:User', 'save')!.parameterTypes![0] =
      'restored mutation';
    expect(secondRestore.methods.lookupMethodByOwner('class:User', 'save')?.parameterTypes).toEqual(
      ['string'],
    );
  });

  it.each([
    null,
    { version: 2, events: [] },
    { version: 1, events: 'not an array' },
    { version: 1, events: [{ kind: 'unknown' }] },
    { version: 1, events: [{ ...symbolEvent, filePath: 42 }] },
    { version: 1, events: [{ ...symbolEvent, type: 'UnknownLabel' }] },
    { version: 1, events: [{ ...symbolEvent, metadata: { parameterCount: -1 } }] },
    { version: 1, events: [{ ...symbolEvent, metadata: { parameterCount: 0.5 } }] },
    { version: 1, events: [{ ...symbolEvent, metadata: { parameterTypes: [42] } }] },
    { version: 1, events: [{ kind: 'type.clear', extra: true }] },
    {
      version: 1,
      events: [symbolEvent, { kind: 'method.register', ownerNodeId: 'x', name: 'bad', def: {} }],
    },
  ])('rejects malformed snapshots before returning a model (%j)', (input) => {
    expect(() => restoreSemanticModelRegistrations(input)).toThrow();
  });

  it('rejects exotic objects and accessors without invoking getters', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'version', {
      enumerable: true,
      get() {
        getterCalls++;
        return 1;
      },
    });
    expect(() => restoreSemanticModelRegistrations(accessor)).toThrow();
    expect(() => restoreSemanticModelRegistrations({ version: 1, events: [new Date()] })).toThrow();
    expect(getterCalls).toBe(0);
  });

  it('checks UTF-8 event bytes and leaves a rejected capture unapplied', () => {
    const model = createSemanticModel({ captureRegistrations: true });
    const name = 'é'.repeat(140_000);
    expect(() => model.symbols.add('large.ts', name, 'large', 'Class')).toThrow();
    expect(model.symbols.lookupExact('large.ts', name)).toBeUndefined();
    expect(model.types.lookupClassByName(name)).toEqual([]);
    expect(model.snapshotRegistrations()).toEqual({ version: 1, events: [] });
    expect(() =>
      restoreSemanticModelRegistrations({ version: 1, events: [{ ...symbolEvent, name }] }),
    ).toThrow();
  });

  it('accepts the event-count limit and rejects the next event', () => {
    const events = Array.from({ length: 100_000 }, () => ({ kind: 'type.clear' }));
    expect(() => restoreSemanticModelRegistrations({ version: 1, events })).not.toThrow();
    events.push({ kind: 'type.clear' });
    expect(() => restoreSemanticModelRegistrations({ version: 1, events })).toThrow();
  }, 15_000);

  it('accepts exact serialized event and aggregate byte limits and rejects one byte more', () => {
    const maxEvent = 256 * 1024;
    const maxTotal = 64 * 1024 * 1024;
    const eventOfSize = (size: number) => {
      const base = { ...symbolEvent, name: '' };
      return { ...base, name: 'x'.repeat(size - Buffer.byteLength(JSON.stringify(base))) };
    };
    const event = eventOfSize(maxEvent);
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(maxEvent);
    expect(() => restoreSemanticModelRegistrations({ version: 1, events: [event] })).not.toThrow();
    expect(() =>
      restoreSemanticModelRegistrations({ version: 1, events: [eventOfSize(maxEvent + 1)] }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SEMANTIC_MODEL_REGISTRATIONS' }));
    const envelope = Buffer.byteLength(JSON.stringify({ version: 1, events: [] }));
    const events = Array.from({ length: 255 }, () => event);
    const remainder = maxTotal - envelope - 255 * maxEvent - 255;
    events.push(eventOfSize(remainder));
    expect(() => restoreSemanticModelRegistrations({ version: 1, events })).not.toThrow();
    events[255] = eventOfSize(remainder + 1);
    expect(() => restoreSemanticModelRegistrations({ version: 1, events })).toThrow(
      expect.objectContaining({ code: 'INVALID_SEMANTIC_MODEL_REGISTRATIONS' }),
    );
  }, 15_000);

  it('rejects a snapshot whose individually valid events exceed the aggregate byte limit', () => {
    const largeEvent = { ...symbolEvent, name: 'x'.repeat(256 * 1024 - 256) };
    expect(() =>
      restoreSemanticModelRegistrations({ version: 1, events: [largeEvent] }),
    ).not.toThrow();
    const events = Array.from({ length: 257 }, () => largeEvent);
    expect(() => restoreSemanticModelRegistrations({ version: 1, events })).toThrow();
  }, 15_000);
});
