# MCP boundary inputs and bounded memory acquisition

Status: Accepted

The approved repair extends the existing MCP adapters and memory parser.

Boundary tracing accepts bounded, validated caller facts and normalizes the
advertised mechanism alias (`exec` means `exec-close-on-exec`). Conflicting
aliases fail closed. Source text alone produces an unresolved report because
the existing tracer consumes resource identity facts. Process endpoints and
resource instance identifiers are described explicitly in the schema.

Audit logic path reads use the repository root selected by the server or facade and
the existing containment helper. Direct callers resolve their repository using
the existing target context. Explicit inline source, including an empty string,
takes precedence over path reads.

Memory enumeration validates directory containment before opening the directory.
Acquisition caps are 1024 directory entries, 128 selected files, 1 MiB aggregate
read bytes, and 64 KiB plus one overflow byte per file. Directory overflow has
unknown total and emits no arbitrary prefix. Complete discovery establishes an
exact total before alphabetical file selection. Partial collections expose
warnings and coverage; the compatibility array API throws on limit truncation.
Metadata consumers omit retained bodies. Onboarding reads its preferred file
directly and uses alphabetical fallback only after complete discovery.

Containment uses existing canonical path checks and regular-file validation;
it does not provide descriptor-relative protection against concurrent path swaps.
Regression checks cover aliases, selected roots, containment, acquisition limits,
partial metadata, and onboarding preference. Rollback restores each adapter and
its schema or callers together.
