# OntoIndex Contract Ledger

Tracking breaking changes and version bumps in internal/external component contracts.

## Current Versions (2026-04-19)

| Layer | Version | Stability | Description |
|-------|---------|-----------|-------------|
| Graph Schema | 1 | Stable | Nodes have `domain`, `isExported`, `filePath`. |
| Meta JSON | 1 | Stable | Includes `contract`, `repoPath` relativized to `.`. |
| MCP Tools | 1 | Stable | Added `version`, `stability` fields to ToolDefinition. |
| Web API | 1 | Stable | Added `contract` info to `/api/info`. |

## Change Log

### 2026-04-19: Contract Alignment (v1)
- Initializing ledger to track Phase 0-3 refactorings.
- Standardizing component communication on v1 schemas.
