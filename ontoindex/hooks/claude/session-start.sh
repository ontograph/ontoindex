#!/bin/bash
# OntoIndex SessionStart hook for Claude Code
# Fires on session startup. Stdout is injected into Claude's context.
# Checks if the current directory has a OntoIndex index.

dir="$PWD"
found=false
for i in 1 2 3 4 5; do
  if [ -d "$dir/.ontoindex" ]; then
    found=true
    break
  fi
  parent="$(dirname "$dir")"
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done

if [ "$found" = false ]; then
  exit 0
fi

# Inject OntoIndex context — this stdout goes directly into Claude's context
cat << 'EOF'
## OntoIndex Code Intelligence

This codebase is indexed by OntoIndex, providing execution flows, relationships, and semantic search.

**Quick Start:** Call `manage({action:'ensure_fresh', repo, autoAnalyze:false})`, then `search({action:'semantic', repo, query})` for relevant code, `inspect({action:'context', repo, target})` for symbol context, and `impact({action:'symbol', repo, target, direction:'upstream'})` before edits. Use `audit({action: "verify_diff", repo, scope:'all', changedFiles, expectedFiles})` to verify changes and `discover({action:'repos'})` to find indexed repositories.

If the index is stale, report it to the single coordinating session; sub-agents must never reindex.

**Resources:** `ontoindex://repos`, `ontoindex://repo/{name}/context`, `ontoindex://repo/{name}/processes`, `ontoindex://repo/{name}/schema`
EOF

exit 0
