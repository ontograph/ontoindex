import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  ReactNode,
} from 'react';
import type { GraphNode, NodeLabel, PipelineProgress } from 'ontoindex-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import { createKnowledgeGraph } from '../core/graph/graph';
import type { LLMSettings, ChatMessage, ToolCallInfo } from '../core/llm/types';
import { getActiveProviderConfig } from '../core/llm/settings-service';
import { type EdgeType } from '../lib/constants';
import {
  connectToServer,
  runQuery as backendRunQuery,
  search as backendSearch,
  startEmbeddings as backendStartEmbeddings,
  streamEmbeddingProgress,
  probeBackend,
  type BackendRepo,
  type ConnectResult,
  type JobProgress,
} from '../services/backend-client';
import { ERROR_RESET_DELAY_MS } from '../config/ui-constants';
import { normalizePath } from '../lib/path-resolution';
import { GraphStateProvider, useGraphState } from './app-state/graph';
import { ChatStateProvider, useChatState } from './app-state/chat';

export type ViewMode = 'onboarding' | 'loading' | 'exploring';
export type RightPanelTab = 'code' | 'chat';
export type EmbeddingStatus = 'idle' | 'loading' | 'embedding' | 'indexing' | 'ready' | 'error';

export interface QueryResult {
  rows: Record<string, any>[];
  nodeIds: string[];
  executionTime: number;
}

// Animation types for graph nodes
export type AnimationType = 'pulse' | 'ripple' | 'glow';

export interface NodeAnimation {
  type: AnimationType;
  startTime: number;
  duration: number;
}

// Code reference from AI grounding or user selection
export interface CodeReference {
  id: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  nodeId?: string; // Associated graph node ID
  label?: string; // File, Function, Class, etc.
  name?: string; // Display name
  source: 'ai' | 'user'; // How it was added
}

export interface CodeReferenceFocus {
  filePath: string;
  startLine?: number;
  endLine?: number;
  ts: number;
}

interface AppState {
  // View state
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // Graph data
  graph: KnowledgeGraph | null;
  setGraph: (graph: KnowledgeGraph | null) => void;
  isSummary: boolean;
  setIsSummary: (isSummary: boolean) => void;

  // Selection
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;

  // Right Panel (unified Code + Chat)
  isRightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  rightPanelTab: RightPanelTab;
  setRightPanelTab: (tab: RightPanelTab) => void;
  openCodePanel: () => void;
  openChatPanel: () => void;
  helpDialogBoxOpen: boolean;
  setHelpDialogBoxOpen: (open: boolean) => void;

  // Filters
  visibleLabels: NodeLabel[];
  toggleLabelVisibility: (label: NodeLabel) => void;
  visibleEdgeTypes: EdgeType[];
  toggleEdgeVisibility: (edgeType: EdgeType) => void;

  // Depth filter (N hops from selection)
  depthFilter: number | null;
  setDepthFilter: (depth: number | null) => void;

  // Query state
  highlightedNodeIds: Set<string>;
  setHighlightedNodeIds: (ids: Set<string>) => void;
  // AI highlights (toggable)
  aiCitationHighlightedNodeIds: Set<string>;
  aiToolHighlightedNodeIds: Set<string>;
  blastRadiusNodeIds: Set<string>;
  isAIHighlightsEnabled: boolean;
  toggleAIHighlights: () => void;
  clearAIToolHighlights: () => void;
  clearAICitationHighlights: () => void;
  clearBlastRadius: () => void;
  queryResult: QueryResult | null;
  setQueryResult: (result: QueryResult | null) => void;
  clearQueryHighlights: () => void;

  // Node animations (for MCP tool visual feedback)
  animatedNodes: Map<string, NodeAnimation>;
  triggerNodeAnimation: (nodeIds: string[], type: AnimationType) => void;
  clearAnimations: () => void;

  // Progress
  progress: PipelineProgress | null;
  setProgress: (progress: PipelineProgress | null) => void;

  // Project info
  projectName: string;
  setProjectName: (name: string) => void;

  // Multi-repo switching
  serverBaseUrl: string | null;
  setServerBaseUrl: (url: string | null) => void;
  availableRepos: BackendRepo[];
  setAvailableRepos: (repos: BackendRepo[]) => void;
  switchRepo: (repoName: string) => Promise<void>;
  setCurrentRepo: (repoName: string) => void;

  // Worker API (shared across app)
  runQuery: (cypher: string) => Promise<any[]>;
  isDatabaseReady: () => Promise<boolean>;

