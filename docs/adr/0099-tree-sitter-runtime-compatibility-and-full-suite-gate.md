# ADR 0099: Tree-sitter Runtime Compatibility and Full-suite Gate

Status: Implemented - pending release
Date: 2026-06-20
Source: Full `npm test` failure during ADR 0098 validation

## Context

Focused ADR 0098 tests, typecheck, and build pass, but the full core test suite currently fails
before it can validate real behavior. The dominant failure is:

```text
Cannot set property type of [object Object] which has only a getter
```

The stack points at the vendored tree-sitter runtime initialization in
`ontoindex/vendor/tree-sitter/index.js`, where language node subclasses assign metadata directly to
`nodeSubclass.prototype.type`. On the current runtime, `SyntaxNode` exposes `type` as a getter-only
property, so direct assignment throws during grammar initialization. Parser-dependent tests then
return empty extraction results or fail before assertions.

## Architecture Fit Gate

### Real New Functionality

Passes. This adds a runtime compatibility guard that lets OntoIndex load grammars and run parser
tests reliably on the supported Node/tree-sitter line. It is not a rename, wrapper, or new parser
surface.

### Core Extension

Passes. The fix extends the existing vendored tree-sitter runtime and parser-loader validation path.
It does not introduce a new parser engine, grammar registry, or language abstraction.

## Decision

Patch the existing vendored tree-sitter runtime so generated node subclass metadata is installed
with descriptor-safe definitions instead of direct assignment to getter-only inherited properties.

Approved scope:

1. replace direct prototype assignment for subclass metadata with `Object.defineProperty`;
2. add focused regression coverage that loads a real grammar and proves parser initialization does
   not throw;
3. keep the fix inside the existing vendored runtime or its patch step so published installs and
   source checkouts behave the same;
4. keep full-suite validation meaningful by making parser initialization failures explicit and
   early.

Not approved:

- upgrading all grammars to a new ABI in this ADR;
- adding a second parser implementation;
- dropping language support to avoid the failure;
- changing public extraction output shapes;
- treating full-suite parser failures as acceptable because focused tests pass.

## Algorithm / Technique

1. In `ontoindex/vendor/tree-sitter/index.js`, replace:

   ```js
   nodeSubclass.prototype.type = typeName;
   nodeSubclass.prototype.fields = Object.freeze(fieldNames.sort());
   ```

   with descriptor-safe definitions:

   ```js
   Object.defineProperty(nodeSubclass.prototype, 'type', {
     value: typeName,
     configurable: true,
   });
   Object.defineProperty(nodeSubclass.prototype, 'fields', {
     value: Object.freeze(fieldNames.sort()),
     configurable: true,
   });
   ```

2. If the repository has an install-time patch script for vendored tree-sitter, update that script
   too so `npm install` cannot regenerate the broken assignment.
3. Add a focused unit test that imports the parser loader, loads at least one real grammar, parses a
   tiny source file, and asserts syntax node access works without throwing.
4. Run the parser-focused test before the broader suite so native/runtime failures fail fast with a
   clear signature.

## Acceptance

- a focused tree-sitter/parser-loader test fails before the patch and passes after it;
- `npm run build` and `npx tsc --noEmit` pass;
- the broad test suite no longer fails at grammar initialization with the getter-only `type` error;
- no public CLI, MCP, graph schema, or extraction contract changes are introduced.

## Operational Notes

This ADR is separate from the longer tree-sitter 0.25/Node 25 readiness work. It is a narrow
compatibility fix for the currently supported runtime so other feature validation is not hidden
behind a test-harness crash.
