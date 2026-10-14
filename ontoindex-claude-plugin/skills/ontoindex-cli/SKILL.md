---
name: ontoindex-cli
description: 'Use when the user needs to operate the OntoIndex CLI to index, inspect, clean, or document a repository.'
---

Read ontoindex-navigation first.

# OntoIndex CLI Commands

Run the installed `ontoindex` command from the target repository. Only the coordinating session runs `ontoindex analyze`; sub-agents never analyze. Never launch analyze through npx; npx can fetch a different version.

`analyze` indexes the repository and updates the OntoIndex block in `AGENTS.md` and `CLAUDE.md`. Use `--skip-agents-md` to leave those files untouched. The index is commit-based, so a dirty tree needs direct source checks. Embeddings are optional and off by default.

| Command                                                                | Purpose                                                                                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ontoindex analyze [path]`                                             | Build or refresh the index; `--force` reindexes, `--embeddings` enables embeddings.                                                |
| `ontoindex status [--repo <repo>]`                                     | Show index status for the current or selected repository.                                                                          |
| `ontoindex list`                                                       | List registered indexed repositories.                                                                                              |
| `ontoindex mcp-doctor [--repo <repo>] [--project-cwd <path>] [--json]` | Check MCP repository targeting and print repair guidance.                                                                          |
| `ontoindex clean`                                                      | Show confirmation before deleting the current repository index.                                                                    |
| `ontoindex clean --generations [--keep <n>]`                           | Preview obsolete generation cleanup; `--keep` retains 0–10 non-active generations (default 2). Add `--force` to delete candidates. |
| `ontoindex clean --all --force`                                        | Delete indexes for every registered repository. This is destructive; ask the user before running it.                               |
| `ontoindex wiki [path]`                                                | Generate repository documentation with an external LLM. Run only on explicit user request.                                         |

`wiki` can publish a public GitHub Gist with `--gist`. Prefer `ONTOINDEX_API_KEY` or `OPENAI_API_KEY` from the environment; avoid putting secrets on the command line. The CLI also accepts `--api-key <key>` and saves it in `~/.ontoindex/config.json`.