  // Embedding state
  embeddingStatus: EmbeddingStatus;
  embeddingProgress: { phase: string; percent: number } | null;

  // Embedding methods
  startEmbeddings: () => Promise<void>;
  startEmbeddingsWithFallback: () => void;
  semanticSearch: (query: string, k?: number) => Promise<any[]>;
  semanticSearchWithContext: (query: string, k?: number, hops?: number) => Promise<any[]>;
  isEmbeddingReady: boolean;

  // LLM/Agent state
  llmSettings: LLMSettings;
  updateLLMSettings: (updates: Partial<LLMSettings>) => void;
  isSettingsPanelOpen: boolean;
  setSettingsPanelOpen: (open: boolean) => void;
  isAgentReady: boolean;
  isAgentInitializing: boolean;
  agentError: string | null;

  // Chat state
  chatMessages: ChatMessage[];
  isChatLoading: boolean;
  currentToolCalls: ToolCallInfo[];

  // LLM methods
  refreshLLMSettings: () => void;
  initializeAgent: (overrideProjectName?: string) => Promise<void>;
  sendChatMessage: (message: string) => Promise<void>;
  stopChatResponse: () => void;
  clearChat: () => void;

  // Code References Panel
  codeReferences: CodeReference[];
  isCodePanelOpen: boolean;
  setCodePanelOpen: (open: boolean) => void;
  addCodeReference: (ref: Omit<CodeReference, 'id'>) => void;
  removeCodeReference: (id: string) => void;
  clearAICodeReferences: () => void;
  clearCodeReferences: () => void;
  codeReferenceFocus: CodeReferenceFocus | null;
}

const AppStateContext = createContext<AppState | null>(null);

export const AppStateProvider = ({ children }: { children: ReactNode }) => (
  <GraphStateProvider>
    <AppStateProviderInner>{children}</AppStateProviderInner>
  </GraphStateProvider>
);

