---
name: ontoindex-pr-review
description: "Use when the user wants to review a pull request, understand what a PR changes, assess risk of merging, or check for missing test coverage. Examples: \"Review this PR\", \"What does PR #42 change?\", \"Is this PR safe to merge?\""
---

# PR Review with OntoIndex

## When to Use

- "Review this PR"
- "What does PR #42 change?"
- "Is this safe to merge?"
- "What's the blast radius of this PR?"
- "Are there missing tests for this PR?"
- Reviewing someone else's code changes before merge

## Workflow

```
1. gh pr diff <number>                                    → Get the raw diff
2. gn_ensure_fresh({repo})                                → Check freshness first
3. gn_review_diff({repo}) / gn_verify_diff({repo, scope: "all"})  → Map diff to affected flows
4. For each changed symbol:
   impact({action: "symbol", repo, target: "<symbol>", direction: "upstream"})  → Blast radius
5. inspect({action: "context", repo, target: "<key symbol>"})  → Understand callers/callees
6. Summarize findings with risk assessment
```

> If freshness reports stale, refresh with `ontoindex analyze` under the
> single-owner rules in `ontoindex-cli` before reviewing.

Uncommitted or unindexed PR code is not in the graph. Verify those changes
against the diff or current source.

## Checklist

```
- [ ] Fetch PR diff (gh pr diff or git diff base...head)
- [ ] gn_ensure_fresh({repo}) and record freshness
- [ ] gn_verify_diff to map changes to affected execution flows
- [ ] impact({action: "symbol"}) on each non-trivial changed symbol
- [ ] Review d=1 items — are callers updated for the actual behavior change?
- [ ] inspect({action: "context"}) on key changed symbols
- [ ] Check if affected processes have test coverage
- [ ] Assess overall risk level
- [ ] Write review summary with findings
```

## Review Dimensions

| Dimension | How OntoIndex Helps |
| --- | --- |
| **Correctness** | `context` shows callers — are they all compatible with the change? |
| **Blast radius** | `impact` shows d=1/d=2/d=3 dependents — anything missed? |
| **Completeness** | `detect_changes` shows all affected flows — are they all handled? |
| **Test coverage** | `impact({includeTests: true})` shows which tests touch changed code |
| **Breaking changes** | d=1 upstream items that aren't updated in the PR = potential breakage |

## Risk Assessment

| Signal | Risk |
| --- | --- |
| Changes touch <3 symbols, 0-1 processes | LOW |
| Changes touch 3-10 symbols, 2-5 processes | MEDIUM |
| Changes touch >10 symbols or many processes | HIGH |
| Changes touch auth, payments, or data integrity code | CRITICAL |
| d=1 callers exist outside the PR diff | Potential breakage — flag it |

## Tools

**gn_verify_diff** — map PR diff to affected execution flows (`gn_review_diff`
and `gn_diff_impact` give review-shaped variants):

```
gn_verify_diff({repo: "<repo>", scope: "all"})

→ Changed: 8 symbols in 4 files
→ Affected processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Risk: MEDIUM
```

**impact** — blast radius per changed symbol:

```
impact({action: "symbol", repo: "<repo>", target: "validatePayment", direction: "upstream"})

→ d=1 (INSPECT EACH):
  - processCheckout (src/checkout.ts:42) [CALLS, 100%]
  - webhookHandler (src/webhooks.ts:15) [CALLS, 100%]

→ d=2 (LIKELY AFFECTED):
  - checkoutRouter (src/routes/checkout.ts:22) [CALLS, 95%]
```

**gn_test_gap / gn_test_suggestions** — check test coverage for the change:

```
gn_test_gap({repo: "<repo>"})

→ Tests that cover this symbol:
  - validatePayment.test.ts [direct]
  - checkout.integration.test.ts [via processCheckout]
```

**inspect** — understand a changed symbol's role:

```
inspect({action: "context", repo: "<repo>", target: "validatePayment"})

→ Incoming calls: processCheckout, webhookHandler
→ Outgoing calls: verifyCard, fetchRates
→ Processes: CheckoutFlow (step 3/7), RefundFlow (step 1/5)
```

## Example: "Review PR #42"

```
1. gh pr diff 42 > /tmp/pr42.diff
   → 4 files changed: payments.ts, checkout.ts, types.ts, utils.ts

2. gn_verify_diff({repo: "my-app", scope: "all"})
   → Changed symbols: validatePayment, PaymentInput, formatAmount
   → Affected processes: CheckoutFlow, RefundFlow
   → Risk: MEDIUM

3. impact({action: "symbol", repo: "my-app", target: "validatePayment", direction: "upstream"})
   → d=1: processCheckout, webhookHandler (inspect both)
   → webhookHandler is NOT in the PR diff — potential breakage!

4. impact({action: "symbol", repo: "my-app", target: "PaymentInput", direction: "upstream"})
   → d=1: validatePayment (in PR), createPayment (NOT in PR)
   → createPayment uses the old PaymentInput shape — breaking change!

5. inspect({action: "context", repo: "my-app", target: "formatAmount"})
   → Called by 12 functions — but change is backwards-compatible (added optional param)

6. Review summary:
   - MEDIUM risk — 3 changed symbols affect 2 execution flows
   - BUG: webhookHandler calls validatePayment but isn't updated for new signature
   - BUG: createPayment depends on PaymentInput type which changed
   - OK: formatAmount change is backwards-compatible
   - Tests: checkout.test.ts covers processCheckout path, but no webhook test
```

## Review Output Format

Structure your review as:

```markdown
## PR Review: <title>

**Risk: LOW / MEDIUM / HIGH / CRITICAL**

### Changes Summary
- <N> symbols changed across <M> files
- <P> execution flows affected

### Findings
1. **[severity]** Description of finding
   - Evidence from OntoIndex tools
   - Affected callers/flows

### Missing Coverage
- Callers not updated in PR: ...
- Untested flows: ...

### Recommendation
APPROVE / REQUEST CHANGES / NEEDS DISCUSSION
```
