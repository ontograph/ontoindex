---
name: ontoindex-exploring
description: Navigate unfamiliar code using OntoIndex knowledge graph
---

# Exploring Codebases with OntoIndex

## When to Use
- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Workflow

```
1. READ ontoindex://repos                          → Discover indexed repos
2. READ ontoindex://repo/{name}/context             → Codebase overview, check staleness
3. ontoindex_query({query: "<what you want to understand>"})  → Find related execution flows
4. ontoindex_context({name: "<symbol>"})            → Deep dive on specific symbol
5. READ ontoindex://repo/{name}/process/{name}      → Trace full execution flow
```

> If step 2 says "Index is stale" → run `npx ontoindex analyze` in terminal.

## Checklist

```
- [ ] READ ontoindex://repo/{name}/context
- [ ] ontoindex_query for the concept you want to understand
- [ ] Review returned processes (execution flows)
- [ ] ontoindex_context on key symbols for callers/callees
- [ ] READ process resource for full execution traces
- [ ] Read source files for implementation details
```

## Resources

| Resource | What you get |
|----------|-------------|
| `ontoindex://repo/{name}/context` | Stats, staleness warning (~150 tokens) |
| `ontoindex://repo/{name}/clusters` | All functional areas with cohesion scores (~300 tokens) |
| `ontoindex://repo/{name}/cluster/{name}` | Area members with file paths (~500 tokens) |
| `ontoindex://repo/{name}/process/{name}` | Step-by-step execution trace (~200 tokens) |

## Tools

**ontoindex_query** — find execution flows related to a concept:
```
ontoindex_query({query: "payment processing"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**ontoindex_context** — 360-degree view of a symbol:
```
ontoindex_context({name: "validateUser"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

## Example: "How does payment processing work?"

```
1. READ ontoindex://repo/my-app/context       → 918 symbols, 45 processes
2. ontoindex_query({query: "payment processing"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
3. ontoindex_context({name: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
4. Read src/payments/processor.ts for implementation details
```
