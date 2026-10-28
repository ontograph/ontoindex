# C++ capture validation

The C++ provider now captures a bounded function-only translation unit from its
borrowed parser tree. Admitted functions return void, have no parameters and use
empty bodies, bare returns or zero-argument calls to themselves or earlier
functions. Module, Function and Block scopes preserve lexical ownership; admitted
functions bind in the module and have explicit exports. Other syntax rejects the
whole capture. Existing warnings and legacy extraction remain active.

Parser identity includes the C++ provider, capture implementation, native grammar,
wrapper and node types. The wrapper checks native bytes around loading and exposes
immutable load identity. Existing prepared graphs require rebuilding after this
identity change. Production replay remains seedReady=false.

Identity-only work would leave capture unavailable; general C++ capture requires
separate semantics for headers, overloads, templates and linkage. The selected
narrow slice establishes end-to-end extraction and resolution without claiming
general language coverage. A second review required Block scopes, explicit exports
and legacy graph equivalence for refused files.

Parent validation on native Linux, all exit 0:

- Seven suites, 235 tests, 5.08 seconds: cpp-captures, cpp-scope-retention,
  python-grammar-identity, workspace-input-capture, python-captures,
  python-scope-retention and cpp-temporary-receiver-retention.
- Package build compiled shared/product TypeScript and copied existing native
  artifacts. No native ABI change was made.
- Scoped whitespace check and OntoIndex file-scope verify_diff passed. Symbol
  scope was not specified; the committed graph omits dirty/new source.

Four research agents and four implementation agents participated. One test agent
ran an unauthorized validation invocation despite parent-only execution
instructions and reported 116 passing tests; the independent parent run above is
the acceptance evidence. No agent process remains open.

Installed workspace-20261025-batched predates this C++ source slice. Rust capture,
broader supported syntax, generation-level production replay admission, and updated
deployment remain open. The closed structured tracker was not reopened or edited.
