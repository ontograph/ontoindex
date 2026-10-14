# Runbook — OntoIndex

Short, copy-paste operations for **local development**, **MCP**, and **CI**. Commands assume a Unix shell; on Windows use Git Bash or equivalent paths.

## Prerequisites

- **Node.js** ≥ 20 (`ontoindex-web/package.json` `engines`).
- **Git** (analyze requires a git repository).
- From repo root, install and build the CLI package:

```bash
cd ontoindex
npm install
npm run build
```

Use `npx ontoindex …` from any path after global/published install, or `node dist/cli/index.js …` when developing from `ontoindex/` with a local build.

---

## Index out of date / “stale” tools

**Symptom:** MCP or resources warn the index is behind `HEAD`, or results don’t reflect recent commits.

**Multi-agent rule:** pick one coordinator to run `analyze`. Worker agents should not auto-refresh the index during integration or cherry-pick work; they should either use the existing index with explicit stale-index consent or use git-only workflows.

**Fix (from the target repo root):**

```bash
npx ontoindex analyze
```

**Force full rebuild** (same commit but suspect corruption or changed ignore rules):

```bash
npx ontoindex analyze --force
```

**Check status:**

```bash
npx ontoindex status
```

**List what MCP knows about:**

```bash
npx ontoindex list
```

---

## Embeddings

**First time with vectors** (slower, more disk/RAM):

```bash
npx ontoindex analyze --embeddings
```

**Important:** If you already had embeddings, **always** pass `--embeddings` on later analyzes, or they can be dropped. See `stats.embeddings` in `.ontoindex/meta.json` (0 means none).

**Large repos:** Analyze may skip or limit embedding work when node counts are very high; watch CLI output.

## Markdown retrieval (docs sidecar)

The Markdown sidecar chunks Markdown documents into enrichment facts; `query` can retrieve those chunks as passive context. With Markdown context enabled, chunks are ranked by BM25 over their heading path and stored excerpt (capped at 2,048 bytes or 40 lines; `ontoindex/src/core/ingestion/enrichment/markdown-sidecar-producer.ts:100-101`). Paths such as `.memory-bank/archive/`, `audit_session-*`, plans, test plans, release notes/readiness, and research reports receive a 0.5 weight, and chunks in documents linked from the best-matching chunk receive a bonus (`ontoindex/src/core/ingestion/enrichment/markdown-query-ranking.ts:37,59-70,132-155`).

**Build or refresh** after Markdown file paths or content change; status reports `stale` until the sidecar is run again:

```bash
ontoindex docs sidecar run markdown
ontoindex docs sidecar status
```

**Query** with the CLI or equivalent MCP options:

```bash
ontoindex query "<text>" --consume-enrichment-facts --include-passive-related-facts --include-markdown-context --include-markdown-ppr
```

MCP options: `consume_enrichment_facts`, `include_passive_related_facts`, `include_markdown_context`, and `include_markdown_ppr`. Results appear in `enrichment.relatedDocs`, `enrichment.relatedChunks`, and `enrichment.markdownPpr`; `enrichment.factsBound` describes the bounded `facts`. Responses include at most 5 documents and 10 chunks. Only chunks matching query terms are returned; queries with no matching words and stop-word-only queries such as “how to” return no chunks. `context` and `impact` preserve path order.

When `include_markdown_context` is set, backtick code mentions in returned chunks are resolved against the code graph per request. Chunk evidence gains `mention` (the text) and `graphResolution` (`status`: `resolved`, `ambiguous`, or `unresolved`; `targets[]` with `id`, `name`, `filePath`, and `startLine`), and the response gains `mentionResolution` (`status`: `ok`, `partial`, or `skipped`; `lookups`; optional `reason`). Resolution is limited to 40 distinct names, 3 candidates per name, and 1,500 ms total. Only identifier-like names (optionally dotted; the last segment is looked up) are tried. Ambiguous names are reported with up to 3 targets and are never auto-picked. Stored sidecar facts remain `unresolved`, ranking is unchanged, and graph failure or timeout never fails the query.

