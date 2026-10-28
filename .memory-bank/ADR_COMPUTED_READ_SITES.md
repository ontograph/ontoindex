# Explicit computed-read sites

## Status

Accepted for bounded implementation, 2026-10-27, under the user-authorized
computed selected-value follow-up. Target inference remains unsupported.

## Decision and alternatives

Keep the existing ordered referenceSites collection. ReferenceSite becomes a
union of NamedReferenceSite and ComputedReadSite. Named sites retain their wire
shape. Computed sites have kind read, atRange, inScope and selection containing
kind computed, objectRange and indexRange. They carry no name, callForm, arity or
explicitReceiver. Optional never fields permit inspection while preventing a
mixed typed object. The resolver recognizes computed selection before ordinary
read classification, increments unsupportedSites and emits no target edge.
Object/index operands remain independent named sites in traversal order.

Compared this union, a separate computed collection and a sentinel name.
The collection duplicates extraction/finalization/persistence plumbing; sentinel
names permit false lexical lookup. The union is selected for correctness and
compatibility with the current ordered owner, constant additional work per site,
bounded range-only payloads, focused tests and straightforward rollback.
Second challenge rejects receiver-only index steps: standalone computed values
have no lexical name. It also rejects calling an unsupported selection unresolved
or fully resolved. No target inference or computed receiver/callee/write support
is implied. Literal keys use the same explicit unsupported selection for now.

## Capture and strict boundary

Reuse CaptureMatch with an empty-text @reference.read.computed anchor covering
the expression and empty-text @reference.object/@reference.index range subtags.
Extract only exact three-capture matches; names, receiver and arity conflicts
fail closed. Computed subtags route to that validator before topic selection,
so an unrelated topic cannot hide malformed metadata. Coordinates must be safe integers, lines positive, columns
nonnegative, ranges nonempty, ordered and contained in the expression. Object
precedes index, with bracket space between them and after the index. Ranges are
detached copies, never AST nodes or expression-text names.

The strict parsed-file encoder selects the computed reference schema through
an own enumerable data selection property. It rejects accessors/proxies,
mixed named/computed fields, hidden or symbol extras on computed records,
invalid tags/kinds and invalid computed ranges.
Existing byte/work/depth limits stay authoritative. Decoder validation continues
through that encoder. Legacy named records remain readable under envelope1;
old readers reject new computed records rather than discard facts. Worker
protocol framing remains2 because its transport structure is unchanged.
Runtime parser identity hashes compiled runtime/shared code: regenerated artifacts
invalidate previous retained candidates. Compatibility tests cover legacy decode,
exact detached computed round-trip, malformed variants and no lexical target.

## Owners, acceptance and rollback

Shared reference-site and index exports own the union. Existing TS/JS capture,
scope extractor, resolver, call publication and parse-scope codec owners consume
it. Finalization forwards the same collection. Capture/extractor tests establish
range/scope/order and atomic refusal; codec tests cover strict compatibility;
resolution tests require unsupported accounting and no selected-target edge;
replay tests require exact selected-site preservation.

Revert the coordinated source changes and rebuild to roll back. Regenerate
computed-containing retained artifacts under the older runtime; never strip
selection facts or relabel them as named references. No public MCP fields,
lookup caches, dependencies or second collection are introduced.
