# OntoIndex v2.0.11

## Highlights

- **Safer repository targeting:** MCP uses the active project path to resolve legacy duplicate labels and reports all candidates when it cannot choose safely.
- **Unambiguous registry writes:** repository paths are canonicalized across symlinks and new duplicate labels are rejected.
- **Clean hook context:** augmentation payloads are explicitly framed while operational diagnostics remain on stderr.
- **Reliable FTS startup:** pooled LadybugDB connections try the cached FTS extension path before the network-backed fallback.
- **Reproducible MCP smoke testing:** a Kimi K3 harness verifies repository scope, exact tool arguments, evidence, and grounded final answers.
