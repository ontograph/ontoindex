# MCP review follow-ups 2.2.28 (2026-10-14)

Source: read-only review of installed 2.2.27 (four reviewers, gpt-6.1-sol and gpt-6-luna).

Fixed in 2.2.28: arg-limit total/array caps (regression from 2.2.27), `ONTOINDEX_ALLOWED_HOSTS` for proxies and trailing-dot localhost, doctor ambiguous verdict and embedding prerequisite details, setup skill ownership marker and safe legacy cleanup.

Notes: setup tests that expect the packaged CLI path fail in a worktree without `dist`; they pass after a build.

Still open: embeddings are never generated unless `analyze --embeddings` runs (needs ONTOINDEX_EMBEDDING_URL and _MODEL, plus _MODEL_HASH for managed repair); `isManagedClone` and `cloneFresh` are missing from the index at 7b1494c (cause unconfirmed); failed native opens stay pooled; `.retention-managed` marker ordering; custom page maxBytes can throw; `clean --generations --force`, release 2.2.24+, config edits (remove `ONTOINDEX_MCP_REPO`) await the user.
