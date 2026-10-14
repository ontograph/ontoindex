---
name: ontoindex-guide
description: 'Consult for OntoIndex tool families, resource URIs, graph schema, and bounded Cypher reference.'
---

# OntoIndex Reference

Read [ontoindex-navigation](ontoindex-navigation.md) first; then choose the exploring, debugging, impact-analysis, pr-review, refactoring, or cli recipe skill for the task.
Pass `repo: '<repo>'` in every tool call.

| Family              | Tools and actions                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Discovery           | `discover`: repos, routes, tools, packs, groups, sync; `gn_help`, `gn_diagnose`            |
| Retrieval           | `search`: semantic, cypher, repomap; `gn_explore`, `gn_explain_module`                     |
| Context             | `inspect`: context, evidence, shape, ipc; `gn_find_related`                                |
| Edit safety         | `impact`: symbol, batch, route, diff; `gn_safe_edit_check`, `gn_can_delete`                |
| Verification        | `gn_verify_diff`, `gn_review_diff`, `gn_diff_impact`, `gn_test_gap`, `gn_pre_commit_audit` |
| Index lifecycle     | `gn_ensure_fresh` (coordinate refresh through navigation)                                  |
| Audits/docs         | `audit`, `docs`                                                                            |
| Session/refactoring | `manage`; `refactor`: rename (preview only), replace, sandbox                              |

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
