# OntoIndex Agent Hooks

This directory contains hooks that integrate OntoIndex with various AI agents (e.g., Claude Code).

## Claude Code Hook

The \`ontoindex-hook.cjs\` script intercepts agent tool use events:

- **PreToolUse**:
  - Augments Grep/Glob/Bash searches with graph context from the OntoIndex index.
  - **Check phase**: If \`features.check=true\` is set in \`.ontoindex/config.json\`, it executes \`npx ontoindex check\`. If this check fails, the hook propagates the non-zero exit code to block the agent's action. Note that this check runs *before* any reindex operations.
- **PostToolUse**:
  - Detects index staleness after git mutations and notifies the agent to reindex. If a \`check\` failed during PreToolUse, the reindex notification will still run on PostToolUse so the agent knows the index state.
