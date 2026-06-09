---
name: ontoindex-debugging
description: Trace bugs through call chains using knowledge graph
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
1. ontoindex_query({query: "<error or symptom>"})            → Find related execution flows
2. ontoindex_context({name: "<suspect>"})                    → See callers/callees/processes
3. READ ontoindex://repo/{name}/process/{name}                → Trace execution flow
4. ontoindex_cypher({query: "MATCH path..."})                 → Custom traces if needed
```

> If "Index is stale" → run `npx ontoindex analyze` in terminal.

## Checklist

```
- [ ] Understand the symptom (error message, unexpected behavior)
- [ ] ontoindex_query for error text or related code
- [ ] Identify the suspect function from returned processes
- [ ] ontoindex_context to see callers and callees
- [ ] Trace execution flow via process resource if applicable
- [ ] ontoindex_cypher for custom call chain traces if needed
- [ ] Read source files to confirm root cause
```

## Debugging Patterns

| Symptom | OntoIndex Approach |
|---------|-------------------|
| Error message | `ontoindex_query` for error text → `context` on throw sites |
| Wrong return value | `context` on the function → trace callees for data flow |
| Intermittent failure | `context` → look for external calls, async deps |
| Performance issue | `context` → find symbols with many callers (hot paths) |
| Recent regression | `detect_changes` to see what your changes affect |

## Tools

**ontoindex_query** — find code related to error:
```
ontoindex_query({query: "payment validation error"})
→ Processes: CheckoutFlow, ErrorHandling
→ Symbols: validatePayment, handlePaymentError, PaymentException
```

**ontoindex_context** — full context for a suspect:
```
ontoindex_context({name: "validatePayment"})
→ Incoming calls: processCheckout, webhookHandler
→ Outgoing calls: verifyCard, fetchRates (external API!)
→ Processes: CheckoutFlow (step 3/7)
```

**ontoindex_cypher** — custom call chain traces:
```cypher
MATCH path = (a)-[:CodeRelation {type: 'CALLS'}*1..2]->(b:Function {name: "validatePayment"})
RETURN [n IN nodes(path) | n.name] AS chain
```

## Example: "Payment endpoint returns 500 intermittently"

```
1. ontoindex_query({query: "payment error handling"})
   → Processes: CheckoutFlow, ErrorHandling
   → Symbols: validatePayment, handlePaymentError

2. ontoindex_context({name: "validatePayment"})
   → Outgoing calls: verifyCard, fetchRates (external API!)

3. READ ontoindex://repo/my-app/process/CheckoutFlow
   → Step 3: validatePayment → calls fetchRates (external)

4. Root cause: fetchRates calls external API without proper timeout
```