const AppStateProviderInner = ({ children }: { children: ReactNode }) => {
  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('onboarding');

  const {
    graph,
    setGraph,
    selectedNode,
    setSelectedNode,
    visibleLabels,
    toggleLabelVisibility,
    visibleEdgeTypes,
    toggleEdgeVisibility,
    depthFilter,
    setDepthFilter,
    highlightedNodeIds,
    setHighlightedNodeIds,
  } = useGraphState();

  const [isSummary, setIsSummary] = useState(false);

  // Right Panel
  const [isRightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('code');
  const [helpDialogBoxOpen, setHelpDialogBoxOpen] = useState(false);

  const openCodePanel = useCallback(() => {
    // Legacy API: used by graph/tree selection.
    // Code is now shown in the Code References Panel (left of the graph),
    // so "openCodePanel" just ensures that panel becomes visible when needed.
    setCodePanelOpen(true);
  }, []);

  const openChatPanel = useCallback(() => {
    setRightPanelOpen(true);
    setRightPanelTab('chat');
  }, []);

  // Query state
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);

  // AI highlights (separate from user/query highlights)
  const [aiCitationHighlightedNodeIds, setAICitationHighlightedNodeIds] = useState<Set<string>>(
    new Set(),
  );
  const [aiToolHighlightedNodeIds, setAIToolHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [blastRadiusNodeIds, setBlastRadiusNodeIds] = useState<Set<string>>(new Set());
  const [isAIHighlightsEnabled, setAIHighlightsEnabled] = useState(true);

  const toggleAIHighlights = useCallback(() => {
    setAIHighlightsEnabled((prev) => !prev);
  }, []);

  const clearAIToolHighlights = useCallback(() => {
    setAIToolHighlightedNodeIds(new Set());
  }, []);

  const clearAICitationHighlights = useCallback(() => {
    setAICitationHighlightedNodeIds(new Set());
  }, []);

  const clearBlastRadius = useCallback(() => {
    setBlastRadiusNodeIds(new Set());
  }, []);

  const clearQueryHighlights = useCallback(() => {
    setHighlightedNodeIds(new Set());
    setQueryResult(null);
  }, []);

  // Node animations (for MCP tool visual feedback)
  const [animatedNodes, setAnimatedNodes] = useState<Map<string, NodeAnimation>>(new Map());
  const animationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRefs = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const scheduleTimeout = useCallback((fn: () => void, delayMs: number) => {
    const timeout = setTimeout(() => {
      timeoutRefs.current.delete(timeout);
      fn();
    }, delayMs);
    timeoutRefs.current.add(timeout);
    return timeout;
  }, []);

  useEffect(() => {
    return () => {
      for (const timeout of timeoutRefs.current) {
        clearTimeout(timeout);
      }
      timeoutRefs.current.clear();
    };
  }, []);

  const triggerNodeAnimation = useCallback(
    (nodeIds: string[], type: AnimationType) => {
      const now = Date.now();
      const duration = type === 'pulse' ? 2000 : type === 'ripple' ? 3000 : 4000;

      setAnimatedNodes((prev) => {
        const next = new Map(prev);
        for (const id of nodeIds) {
          next.set(id, { type, startTime: now, duration });
        }
        return next;
      });

      // Auto-cleanup after duration
      scheduleTimeout(() => {
        setAnimatedNodes((prev) => {
          const next = new Map(prev);
          for (const id of nodeIds) {
            const anim = next.get(id);
            if (anim && anim.startTime === now) {
              next.delete(id);
            }
          }
          return next;
        });
      }, duration + 100);
    },
    [scheduleTimeout],
  );

  const clearAnimations = useCallback(() => {
    setAnimatedNodes(new Map());
    if (animationTimerRef.current) {
      clearInterval(animationTimerRef.current);
      animationTimerRef.current = null;
    }
  }, []);

  // Progress
  const [progress, setProgress] = useState<PipelineProgress | null>(null);

  // Project info
  const [projectName, setProjectName] = useState<string>('');

  // Multi-repo switching
  const [serverBaseUrl, setServerBaseUrl] = useState<string | null>(null);
  const [availableRepos, setAvailableRepos] = useState<BackendRepo[]>([]);

  // Embedding state
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus>('idle');
  const [embeddingProgress, setEmbeddingProgress] = useState<{
    phase: string;
    percent: number;
  } | null>(null);

  // Code References Panel state
  const [codeReferences, setCodeReferences] = useState<CodeReference[]>([]);
  const [isCodePanelOpen, setCodePanelOpen] = useState(false);
  const [codeReferenceFocus, setCodeReferenceFocus] = useState<CodeReferenceFocus | null>(null);

  // Map of normalized file path → node ID for graph-based lookups
  const fileNodeByPath = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const n of graph.nodes) {
      if (n.label === 'File') {
        map.set(normalizePath(n.properties.filePath), n.id);
      }
    }
    return map;
  }, [graph]);

  // Map of normalized path → original path for resolving partial paths
  const filePathIndex = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const n of graph.nodes) {
      if (n.label === 'File' && n.properties.filePath) {
        map.set(normalizePath(n.properties.filePath), n.properties.filePath);
      }
    }
    return map;
  }, [graph]);

  const resolveFilePath = useCallback(
    (requestedPath: string): string | null => {
      const normalized = normalizePath(requestedPath);
      // Exact match
      if (filePathIndex.has(normalized)) return filePathIndex.get(normalized)!;
      // Suffix match (partial paths like "src/utils.ts")
      for (const [key, value] of filePathIndex) {
        if (key.endsWith(normalized)) return value;
      }
      return null;
    },
    [filePathIndex],
  );

  const findFileNodeId = useCallback(
    (filePath: string): string | undefined => {
      return fileNodeByPath.get(normalizePath(filePath));
    },
    [fileNodeByPath],
  );

  // Code References methods
  const addCodeReference = useCallback((ref: Omit<CodeReference, 'id'>) => {
    const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newRef: CodeReference = { ...ref, id };

    setCodeReferences((prev) => {
      // Don't add duplicates (same file + line range)
      const isDuplicate = prev.some(
        (r) =>
          r.filePath === ref.filePath && r.startLine === ref.startLine && r.endLine === ref.endLine,
      );
      if (isDuplicate) return prev;
      return [...prev, newRef];
    });

    // Auto-open panel when references are added
    setCodePanelOpen(true);

    // Signal the Code Inspector to focus (scroll + glow) this reference.
    // This should happen even if the reference already exists (duplicates are ignored),
    // so it must be separate from the add-to-list behavior.
    setCodeReferenceFocus({
      filePath: ref.filePath,
      startLine: ref.startLine,
      endLine: ref.endLine,
      ts: Date.now(),
    });

    // Track AI highlights separately so they can be toggled off in the UI
    if (ref.nodeId && ref.source === 'ai') {
      setAICitationHighlightedNodeIds((prev) => new Set([...prev, ref.nodeId!]));
    }
  }, []);

  // Remove ONLY AI-provided refs so each new chat response refreshes the Code panel
  const clearAICodeReferences = useCallback(() => {
    setCodeReferences((prev) => {
      const removed = prev.filter((r) => r.source === 'ai');
      const kept = prev.filter((r) => r.source !== 'ai');

      // Remove citation-based AI highlights for removed refs
      const removedNodeIds = new Set(removed.map((r) => r.nodeId).filter(Boolean) as string[]);
      if (removedNodeIds.size > 0) {
        setAICitationHighlightedNodeIds((prevIds) => {
          const next = new Set(prevIds);
          for (const id of removedNodeIds) next.delete(id);
          return next;
        });
      }

      // Don't auto-close if the user has something selected (top viewer)
      if (kept.length === 0 && !selectedNode) {
        setCodePanelOpen(false);
      }
      return kept;
    });
  }, [selectedNode]);

  // Auto-add a code reference when the user selects a node in the graph/tree
  useEffect(() => {
    if (!selectedNode) return;
    // User selection should show in the top "Selected file" viewer,
    // not be appended to the AI citations list.
    setCodePanelOpen(true);
  }, [selectedNode]);

  // Backend client — direct HTTP calls (no Worker/Comlink)
  const repoRef = useRef<string | undefined>(undefined);

  const setCurrentRepo = useCallback((repoName: string) => {
    repoRef.current = repoName;
  }, []);

  const runQuery = useCallback(async (cypher: string): Promise<any[]> => {
    return backendRunQuery(cypher, repoRef.current);
  }, []);

  const isDatabaseReady = useCallback(async (): Promise<boolean> => {
    return probeBackend();
  }, []);

  // Embedding methods — now trigger server-side via /api/embed
  const embedAbortRef = useRef<AbortController | null>(null);

  const startEmbeddings = useCallback(async (): Promise<void> => {
    const repo = repoRef.current;
    if (!repo) throw new Error('No repository loaded');

    setEmbeddingStatus('loading');
    setEmbeddingProgress(null);

    try {
      const { jobId } = await backendStartEmbeddings(repo);

      // Stream progress via SSE
      await new Promise<void>((resolve, reject) => {
        embedAbortRef.current = streamEmbeddingProgress(
          jobId,
          (progress: JobProgress) => {
            setEmbeddingProgress({ phase: progress.phase as any, percent: progress.percent });
            if (progress.phase === 'loading-model' || progress.phase === 'loading') {
              setEmbeddingStatus('loading');
            } else if (progress.phase === 'embedding') {
              setEmbeddingStatus('embedding');
            } else if (progress.phase === 'indexing') {
              setEmbeddingStatus('indexing');
            }
          },
          () => {
            setEmbeddingStatus('ready');
            setEmbeddingProgress({ phase: 'ready' as any, percent: 100 });
            resolve();
          },
          (error: string) => {
            setEmbeddingStatus('error');
            reject(new Error(error));
          },
        );
      });
    } catch (error: any) {
      if (error?.message?.includes('already in progress')) {
        // Dedup — embeddings already running, just wait
        setEmbeddingStatus('embedding');
        return;
      }
      setEmbeddingStatus('error');
      throw error;
    }
  }, []);

  const startEmbeddingsWithFallback = useCallback(() => {
    const isPlaywright =
      (typeof navigator !== 'undefined' && navigator.webdriver) ||
      (typeof import.meta !== 'undefined' &&
        typeof import.meta.env !== 'undefined' &&
        import.meta.env.VITE_PLAYWRIGHT_TEST) ||
      (typeof process !== 'undefined' && process.env.PLAYWRIGHT_TEST);
    if (isPlaywright) {
      setEmbeddingStatus('idle');
      return;
    }
    startEmbeddings().catch((err) => {
      console.warn('Embeddings auto-start failed:', err);
    });
  }, [startEmbeddings]);

  const semanticSearch = useCallback(async (query: string, k: number = 10): Promise<any[]> => {
    return backendSearch(query, { limit: k, mode: 'semantic', repo: repoRef.current });
  }, []);

  const semanticSearchWithContext = useCallback(
    async (query: string, k: number = 5, _hops: number = 2): Promise<any[]> => {
      return backendSearch(query, {
        limit: k,
        mode: 'semantic',
        enrich: true,
        repo: repoRef.current,
      });
    },
    [],
  );

  const removeCodeReference = useCallback(
    (id: string) => {
      setCodeReferences((prev) => {
        const ref = prev.find((r) => r.id === id);
        const newRefs = prev.filter((r) => r.id !== id);

        // Remove AI citation highlight if this was the only AI reference to that node
        if (ref?.nodeId && ref.source === 'ai') {
          const stillReferenced = newRefs.some((r) => r.nodeId === ref.nodeId && r.source === 'ai');
          if (!stillReferenced) {
            setAICitationHighlightedNodeIds((prev) => {
              const next = new Set(prev);
              next.delete(ref.nodeId!);
              return next;
            });
          }
        }

        // Auto-close panel if no references left AND no selection in top viewer
        if (newRefs.length === 0 && !selectedNode) {
          setCodePanelOpen(false);
        }

        return newRefs;
      });
    },
    [selectedNode],
  );

  const clearCodeReferences = useCallback(() => {
    setCodeReferences([]);
    setCodePanelOpen(false);
    setCodeReferenceFocus(null);
  }, []);

  // Stable cross-slice deps object for ChatStateProvider.
  // Individual values inside may change, but we pass them by reference through the
  // deps prop — ChatStateProvider accesses current values via closure at call time.
  const chatDeps = useMemo(
    () => ({
      graph,
      embeddingStatus,
      repoRef,
      projectName,
      resolveFilePath,
      findFileNodeId,
      addCodeReference,
      clearAICodeReferences,
      clearAIToolHighlights,
      setAIToolHighlightedNodeIds,
      setBlastRadiusNodeIds,
    }),

    [
      graph,
      embeddingStatus,
      projectName,
      resolveFilePath,
      findFileNodeId,
      addCodeReference,
      clearAICodeReferences,
      clearAIToolHighlights,
      setAIToolHighlightedNodeIds,
      setBlastRadiusNodeIds,
    ],
  );

  return (
    <ChatStateProvider deps={chatDeps}>
      <AppStateConsumer
        viewMode={viewMode}
        setViewMode={setViewMode}
        graph={graph}
        setGraph={setGraph}
        isSummary={isSummary}
        setIsSummary={setIsSummary}
        selectedNode={selectedNode}
        setSelectedNode={setSelectedNode}
        isRightPanelOpen={isRightPanelOpen}
        setRightPanelOpen={setRightPanelOpen}
        rightPanelTab={rightPanelTab}
        setRightPanelTab={setRightPanelTab}
        openCodePanel={openCodePanel}
        openChatPanel={openChatPanel}
        helpDialogBoxOpen={helpDialogBoxOpen}
        setHelpDialogBoxOpen={setHelpDialogBoxOpen}
        visibleLabels={visibleLabels}
        toggleLabelVisibility={toggleLabelVisibility}
        visibleEdgeTypes={visibleEdgeTypes}
        toggleEdgeVisibility={toggleEdgeVisibility}
        depthFilter={depthFilter}
        setDepthFilter={setDepthFilter}
        highlightedNodeIds={highlightedNodeIds}
        setHighlightedNodeIds={setHighlightedNodeIds}
        aiCitationHighlightedNodeIds={aiCitationHighlightedNodeIds}
        aiToolHighlightedNodeIds={aiToolHighlightedNodeIds}
        blastRadiusNodeIds={blastRadiusNodeIds}
        isAIHighlightsEnabled={isAIHighlightsEnabled}
        toggleAIHighlights={toggleAIHighlights}
        clearAIToolHighlights={clearAIToolHighlights}
        clearAICitationHighlights={clearAICitationHighlights}
        clearBlastRadius={clearBlastRadius}
        queryResult={queryResult}
        setQueryResult={setQueryResult}
        clearQueryHighlights={clearQueryHighlights}
        animatedNodes={animatedNodes}
        triggerNodeAnimation={triggerNodeAnimation}
        clearAnimations={clearAnimations}
        progress={progress}
        setProgress={setProgress}
        projectName={projectName}
        setProjectName={setProjectName}
        serverBaseUrl={serverBaseUrl}
        setServerBaseUrl={setServerBaseUrl}
        availableRepos={availableRepos}
        setAvailableRepos={setAvailableRepos}
        setCurrentRepo={setCurrentRepo}
        repoRef={repoRef}
        runQuery={runQuery}
        isDatabaseReady={isDatabaseReady}
        embeddingStatus={embeddingStatus}
        embeddingProgress={embeddingProgress}
        startEmbeddings={startEmbeddings}
        startEmbeddingsWithFallback={startEmbeddingsWithFallback}
        semanticSearch={semanticSearch}
        semanticSearchWithContext={semanticSearchWithContext}
        codeReferences={codeReferences}
        isCodePanelOpen={isCodePanelOpen}
        setCodePanelOpen={setCodePanelOpen}
        addCodeReference={addCodeReference}
        removeCodeReference={removeCodeReference}
        clearAICodeReferences={clearAICodeReferences}
        clearCodeReferences={clearCodeReferences}
        codeReferenceFocus={codeReferenceFocus}
        setCodeReferences={setCodeReferences}
        setCodeReferenceFocus={setCodeReferenceFocus}
      >
        {children}
      </AppStateConsumer>
    </ChatStateProvider>
  );
};

