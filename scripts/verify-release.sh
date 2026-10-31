#!/usr/bin/env bash
# Run the release test gate and stamp the staged tree that passed.
# The commit-msg hook refuses a version-bump commit whose staged tree
# does not match this stamp. Stage the complete release first.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
if ! git diff --quiet; then
  echo "verify-release: unstaged changes present; stage the complete release first." >&2
  exit 1
fi
TREE="$(git write-tree)"
(cd ontoindex && npm run build && npm run test:unit && npm run test:integration)
echo "$TREE" > "$(git rev-parse --git-path ontoindex-release-verified)"
echo "verify-release: tests passed for staged tree $TREE"
