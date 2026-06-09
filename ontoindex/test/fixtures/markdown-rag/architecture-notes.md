---
title: Markdown RAG Foundation
aliases:
  - Sidecar docs
tags: [rag, docs]
---

# Overview

OntoIndex keeps Markdown evidence passive. See [Pipeline](./pipeline.md#stages) and [ADR-001][adr-one].

The producer mentions `runAnalyze` and `src/core/ingestion/index.ts`.

## Details

| Column | Meaning                  |
| ------ | ------------------------ |
| chunk  | stable document evidence |
| link   | passive citation         |

- Parse sections
  - Preserve nested list spans
  - Keep `ambiguousSymbol` as metadata

```ts
function sample() {
  return 'code fences are content';
}
```

## Details

Repeated heading text should receive a unique anchor.

This line mentions `missingSymbol`, `oldSymbol`, and `lowConfidenceSymbol`.

See [local heading](#overview).

[adr-one]: ../adr/001-markdown-rag.md