interface AppStateConsumerProps {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  graph: KnowledgeGraph | null;
  setGraph: (graph: KnowledgeGraph | null) => void;
  isSummary: boolean;
  setIsSummary: (isSummary: boolean) => void;
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;
  isRightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  rightPanelTab: RightPanelTab;
  setRightPanelTab: (tab: RightPanelTab) => void;
  openCodePanel: () => void;
  openChatPanel: () => void;
  helpDialogBoxOpen: boolean;
  setHelpDialogBoxOpen: (open: boolean) => void;
  visibleLabels: NodeLabel[];
  toggleLabelVisibility: (label: NodeLabel) => void;
  visibleEdgeTypes: EdgeType[];
  toggleEdgeVisibility: (edgeType: EdgeType) => void;
  depthFilter: number | null;
  setDepthFilter: (depth: number | null) => void;
  highlightedNodeIds: Set<string>;
  setHighlightedNodeIds: (ids: Set<string>) => void;
  aiCitationHighlightedNodeIds: Set<string>;
  aiToolHighlightedNodeIds: Set<string>;
  blastRadiusNodeIds: Set<string>;
  isAIHighlightsEnabled: boolean;
  toggleAIHighlights: () => void;
  clearAIToolHighlights: () => void;
  clearAICitationHighlights: () => void;
  clearBlastRadius: () => void;
  queryResult: QueryResult | null;
  setQueryResult: (result: QueryResult | null) => void;
  clearQueryHighlights: () => void;
  animatedNodes: Map<string, NodeAnimation>;
  triggerNodeAnimation: (nodeIds: string[], type: AnimationType) => void;
  clearAnimations: () => void;
  progress: PipelineProgress | null;
  setProgress: (progress: PipelineProgress | null) => void;
  projectName: string;
  setProjectName: (name: string) => void;
  serverBaseUrl: string | null;
  setServerBaseUrl: (url: string | null) => void;
  availableRepos: BackendRepo[];
  setAvailableRepos: (repos: BackendRepo[]) => void;
  setCurrentRepo: (repoName: string) => void;
  repoRef: React.MutableRefObject<string | undefined>;
  runQuery: (cypher: string) => Promise<any[]>;
  isDatabaseReady: () => Promise<boolean>;
  embeddingStatus: EmbeddingStatus;
  embeddingProgress: { phase: string; percent: number } | null;
  startEmbeddings: () => Promise<void>;
  startEmbeddingsWithFallback: () => void;
  semanticSearch: (query: string, k?: number) => Promise<any[]>;
  semanticSearchWithContext: (query: string, k?: number, hops?: number) => Promise<any[]>;
  codeReferences: CodeReference[];
  isCodePanelOpen: boolean;
  setCodePanelOpen: (open: boolean) => void;
  addCodeReference: (ref: Omit<CodeReference, 'id'>) => void;
  removeCodeReference: (id: string) => void;
  clearAICodeReferences: () => void;
  clearCodeReferences: () => void;
  codeReferenceFocus: CodeReferenceFocus | null;
  setCodeReferences: React.Dispatch<React.SetStateAction<CodeReference[]>>;
  setCodeReferenceFocus: (focus: CodeReferenceFocus | null) => void;
  children: ReactNode;
}

