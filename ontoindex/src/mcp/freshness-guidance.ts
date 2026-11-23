export const MCP_REPO_ROOT_PLACEHOLDER = '<absolute exact current worktree root>';

const ENSURE_FRESH_CALL =
  `manage({action: "ensure_fresh", repo: "${MCP_REPO_ROOT_PLACEHOLDER}", autoAnalyze: true})`;
const ANALYZE_JOB_CALL =
  `manage({action: "analyze_job", repo: "${MCP_REPO_ROOT_PLACEHOLDER}", jobId: "<returned jobId>"})`;

export const MCP_FRESHNESS_GATE_GUIDANCE = [
  '## Freshness gate',
  '',
  'Resolve the absolute root of the current Git worktree and use that exact path as `repo` in every MCP call. A registered project name is an index/resource label, not the current worktree path.',
  '',
  `Before graph-dependent work, call \`${ENSURE_FRESH_CALL}\`.`,
  '',
  `If \`analysisSubmission.status\` is \`"queued"\` or \`"reused"\`, poll \`${ANALYZE_JOB_CALL}\` until terminal. Only \`job.status === "complete"\` with \`job.exitCode === 0\` succeeds; then rerun \`manage({action: "ensure_fresh", repo: "${MCP_REPO_ROOT_PLACEHOLDER}", autoAnalyze: true})\` for the same root.`,
  '',
  'Fail closed: require an existing index and available matching indexed/current HEADs with `isStale === false`; runtime health must not be degraded or untrusted. After polling, block if final `analysisSubmission.status` is blocked/failed/queued/reused, a job is pending, final state is stale/reindexing/refreshing, or `needsAnalysis: true` when present. A fresh index with no job is acceptable. Stale graph output is never evidence.',
  '',
  'Check uncommitted changes against source and diff.',
  '',
  'Do not use local wrappers or `ontoindex analyze` as a freshness gate.',
].join('\n');

export const MCP_FRESHNESS_GATE_HINT =
  `Resolve the exact absolute current Git worktree root and call ${ENSURE_FRESH_CALL} before graph-dependent work. If submission is queued/reused, poll ${ANALYZE_JOB_CALL} until complete with exitCode 0, then recheck the same root. Require an existing index, available matching indexed/current HEADs, isStale=false, and trusted runtime. Block graph use when final status is blocked/failed/pending, stale/reindexing/refreshing, or needsAnalysis is true; a fresh index with no job is acceptable. Local CLI analyze is not the freshness gate.`;
