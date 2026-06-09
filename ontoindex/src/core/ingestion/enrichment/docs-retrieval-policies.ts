export const RETRIEVAL_POLICY_NAMES = [
  'graph-only',
  'graph-with-passive-docs',
  'requirement-neighborhood',
  'api-route-neighborhood',
  'process-neighborhood',
  'symbol-neighborhood',
] as const;

export type RetrievalPolicyName = (typeof RETRIEVAL_POLICY_NAMES)[number];
export type RetrievalPolicyNeighborhood =
  | 'graph'
  | 'docs'
  | 'requirement'
  | 'api-route'
  | 'process'
  | 'symbol';

export interface RetrievalPolicyConfig {
  name: RetrievalPolicyName;
  sourcePlanes: Array<'graph' | 'sidecar' | 'markdown-docs-sidecar'>;
  docsExpansion: boolean;
  passiveExpansion: boolean;
  neighborhood: RetrievalPolicyNeighborhood;
  pathReason: string;
  markdownFactKinds?: readonly string[];
}

export const RETRIEVAL_POLICIES: Record<RetrievalPolicyName, RetrievalPolicyConfig> = {
  'graph-only': {
    name: 'graph-only',
    sourcePlanes: ['graph'],
    docsExpansion: false,
    passiveExpansion: false,
    neighborhood: 'graph',
    pathReason: 'graph-result',
  },
  'graph-with-passive-docs': {
    name: 'graph-with-passive-docs',
    sourcePlanes: ['graph', 'sidecar', 'markdown-docs-sidecar'],
    docsExpansion: true,
    passiveExpansion: true,
    neighborhood: 'docs',
    pathReason: 'graph-result-to-passive-doc',
  },
  'requirement-neighborhood': {
    name: 'requirement-neighborhood',
    sourcePlanes: ['graph', 'sidecar', 'markdown-docs-sidecar'],
    docsExpansion: true,
    passiveExpansion: true,
    neighborhood: 'requirement',
    pathReason: 'graph-result-to-requirement-doc',
    markdownFactKinds: ['markdown-requirement', 'markdown-acceptance-criterion'],
  },
  'api-route-neighborhood': {
    name: 'api-route-neighborhood',
    sourcePlanes: ['graph', 'sidecar', 'markdown-docs-sidecar'],
    docsExpansion: true,
    passiveExpansion: true,
    neighborhood: 'api-route',
    pathReason: 'graph-result-to-api-route-doc',
    markdownFactKinds: ['markdown-api-spec'],
  },
  'process-neighborhood': {
    name: 'process-neighborhood',
    sourcePlanes: ['graph', 'sidecar', 'markdown-docs-sidecar'],
    docsExpansion: true,
    passiveExpansion: true,
    neighborhood: 'process',
    pathReason: 'graph-process-to-doc',
    markdownFactKinds: ['markdown-code-mention'],
  },
  'symbol-neighborhood': {
    name: 'symbol-neighborhood',
    sourcePlanes: ['graph', 'sidecar', 'markdown-docs-sidecar'],
    docsExpansion: true,
    passiveExpansion: true,
    neighborhood: 'symbol',
    pathReason: 'graph-symbol-to-doc',
    markdownFactKinds: ['markdown-code-mention'],
  },
};

export function isRetrievalPolicyName(value: unknown): value is RetrievalPolicyName {
  return typeof value === 'string' && (RETRIEVAL_POLICY_NAMES as readonly string[]).includes(value);
}

export function resolveRetrievalPolicy(value: unknown): RetrievalPolicyConfig | undefined {
  return isRetrievalPolicyName(value) ? RETRIEVAL_POLICIES[value] : undefined;
}
