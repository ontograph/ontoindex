---
name: ontoindex-guide
description: 'Consult for OntoIndex tool families, resource URIs, graph schema, and bounded Cypher reference.'
---

# OntoIndex Reference

Read [ontoindex-navigation](ontoindex-navigation.md) first; then choose the exploring, debugging, impact-analysis, pr-review, refactoring, or cli recipe skill for the task.
Pass `repo: '<repo>'` in every tool call.

| Family              | Tools and actions                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery           | `discover`: repos, routes, tools, packs, groups, sync, help, tool_contract; `manage({action: "diagnose", ...})`                                                                                         |
| Retrieval           | `search`: semantic, cypher, repomap; `inspect({action: "explore", ...})`, `inspect({action: "module", ...})`                                                                                         |
| Context             | `inspect`: context, evidence, shape, ipc; `inspect({action: "related", ...})`                                                                                                                        |
| Edit safety         | `impact`: symbol, batch, route, diff; `audit({action: "safe_edit_check", ...})`, `audit({action: "can_delete", ...})`                                                                                |
| Verification        | `audit({action: "verify_diff", ...})`, `audit({action: "review_diff", ...})`, `impact({action: "diff_impact", ...})`, `audit({action: "test_gap", ...})`, `audit({action: "pre_commit_audit", ...})` |
| Index lifecycle     | `manage({action: "ensure_fresh", ...})`, `manage({action: "analyze_job", jobId, job_action: "status", ...})` (coordinate refresh through navigation)                                                     |
| Audits/docs         | `audit`, `docs`                                                                                                                                                                                      |
| Session/refactoring | `manage`; `refactor`: rename (preview only), replace, sandbox                                                                                                                                        |

Resources: `ontoindex://repos`; `ontoindex://repo/{name}/context`, `/schema`, `/processes`, `/clusters`, and `/process/{processName}` (append each suffix to the repository URI).

Nodes include File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process, and language-specific types such as Struct, Enum, Property, and Constructor.
Symbols expose `name`, `filePath`, `startLine`, and `endLine`; consult the schema resource for type-specific properties.
All edges use the `CodeRelation` table with a `type` property (and confidence, reason, step).
Edge types include CONTAINS, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES, METHOD_OVERRIDES, METHOD_IMPLEMENTS, MEMBER_OF, and STEP_IN_PROCESS.

Use a bounded query (LIMIT must be at most 5000):

```javascript
search({
  repo: '<repo>',
  action: 'cypher',
  query:
    "MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: '<symbol>'}) RETURN caller.name, caller.filePath LIMIT 20",
});
```

Avoid variable-length Cypher patterns; use `impact` with `maxDepth` for traversal.
