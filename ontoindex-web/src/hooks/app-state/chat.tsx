import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import type {
  LLMSettings,
  AgentStreamChunk,
  ChatMessage,
  ToolCallInfo,
  MessageStep,
} from '../../core/llm/types';
import {
  loadSettings,
  getActiveProviderConfig,
  saveSettings,
} from '../../core/llm/settings-service';
import type { AgentMessage } from '../../core/llm/agent';
import {
  runQuery as backendRunQuery,
  search as backendSearch,
  grep as backendGrep,
  readFile as backendReadFile,
} from '../../services/backend-client';
import type { KnowledgeGraph } from '../../core/graph/types';
import { FILE_REF_REGEX, NODE_REF_REGEX } from '../../lib/grounding-patterns';
import type { EmbeddingStatus, CodeReference } from '../useAppState';

interface ChatStateCrossSliceDeps {
  graph: KnowledgeGraph | null;
  embeddingStatus: EmbeddingStatus;
  repoRef: React.MutableRefObject<string | undefined>;
  projectName: string;
  resolveFilePath: (path: string) => string | null;
  findFileNodeId: (filePath: string) => string | undefined;
  addCodeReference: (ref: Omit<CodeReference, 'id'>) => void;
  clearAICodeReferences: () => void;
  clearAIToolHighlights: () => void;
  setAIToolHighlightedNodeIds: (ids: Set<string>) => void;
  setBlastRadiusNodeIds: (ids: Set<string>) => void;
}

interface ChatStateContextValue {
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

  // Internal setters exposed for AppStateProviderInner (switchRepo)
  setIsAgentReady: (ready: boolean) => void;
  setAgentError: (error: string | null) => void;
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  agentRef: React.MutableRefObject<any>;
}

const ChatStateContext = createContext<ChatStateContextValue | null>(null);