const AppStateConsumer = (props: AppStateConsumerProps) => {
  const {
    viewMode,
    setViewMode,
    graph,
    setGraph,
    isSummary,
    setIsSummary,
    selectedNode,
    setSelectedNode,
    isRightPanelOpen,
    setRightPanelOpen,
    rightPanelTab,
    setRightPanelTab,
    openCodePanel,
    openChatPanel,
    helpDialogBoxOpen,
    setHelpDialogBoxOpen,
    visibleLabels,
    toggleLabelVisibility,
    visibleEdgeTypes,
    toggleEdgeVisibility,
    depthFilter,
    setDepthFilter,
    highlightedNodeIds,
    setHighlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    queryResult,
    setQueryResult,
    clearQueryHighlights,
    animatedNodes,
    triggerNodeAnimation,
    clearAnimations,
    progress,
    setProgress,
    projectName,
    setProjectName,
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    setCurrentRepo,
    repoRef,
    runQuery,
    isDatabaseReady,
    embeddingStatus,
    embeddingProgress,
    startEmbeddings,
    startEmbeddingsWithFallback,
    semanticSearch,
    semanticSearchWithContext,
    codeReferences,
    isCodePanelOpen,
    setCodePanelOpen,
    addCodeReference,
    removeCodeReference,
    clearAICodeReferences,
    clearCodeReferences,
    codeReferenceFocus,
    setCodeReferences,
    setCodeReferenceFocus,
    children,
  } = props;

  const resetTimeoutRefs = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const clearResetTimeouts = useCallback(() => {
    for (const timeout of resetTimeoutRefs.current) {
      clearTimeout(timeout);
    }
    resetTimeoutRefs.current.clear();
  }, []);

  const scheduleResetTimeout = useCallback((fn: () => void, delayMs: number) => {
    const timeout = setTimeout(() => {
      resetTimeoutRefs.current.delete(timeout);
      fn();
    }, delayMs);
    resetTimeoutRefs.current.add(timeout);
    return timeout;
  }, []);

  useEffect(() => {
    return clearResetTimeouts;
  }, [clearResetTimeouts]);

  const {
    llmSettings,
    updateLLMSettings,
    isSettingsPanelOpen,
    setSettingsPanelOpen,
    isAgentReady,
    isAgentInitializing,
    agentError,
    chatMessages,
    isChatLoading,
    currentToolCalls,
    refreshLLMSettings,
    initializeAgent,
    sendChatMessage,
    stopChatResponse,
    clearChat,
    setIsAgentReady,
    setAgentError,
    setChatMessages,
    agentRef,
  } = useChatState();

  // Switch to a different repo on the connected server
  const switchRepo = useCallback(
    async (repoName: string) => {
      if (!serverBaseUrl) return;

      clearResetTimeouts();
      setProgress({
        phase: 'extracting',
        percent: 0,
        message: 'Switching repository...',
        detail: `Loading ${repoName}`,
      });
      setViewMode('loading');
      setIsAgentReady(false);

      // Clear stale graph state from previous repo (highlights, selections, blast radius)
      // Without this, sigma reducers dim ALL nodes/edges because old node IDs don't match
      setHighlightedNodeIds(new Set());
      clearAIToolHighlights();
      clearAICitationHighlights();
      clearBlastRadius();
      setSelectedNode(null);
      setQueryResult(null);
      setCodeReferences([]);
      setCodePanelOpen(false);
      setCodeReferenceFocus(null);

      let connectedRepo: BackendRepo | undefined;
      let pNameStr = repoName || 'server-project';

      try {
        const fullParam = new URLSearchParams(window.location.search).get('full') === 'true';
        const result: ConnectResult = await connectToServer(
          serverBaseUrl,
          (phase, downloaded, total) => {
            if (phase === 'validating') {
              setProgress({
                phase: 'extracting',
                percent: 5,
                message: 'Switching repository...',
                detail: 'Validating',
              });
            } else if (phase === 'downloading') {
              const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
              const mb = (downloaded / (1024 * 1024)).toFixed(1);
              setProgress({
                phase: 'extracting',
                percent: pct,
                message: 'Downloading graph...',
                detail: `${mb} MB downloaded`,
              });
            } else if (phase === 'extracting') {
              setProgress({
                phase: 'extracting',
                percent: 97,
                message: 'Processing...',
                detail: 'Extracting file contents',
              });
            }
          },
          undefined,
          repoName,
          { awaitAnalysis: true, forceFull: fullParam }, // enable backend hold-queue for repos still being analyzed
        );

        // Build graph for visualization
        const repoPath = result.repoInfo.repoPath ?? result.repoInfo.path;
        // Prefer the registry name, then normalize Windows \ and Unix / paths
        const pName =
          repoName ||
          result.repoInfo.name ||
          (repoPath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
          'server-project';
        setProjectName(pName);
        repoRef.current = pName;

        connectedRepo = result.repoInfo;
        pNameStr = pName;

        const newGraph = createKnowledgeGraph();
        for (const node of result.nodes) newGraph.addNode(node);
        for (const rel of result.relationships) newGraph.addRelationship(rel);
        setGraph(newGraph);
        setIsSummary(result.isSummary);
      } catch (err: unknown) {
        console.error('Repo switch failed:', err);
        setProgress({
          phase: 'error',
          percent: 0,
          message: 'Failed to switch repository',
          detail: err instanceof Error ? err.message : 'Unknown error',
        });
        setIsAgentReady(false);
        setIsSummary(false);
        agentRef.current = null;
        scheduleResetTimeout(() => {
          setViewMode('exploring');
          setProgress(null);
        }, ERROR_RESET_DELAY_MS);
        return; // Abort the whole switchRepo process
      }

      if (pNameStr) {
        // Persist the selected project in the URL so a refresh re-opens it
        const urlObj = new URL(window.location.href);
        urlObj.searchParams.set('project', pNameStr);
        window.history.replaceState(null, '', urlObj.toString());
      }

      // Reset the agent and clear chat history so the AI starts fresh for the new repo
      agentRef.current = null;
      setIsAgentReady(false);
      setChatMessages([]);

      // Re-initialize agent with the new repo's graph context
      try {
        if (getActiveProviderConfig()) {
          await initializeAgent(pNameStr);
        }
        setViewMode('exploring');
        startEmbeddingsWithFallback();
        setProgress(null);
      } catch (err) {
        console.warn('Failed to initialize agent:', err);
        setIsAgentReady(false);
        agentRef.current = null;
        setAgentError('Failed to initialize agent');
        setViewMode('exploring');
        setProgress(null);
      }
    },
    [
      serverBaseUrl,
      setProgress,
      setViewMode,
      setProjectName,
      setGraph,
      setIsSummary,
      initializeAgent,
      startEmbeddingsWithFallback,
      setHighlightedNodeIds,
      clearAIToolHighlights,
      clearAICitationHighlights,
      clearBlastRadius,
      setSelectedNode,
      setQueryResult,
      setCodeReferences,
      setCodePanelOpen,
      setCodeReferenceFocus,
      setChatMessages,
      setIsAgentReady,
      setAgentError,
      agentRef,
      repoRef,
      clearResetTimeouts,
      scheduleResetTimeout,
    ],
  );

  const value: AppState = {
    viewMode,
    setViewMode,
    graph,
    setGraph,
    isSummary,
    setIsSummary,
    selectedNode,
    setSelectedNode,
    isRightPanelOpen,
    setRightPanelOpen,
    rightPanelTab,
    setRightPanelTab,
    openCodePanel,
    openChatPanel,
    helpDialogBoxOpen,
    setHelpDialogBoxOpen,
    visibleLabels,
    toggleLabelVisibility,
    visibleEdgeTypes,
    toggleEdgeVisibility,
    depthFilter,
    setDepthFilter,
    highlightedNodeIds,
    setHighlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    queryResult,
    setQueryResult,
    clearQueryHighlights,
    // Node animations
    animatedNodes,
    triggerNodeAnimation,
    clearAnimations,
    progress,
    setProgress,
    projectName,
    setProjectName,
    // Multi-repo switching
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    switchRepo,
    setCurrentRepo,
    runQuery,
    isDatabaseReady,
    // Embedding state and methods
    embeddingStatus,
    embeddingProgress,
    startEmbeddings,
    startEmbeddingsWithFallback,
    semanticSearch,
    semanticSearchWithContext,
    isEmbeddingReady: embeddingStatus === 'ready',
    // LLM/Agent state
    llmSettings,
    updateLLMSettings,
    isSettingsPanelOpen,
    setSettingsPanelOpen,
    isAgentReady,
    isAgentInitializing,
    agentError,
    // Chat state
    chatMessages,
    isChatLoading,
    currentToolCalls,
    // LLM methods
    refreshLLMSettings,
    initializeAgent,
    sendChatMessage,
    stopChatResponse,
    clearChat,
    // Code References Panel
    codeReferences,
    isCodePanelOpen,
    setCodePanelOpen,
    addCodeReference,
    removeCodeReference,
    clearAICodeReferences,
    clearCodeReferences,
    codeReferenceFocus,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
};

export const useAppState = (): AppState => {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error('useAppState must be used within AppStateProvider');
  }
  return context;
};
