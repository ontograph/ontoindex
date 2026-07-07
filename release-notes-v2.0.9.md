# OntoIndex v2.0.9

## Highlights
- **Release Blockers Cleared**: fixed the `prefer-const` regression in `ontoindex setup` so the stable publish branch no longer fails lint on the hook-install path.
- **Windows Path Matching Repaired**: target-context and `gn_diagnose` now treat repo-path casing as equivalent on Windows-style paths, avoiding false mismatch warnings and confidence drops.
- **MCP Doctor Output Normalized**: setup-health diagnostics now print stale config paths with forward slashes, keeping the output stable across platforms and easier to read in issue reports.