export const ChatStateProvider = ({
  children,
  deps,
}: {
  children: ReactNode;
  deps: ChatStateCrossSliceDeps;
}) => {
  // LLM/Agent state
  const [llmSettings, setLLMSettings] = useState<LLMSettings>(loadSettings);
  const [isSettingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [isAgentReady, setIsAgentReady] = useState(false);
  const [isAgentInitializing, setIsAgentInitializing] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCallInfo[]>([]);

  // Agent state — agent runs on main thread now (I/O-bound, not CPU-bound)
  const agentRef = useRef<any>(null);

  // LLM methods
  const updateLLMSettings = useCallback((updates: Partial<LLMSettings>) => {
    setLLMSettings((prev) => {
      const next = { ...prev, ...updates };
      saveSettings(next);
      return next;
    });
  }, []);

  const refreshLLMSettings = useCallback(() => {
    setLLMSettings(loadSettings());
  }, []);

  const initializeAgent = useCallback(
    async (overrideProjectName?: string): Promise<void> => {
      const config = getActiveProviderConfig();
      if (!config) {
        setAgentError('Please configure an LLM provider in settings');
        return;
      }

      setIsAgentInitializing(true);
      setAgentError(null);

      try {
        const effectiveProjectName = overrideProjectName || deps.projectName || 'project';

        // Sync repoRef so all agent backend calls target the correct repo.
        // initializeAgent can be called from App.tsx (handleServerConnect) which
        // never sets repoRef.current directly — without this, queries default to repo[0].
        if (overrideProjectName) {
          deps.repoRef.current = overrideProjectName;
        }
        const repo = deps.repoRef.current;

        // Build backend interface for Graph RAG tools
        const { createGraphRAGAgent } = await import('../../core/llm/agent');
        const { buildCodebaseContext } = await import('../../core/llm/context-builder');

        const executeQuery = (cypher: string) => backendRunQuery(cypher, repo);
        const codebaseContext = await buildCodebaseContext(executeQuery, effectiveProjectName);

        const backend = {
          executeQuery,
          search: (query: string, opts?: any) => backendSearch(query, { ...opts, repo }),
          grep: (pattern: string, limit?: number) => backendGrep(pattern, repo, limit),
          readFile: (filePath: string) =>
            backendReadFile(filePath, { repo }).then((r) => r.content),
        };

        agentRef.current = createGraphRAGAgent(config, backend, codebaseContext);
        setIsAgentReady(true);
        setAgentError(null);
        if (import.meta.env.DEV) {
          console.log('✅ Agent initialized successfully');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAgentError(message);
        setIsAgentReady(false);
      } finally {
        setIsAgentInitializing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [], // repoRef is a stable ref — we sync it explicitly on entry; no state deps needed
  );

  const sendChatMessage = useCallback(
    async (message: string): Promise<void> => {
      // Refresh Code panel for the new question: keep user-pinned refs, clear old AI citations
      deps.clearAICodeReferences();
      // Also clear previous tool-driven AI highlights (highlight_in_graph)
      deps.clearAIToolHighlights();

      if (!isAgentReady) {
        // Try to initialize first
        await initializeAgent();
        if (!agentRef.current) return;
      }

      // Add user message
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: message,
        timestamp: Date.now(),
      };
      setChatMessages((prev) => [...prev, userMessage]);

      // If embeddings are running and we're currently creating the vector index,
      // avoid a confusing "Embeddings not ready" error and give a clear wait message.
      if (deps.embeddingStatus === 'indexing') {
        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: 'Wait a moment, vector index is being created.',
          timestamp: Date.now(),
        };
        setChatMessages((prev) => [...prev, assistantMessage]);
        setAgentError(null);
        setIsChatLoading(false);
        setCurrentToolCalls([]);
        return;
      }

      setIsChatLoading(true);
      setCurrentToolCalls([]);

      // Prepare message history for agent (convert our format to AgentMessage format)
      const history: AgentMessage[] = [...chatMessages, userMessage].map((m) => ({
        role: m.role === 'tool' ? 'assistant' : m.role,
        content: m.content,
      }));

      // Create placeholder for assistant response
      const assistantMessageId = `assistant-${Date.now()}`;
      // Use an ordered steps array to preserve execution order (reasoning → tool → reasoning → tool → answer)
      const stepsForMessage: MessageStep[] = [];
      // Keep toolCalls for backwards compat and currentToolCalls state
      const toolCallsForMessage: ToolCallInfo[] = [];
      let stepCounter = 0;

      // Helper to update the message with current steps
      const updateMessage = () => {
        // Build content from steps for backwards compatibility
        const contentParts = stepsForMessage
          .filter((s) => s.type === 'reasoning' || s.type === 'content')
          .map((s) => s.content)
          .filter(Boolean);
        const content = contentParts.join('\n\n');

        setChatMessages((prev) => {
          const existing = prev.find((m) => m.id === assistantMessageId);
          const newMessage: ChatMessage = {
            id: assistantMessageId,
            role: 'assistant' as const,
            content,
            steps: [...stepsForMessage],
            toolCalls: [...toolCallsForMessage],
            timestamp: existing?.timestamp ?? Date.now(),
          };
          if (existing) {
            return prev.map((m) => (m.id === assistantMessageId ? newMessage : m));
          } else {
            return [...prev, newMessage];
          }
        });
      };
      let pendingUpdate = false;
      const scheduleMessageUpdate = () => {
        if (pendingUpdate) return;
        pendingUpdate = true;
        requestAnimationFrame(() => {
          pendingUpdate = false;
          updateMessage();
        });
      };

      try {
        const onChunk = (chunk: AgentStreamChunk) => {
          switch (chunk.type) {
            case 'reasoning':
              // LLM's thinking/reasoning - accumulate contiguous reasoning
              if (chunk.reasoning) {
                const lastStep = stepsForMessage[stepsForMessage.length - 1];
                if (lastStep && lastStep.type === 'reasoning') {
                  // Append to existing reasoning step
                  stepsForMessage[stepsForMessage.length - 1] = {
                    ...lastStep,
                    content: (lastStep.content || '') + chunk.reasoning,
                  };
                } else {
                  // Create new reasoning step (after tool calls or at start)
                  stepsForMessage.push({
                    id: `step-${stepCounter++}`,
                    type: 'reasoning',
                    content: chunk.reasoning,
                  });
                }
                scheduleMessageUpdate();
              }
              break;

            case 'content':
              // Final answer content - accumulate into contiguous content step
              if (chunk.content) {
                // Only append if the LAST step is a content step (contiguous streaming)
                const lastStep = stepsForMessage[stepsForMessage.length - 1];
                if (lastStep && lastStep.type === 'content') {
                  // Append to existing content step
                  stepsForMessage[stepsForMessage.length - 1] = {
                    ...lastStep,
                    content: (lastStep.content || '') + chunk.content,
                  };
                } else {
                  // Create new content step (after tool calls or at start)
                  stepsForMessage.push({
                    id: `step-${stepCounter++}`,
                    type: 'content',
                    content: chunk.content,
                  });
                }
                scheduleMessageUpdate();

                // Parse inline grounding references and add them to the Code References panel.
                // Supports: [[file.ts:10-25]] (file refs) and [[Class:View]] (node refs)
                const currentContentStep = stepsForMessage[stepsForMessage.length - 1];
                const fullText =
                  currentContentStep && currentContentStep.type === 'content'
                    ? currentContentStep.content || ''
                    : '';

                // Pattern 1: File refs - [[path/file.ext]] or [[path/file.ext:line]] or [[path/file.ext:line-line]]
                // Line numbers are optional
                const fileRefRegex = new RegExp(FILE_REF_REGEX.source, FILE_REF_REGEX.flags);
                let fileMatch: RegExpExecArray | null;
                while ((fileMatch = fileRefRegex.exec(fullText)) !== null) {
                  const rawPath = fileMatch[1].trim();
                  const startLine1 = fileMatch[2] ? parseInt(fileMatch[2], 10) : undefined;
                  const endLine1 = fileMatch[3] ? parseInt(fileMatch[3], 10) : startLine1;

                  const resolvedPath = deps.resolveFilePath(rawPath);
                  if (!resolvedPath) continue;

                  const startLine0 =
                    startLine1 !== undefined ? Math.max(0, startLine1 - 1) : undefined;
                  const endLine0 = endLine1 !== undefined ? Math.max(0, endLine1 - 1) : startLine0;
                  const nodeId = deps.findFileNodeId(resolvedPath);

                  deps.addCodeReference({
                    filePath: resolvedPath,
                    startLine: startLine0,
                    endLine: endLine0,
                    nodeId,
                    label: 'File',
                    name: resolvedPath.split('/').pop() ?? resolvedPath,
                    source: 'ai',
                  });
                }

                // Pattern 2: Node refs - [[Type:Name]] or [[graph:Type:Name]]
                const nodeRefRegex = new RegExp(NODE_REF_REGEX.source, NODE_REF_REGEX.flags);
                let nodeMatch: RegExpExecArray | null;
                while ((nodeMatch = nodeRefRegex.exec(fullText)) !== null) {
                  const nodeType = nodeMatch[1];
                  const nodeName = nodeMatch[2].trim();

                  // Find node in graph
                  if (!deps.graph) continue;
                  const node = deps.graph.nodes.find(
                    (n) => n.label === nodeType && n.properties.name === nodeName,
                  );
                  if (!node || !node.properties.filePath) continue;

                  const resolvedPath = deps.resolveFilePath(node.properties.filePath);
                  if (!resolvedPath) continue;

                  deps.addCodeReference({
                    filePath: resolvedPath,
                    startLine: node.properties.startLine
                      ? node.properties.startLine - 1
                      : undefined,
                    endLine: node.properties.endLine ? node.properties.endLine - 1 : undefined,
                    nodeId: node.id,
                    label: node.label,
                    name: node.properties.name,
                    source: 'ai',
                  });
                }
              }
              break;

            case 'tool_call':
              if (chunk.toolCall) {
                const tc = chunk.toolCall;
                toolCallsForMessage.push(tc);
                // Add tool call as a step (in order with reasoning)
                stepsForMessage.push({
                  id: `step-${stepCounter++}`,
                  type: 'tool_call',
                  toolCall: tc,
                });
                setCurrentToolCalls((prev) => [...prev, tc]);
                scheduleMessageUpdate();
              }
              break;

            case 'tool_result':
              if (chunk.toolCall) {
                const tc = chunk.toolCall;
                // Update the tool call status in toolCallsForMessage
                let idx = toolCallsForMessage.findIndex((t) => t.id === tc.id);
                if (idx < 0) {
                  idx = toolCallsForMessage.findIndex(
                    (t) => t.name === tc.name && t.status === 'running',
                  );
                }
                if (idx < 0) {
                  idx = toolCallsForMessage.findIndex((t) => t.name === tc.name && !t.result);
                }
                if (idx >= 0) {
                  toolCallsForMessage[idx] = {
                    ...toolCallsForMessage[idx],
                    result: tc.result,
                    status: 'completed',
                  };
                }

                // Also update the tool call in steps
                const stepIdx = stepsForMessage.findIndex(
                  (s) =>
                    s.type === 'tool_call' &&
                    s.toolCall &&
                    (s.toolCall.id === tc.id ||
                      (s.toolCall.name === tc.name && s.toolCall.status === 'running')),
                );
                if (stepIdx >= 0 && stepsForMessage[stepIdx].toolCall) {
                  stepsForMessage[stepIdx] = {
                    ...stepsForMessage[stepIdx],
                    toolCall: {
                      ...stepsForMessage[stepIdx].toolCall!,
                      result: tc.result,
                      status: 'completed',
                    },
                  };
                }

                // Update currentToolCalls
                setCurrentToolCalls((prev) => {
                  let targetIdx = prev.findIndex((t) => t.id === tc.id);
                  if (targetIdx < 0) {
                    targetIdx = prev.findIndex((t) => t.name === tc.name && t.status === 'running');
                  }
                  if (targetIdx < 0) {
                    targetIdx = prev.findIndex((t) => t.name === tc.name && !t.result);
                  }
                  if (targetIdx >= 0) {
                    return prev.map((t, i) =>
                      i === targetIdx ? { ...t, result: tc.result, status: 'completed' } : t,
                    );
                  }
                  return prev;
                });

                scheduleMessageUpdate();

                // Parse highlight marker from tool results
                if (tc.result) {
                  const highlightMatch = tc.result.match(/\[HIGHLIGHT_NODES:([^\]]+)\]/);
                  if (highlightMatch) {
                    const rawIds = highlightMatch[1]
                      .split(',')
                      .map((id: string) => id.trim())
                      .filter(Boolean);
                    if (rawIds.length > 0 && deps.graph) {
                      const matchedIds = new Set<string>();
                      const graphNodeIdSet = new Set(deps.graph.nodes.map((n) => n.id));

                      for (const rawId of rawIds) {
                        if (graphNodeIdSet.has(rawId)) {
                          matchedIds.add(rawId);
                        } else {
                          const found = deps.graph.nodes.find(
                            (n) => n.id.endsWith(rawId) || n.id.endsWith(':' + rawId),
                          )?.id;
                          if (found) {
                            matchedIds.add(found);
                          }
                        }
                      }

                      if (matchedIds.size > 0) {
                        deps.setAIToolHighlightedNodeIds(matchedIds);
                      }
                    } else if (rawIds.length > 0) {
                      deps.setAIToolHighlightedNodeIds(new Set(rawIds));
                    }
                  }

                  // Parse impact marker from tool results
                  const impactMatch = tc.result.match(/\[IMPACT:([^\]]+)\]/);
                  if (impactMatch) {
                    const rawIds = impactMatch[1]
                      .split(',')
                      .map((id: string) => id.trim())
                      .filter(Boolean);
                    if (rawIds.length > 0 && deps.graph) {
                      const matchedIds = new Set<string>();
                      const graphNodeIdSet = new Set(deps.graph.nodes.map((n) => n.id));

                      for (const rawId of rawIds) {
                        if (graphNodeIdSet.has(rawId)) {
                          matchedIds.add(rawId);
                        } else {
                          const found = deps.graph.nodes.find(
                            (n) => n.id.endsWith(rawId) || n.id.endsWith(':' + rawId),
                          )?.id;
                          if (found) {
                            matchedIds.add(found);
                          }
                        }
                      }

                      if (matchedIds.size > 0) {
                        deps.setBlastRadiusNodeIds(matchedIds);
                      }
                    } else if (rawIds.length > 0) {
                      deps.setBlastRadiusNodeIds(new Set(rawIds));
                    }
                  }
                }
              }
              break;

            case 'error':
              setAgentError(chunk.error ?? 'Unknown error');
              break;

            case 'done':
              // Finalize the assistant message - just call updateMessage one more time
              scheduleMessageUpdate();
              break;
          }
        };

        // Stream agent response using the full streaming generator
        // (handles reasoning, tool_call, tool_result, content, and done events)
        const agent = agentRef.current;
        if (!agent) throw new Error('Agent not initialized');
        const { streamAgentResponse } = await import('../../core/llm/agent');
        for await (const chunk of streamAgentResponse(agent, history)) {
          onChunk(chunk);
        }
        onChunk({ type: 'done' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAgentError(message);
      } finally {
        setIsChatLoading(false);
        setCurrentToolCalls([]);
      }
    },
    [chatMessages, isAgentReady, initializeAgent, deps],
  );

  const stopChatResponse = useCallback(() => {
    if (isChatLoading) {
      // Agent streaming will be interrupted by the AbortController in sendChatMessage
      setIsChatLoading(false);
      setCurrentToolCalls([]);
    }
  }, [isChatLoading]);

  const clearChat = useCallback(() => {
    setChatMessages([]);
    setCurrentToolCalls([]);
    setAgentError(null);
  }, []);

  const value: ChatStateContextValue = {
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
    // Internal setters exposed for AppStateProviderInner (switchRepo)
    setIsAgentReady,
    setAgentError,
    setChatMessages,
    agentRef,
  };

  return <ChatStateContext.Provider value={value}>{children}</ChatStateContext.Provider>;
};

export const useChatState = (): ChatStateContextValue => {
  const ctx = useContext(ChatStateContext);
  if (!ctx) {
    throw new Error('useChatState must be used within a ChatStateProvider');
  }
  return ctx;
};
