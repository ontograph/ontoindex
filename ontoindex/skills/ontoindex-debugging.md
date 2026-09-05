---
name: ontoindex-debugging
description: "Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: \"Why is X failing?\", \"Where does this error come from?\", \"Trace this bug\""
---

# Debugging with OntoIndex

## When to Use

- "Why is this function failing?"
- "Trace where this error comes from"
- "Who calls this method?"
- "This endpoint returns 500"
- Investigating bugs, errors, or unexpected behavior

## Workflow

```
1. gn_ensure_fresh({repo})                                   → Check freshness first
2. search({action: "semantic", repo, query: "<symptom>"})    → Find related execution flows
3. inspect({action: "context", repo, target: "<suspect>"})   → See callers/callees/processes
4. gn_diagnose({repo}) / gn_error_topology({repo})           → Failure-path evidence
5. Read source files to confirm the root cause
```

> If freshness reports stale, refresh with `ontoindex analyze` under the
> single-owner rules in `ontoindex-cli`.

A dirty worktree is not represented in the graph. Confirm any suspect code
against current source before concluding a root cause. If OntoIndex is required
but not callable, report the missing tool instead of substituting grep.

## Checklist

```
- [ ] Understand the symptom (error message, unexpected behavior)
- [ ] gn_ensure_fresh({repo}) and record freshness
- [ ] search({action: "semantic"}) for error text or related code
- [ ] Identify the suspect function from returned processes
- [ ] inspect({action: "context"}) to see callers and callees
- [ ] Read source files to confirm root cause
```

## Debugging Patterns

| Symptom              | OntoIndex Approach                                          |
| -------------------- | ---------------------------------------------------------- |
| Error message        | `search` for error text → `inspect` on throw sites          |
| Wrong return value   | `inspect` on the function → trace callees for data flow     |
| Intermittent failure | `inspect` → look for external calls, async deps             |
| Performance issue    | `inspect` → find symbols with many callers (hot paths)      |
| Recent regression    | `gn_verify_diff` to see what your changes affect            |

## Tools

**search** — find code related to error:

```
search({action: "semantic", repo: "<repo>", query: "payment validation error"})
→ Processes: CheckoutFlow, ErrorHandling
→ Symbols: validatePayment, handlePaymentError, PaymentException
```

**inspect** — full context for a suspect:

```
inspect({action: "context", repo: "<repo>", target: "validatePayment"})
→ Incoming calls: processCheckout, webhookHandler
→ Outgoing calls: verifyCard, fetchRates (external API!)
→ Processes: CheckoutFlow (step 3/7)
```

**gn_graph_walk / gn_trace_boundary** — custom call chain and boundary traces
when `search` and `inspect` do not isolate the path.

## Example: "Payment endpoint returns 500 intermittently"

```
1. search({action: "semantic", repo: "my-app", query: "payment error handling"})
   → Processes: CheckoutFlow, ErrorHandling
   → Symbols: validatePayment, handlePaymentError

2. inspect({action: "context", repo: "my-app", target: "validatePayment"})
   → Outgoing calls: verifyCard, fetchRates (external API!)

3. Read the fetchRates source to confirm the timeout behavior

4. Root cause: fetchRates calls external API without proper timeout
```