The collector reads every non-ignored `.md` and `.mdx` file, plus root `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, and `LICENSE.md`; user ignore rules still apply (`ontoindex/src/core/ingestion/enrichment/markdown-sidecar-collector.ts:12-19,23-31`). Matching is lexical and requires no embeddings. Code mentions are stored unresolved, and long sections are matched through their capped excerpt.

---

## MCP: no repos / empty tools

**Symptom:** `OntoIndex: No indexed repos yet` on stderr when starting MCP.

**Fix:** In each project you want indexed:

```bash
cd /path/to/repo
npx ontoindex analyze
```

Restart the editor MCP session if needed. The server **refreshes the registry lazily**; new analyzes are picked up without necessarily reinstalling MCP.

**Symptom:** Wrong repo when multiple are indexed — pass `repo` on tools or use `list_repos` first.

**Scope MCP to one repo** when an agent session should not see every registered index:

```bash
npx ontoindex mcp --repo MyRepo
npx ontoindex mcp --project /absolute/path/to/repo --repo /absolute/path/to/repo
```

---

## Clean slate (corrupt or huge `.ontoindex`)

**Current repo only** (prompts for confirmation):

```bash
npx ontoindex clean
```

**Skip confirmation:**

```bash
npx ontoindex clean --force
```

**All registered repos:**

```bash
npx ontoindex clean --all --force
```

Then re-run `npx ontoindex analyze` (and `--embeddings` if you need vectors).

---

## Local bridge for the web UI

```bash
cd ontoindex
npx ontoindex serve
# default http://127.0.0.1:4747 — see serve --help for port/host
```

Use when the browser UI should talk to **local** indexed repos instead of WASM-only mode.

---

## CLI equivalents of MCP tools

Useful for debugging without an editor:

```bash
cd ontoindex
npx ontoindex query "authentication flow" --repo MyRepo
npx ontoindex context SomeSymbol --repo MyRepo
npx ontoindex impact SomeSymbol --direction upstream --repo MyRepo
npx ontoindex cypher "MATCH (n) RETURN count(n) LIMIT 1" --repo MyRepo
```

---

## CI failures (contributors)

Orchestrator: `.github/workflows/ci.yml`.

| Job | Typical local repro |
|-----|---------------------|
| **quality** | `cd ontoindex && npx tsc --noEmit` |
| **unit-tests** | `cd ontoindex && npx vitest run test/unit` |
| **integration** | `cd ontoindex && npx vitest run test/integration` (see workflow matrix for groups) |
| **e2e** | Triggered when `ontoindex-web/` changes; `cd ontoindex-web && E2E=1 npx playwright test` (requires `ontoindex serve` + `npm run dev`) |

**Note:** Pushes that touch only certain markdown paths may be skipped by `paths-ignore` in CI — see workflow file for exact patterns.

---

## Memory / analyze crashes

Analyze re-execs Node with a **large old-space heap** when needed (`analyze.ts`). If you still OOM on huge repos, close other processes, avoid `--embeddings` for a first pass, or analyze a smaller path if supported by your workflow.

---

## LadybugDB / lock errors

Only one `ontoindex analyze` should rebuild a repo at a time. Analyze writes `.ontoindex/analyze.lock`; if it already exists and the PID is alive, wait for that analyze to finish instead of starting another one.

MCP opens `.ontoindex/lbug` read-only. If `.ontoindex/lbug.wal` or `.ontoindex/lbug.shadow` is present, the index needs write-mode recovery before MCP can read it safely. Stop extra MCP users and run one coordinated `npx ontoindex analyze`.

For long-running agent fleets, prefer one shared/coordinated MCP process per repo rather than letting every worker start its own MCP/index lifecycle.

---

## Where to dig deeper

- Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md)  
- Agent safety rules: [GUARDRAILS.md](GUARDRAILS.md)  
- Tests: [TESTING.md](TESTING.md)
