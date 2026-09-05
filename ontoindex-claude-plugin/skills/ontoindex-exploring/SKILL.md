---
name: ontoindex-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \"How does X work?\", \"What calls this function?\", \"Show me the auth flow\""
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
1. gn_ensure_fresh({repo})                                   → Check freshness first
2. search({action: "semantic", repo, query: "<concept>"})    → Find related execution flows
3. inspect({action: "context", repo, target: "<symbol>"})    → Deep dive on a symbol
4. gn_explain_module({repo, module})                         → Module-level overview
5. Read source files for implementation details
```

> If freshness reports stale, refresh with `ontoindex analyze` under the
> single-owner rules in `ontoindex-cli`.

Prefer graph search over grep for discovery. If OntoIndex is required but not
callable, say so explicitly rather than presenting grep results as
graph-backed evidence.

## Checklist

```
- [ ] gn_ensure_fresh({repo}) and record freshness
- [ ] search({action: "semantic"}) for the concept
- [ ] Review returned processes (execution flows)
- [ ] inspect({action: "context"}) on key symbols for callers/callees
- [ ] Read source files for implementation details
- [ ] Verify uncommitted changes against current source, not the graph
```

## Resources

| Resource                                | What you get                                            |
| --------------------------------------- | ------------------------------------------------------- |
| `ontoindex://repo/{name}/context`        | Stats, staleness warning (~150 tokens)                  |
| `ontoindex://repo/{name}/clusters`       | All functional areas with cohesion scores (~300 tokens) |
| `ontoindex://repo/{name}/cluster/{name}` | Area members with file paths (~500 tokens)              |
| `ontoindex://repo/{name}/process/{name}` | Step-by-step execution trace (~200 tokens)              |

## Tools

**search** — find execution flows related to a concept:

```
search({action: "semantic", repo: "<repo>", query: "payment processing"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**inspect** — 360-degree view of a symbol:

```
inspect({action: "context", repo: "<repo>", target: "validateUser"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

## Example: "How does payment processing work?"

```
1. gn_ensure_fresh({repo: "my-app"})          → fresh
2. search({action: "semantic", repo: "my-app", query: "payment processing"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
3. inspect({action: "context", repo: "my-app", target: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
4. Read src/payments/processor.ts for implementation details
```
