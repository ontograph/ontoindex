import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildChatRequest,
  classifyOverall,
  extractInspectEvidence,
  extractTranscriptLocateMetadata,
  gradeModelRun,
  isFallbackLocateTool,
  isGraphLocateTool,
  parseArgs,
  runSmoke,
  validateInspectArguments,
} from '../../scripts/kimi-k3-mcp-smoke.mjs';

const repoPath = parseArgs([]).repoPath;
const toolText = JSON.stringify({
  repoLabel: 'ontoindex',
  repoPath,
  symbol: {
    name: 'createMCPServer',
    filePath: 'ontoindex/src/mcp/server.ts',
    startLine: 294,
    endLine: 536,
  },
});

describe('Kimi K3 MCP smoke harness', () => {
  it('accepts only the exact inspect arguments', () => {
    expect(
      validateInspectArguments({
        action: 'context',
        repo: 'ontoindex',
        name: 'createMCPServer',
        include_content: false,
        limit: 5,
      }),
    ).toBe(true);
    expect(
      validateInspectArguments({
        action: 'context',
        repo: 'codex',
        name: 'createMCPServer',
        include_content: false,
        limit: 5,
      }),
    ).toBe(false);
  });

  it('extracts the repository and symbol evidence', () => {
    expect(extractInspectEvidence(toolText)).toEqual({
      repoLabel: 'ontoindex',
      repoPath,
      symbolName: 'createMCPServer',
      filePath: 'ontoindex/src/mcp/server.ts',
      startLine: 294,
      endLine: 536,
    });
  });

  it('ignores the standard MCP next-step hint after structured JSON', () => {
    expect(
      extractInspectEvidence(`${toolText}\n\n---\n**Next:** inspect another symbol`),
    ).toMatchObject({
      repoLabel: 'ontoindex',
      symbolName: 'createMCPServer',
      filePath: 'ontoindex/src/mcp/server.ts',
    });
  });

  it('adds Kimi reasoning effort only for kimi-k3', () => {
    const request = buildChatRequest({ model: 'kimi-k3', messages: [], requireTool: true });
    expect(request).toMatchObject({
      tool_choice: 'required',
      reasoning_effort: 'max',
    });
    expect(request.tools[0].function).not.toHaveProperty('strict');
    expect(
      buildChatRequest({ model: 'control-model', messages: [], requireTool: true }),
    ).not.toHaveProperty('reasoning_effort');
  });

  it('passes only when the single MCP response grounds the final answer', () => {
    const result = gradeModelRun({
      requestedModel: 'kimi-k3',
      effectiveModel: 'kimi-k3',
      assistantToolMessage: {
        tool_calls: [
          {
            id: 'call-1',
            function: {
              name: 'inspect',
              arguments: JSON.stringify({
                action: 'context',
                repo: 'ontoindex',
                name: 'createMCPServer',
                include_content: false,
                limit: 5,
              }),
            },
          },
        ],
      },
      finalMessage: {
        content: 'createMCPServer is defined in ontoindex/src/mcp/server.ts.',
      },
      toolText,
    });

    expect(result.passed).toBe(true);
    expect(result.gates.answerGrounding).toBe(true);
  });

  it('blocks on preflight or control failure and fails only Kimi-specific failures', () => {
    expect(
      classifyOverall({ preflight: { passed: false }, control: null, kimi: null, mcpOnly: false }),
    ).toEqual({ status: 'BLOCKED', failureCategory: 'preflight' });
    expect(
      classifyOverall({
        preflight: { passed: true },
        control: { passed: false },
        kimi: null,
        mcpOnly: false,
      }),
    ).toEqual({ status: 'BLOCKED', failureCategory: 'harness-control' });
    expect(
      classifyOverall({
        preflight: { passed: true },
        control: { passed: true },
        kimi: { passed: false },
        mcpOnly: false,
      }),
    ).toEqual({ status: 'FAIL', failureCategory: 'kimi-model' });
    expect(
      classifyOverall({
        preflight: { passed: true },
        control: null,
        kimi: null,
        mcpOnly: false,
        blockReason: 'credentials missing',
      }),
    ).toEqual({ status: 'BLOCKED', failureCategory: 'model-configuration' });
  });

  it('parses mcp-only mode without requiring credentials', () => {
    expect(parseArgs(['--mcp-only', '--run-id', 'test-run'])).toMatchObject({
      mcpOnly: true,
      runId: 'test-run',
      kimiModel: 'kimi-k3',
    });
  });

  it('runs the control and Kimi loops and writes separate artifacts', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-k3-smoke-'));
    const toolCall = {
      id: 'call-1',
      type: 'function',
      function: {
        name: 'inspect',
        arguments: JSON.stringify({
          action: 'context',
          repo: 'ontoindex',
          name: 'createMCPServer',
          include_content: false,
          limit: 5,
        }),
      },
    };
    const responses = [
      {
        model: 'control-model',
        choices: [{ message: { role: 'assistant', tool_calls: [toolCall] } }],
      },
      {
        model: 'control-model',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'createMCPServer is defined in ontoindex/src/mcp/server.ts.',
            },
          },
        ],
      },
      { model: 'kimi-k3', choices: [{ message: { role: 'assistant', tool_calls: [toolCall] } }] },
      {
        model: 'kimi-k3',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'createMCPServer is defined in ontoindex/src/mcp/server.ts.',
            },
          },
        ],
      },
    ];
    const fetchImpl = async () =>
      new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const fakeClient = {
      callTool: async () => ({ content: [{ type: 'text', text: toolText }] }),
    };

    const result = await runSmoke(
      {
        ...parseArgs(['--run-id', 'mock-pass', '--output-dir', outputDir]),
        controlModel: 'control-model',
        controlBaseUrl: 'https://control.example/v1',
        controlApiKey: 'control-key',
        kimiApiKey: 'kimi-key',
      },
      {
        git: (args: string[]) => {
          if (args[0] === 'rev-parse') return 'head';
          return '';
        },
        readRegistry: async () => [
          {
            name: 'ontoindex',
            path: repoPath,
            lastCommit: 'head',
          },
        ],
        openMcp: async () => ({ client: fakeClient, stderr: [], close: async () => {} }),
        fetchImpl,
        now: () => new Date('2026-07-18T00:00:00.000Z'),
      },
    );

    expect(result.metadata.overall).toEqual({ status: 'PASS', failureCategory: null });
    expect(result.metadata.control?.passed).toBe(true);
    expect(result.metadata.kimi?.passed).toBe(true);
    expect(result.metadata.elapsedMs).toBe(0);
    await expect(fs.readFile(path.join(result.runDir, 'metadata.json'), 'utf8')).resolves.toContain(
      '"status": "PASS"',
    );
    await expect(
      fs.readFile(path.join(result.runDir, 'transcript.json'), 'utf8'),
    ).resolves.toContain('reasoning_effort');
  });

  it('writes a blocked artifact when the control API fails', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-k3-smoke-error-'));
    const fakeClient = {
      callTool: async () => ({ content: [{ type: 'text', text: toolText }] }),
    };
    const result = await runSmoke(
      {
        ...parseArgs(['--run-id', 'control-error', '--output-dir', outputDir]),
        controlModel: 'control-model',
        controlBaseUrl: 'https://control.example/v1',
        controlApiKey: 'control-key',
        kimiApiKey: 'kimi-key',
      },
      {
        git: (args: string[]) => (args[0] === 'rev-parse' ? 'head' : ''),
        readRegistry: async () => [
          {
            name: 'ontoindex',
            path: repoPath,
            lastCommit: 'head',
          },
        ],
        openMcp: async () => ({ client: fakeClient, stderr: [], close: async () => {} }),
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: 'provider unavailable' } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    );

    expect(result.metadata.overall).toEqual({
      status: 'BLOCKED',
      failureCategory: 'harness-control',
    });
    expect(result.metadata.control?.error).toContain('503');
    await expect(fs.readFile(path.join(result.runDir, 'metadata.json'), 'utf8')).resolves.toContain(
      'provider unavailable',
    );
  });

  describe('transcript locate metadata', () => {
    it('identifies graph-first locate mechanism when graph tool is invoked first', () => {
      const transcript = {
        firstResponse: {
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'inspect',
                      arguments: JSON.stringify({ action: 'context' }),
                    },
                  },
                  {
                    id: 'call-2',
                    type: 'function',
                    function: {
                      name: 'rg',
                      arguments: JSON.stringify({ pattern: 'foo' }),
                    },
                  },
                ],
              },
            },
          ],
        },
      };

      const meta = extractTranscriptLocateMetadata(transcript);
      expect(meta).toEqual({
        firstLocateMechanism: 'graph',
        graphLocateCount: 1,
        fallbackLocateCount: 1,
        graphShare: 0.5,
      });
    });

    it('identifies fallback-first locate mechanism when non-graph search/read/shell tool is invoked first', () => {
      const transcript = {
        firstResponse: {
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'server.ts' }),
                    },
                  },
                  {
                    id: 'call-2',
                    type: 'function',
                    function: {
                      name: 'gn_explore',
                      arguments: JSON.stringify({ query: 'server' }),
                    },
                  },
                ],
              },
            },
          ],
        },
      };

      const meta = extractTranscriptLocateMetadata(transcript);
      expect(meta).toEqual({
        firstLocateMechanism: 'fallback',
        graphLocateCount: 1,
        fallbackLocateCount: 1,
        graphShare: 0.5,
      });
    });

    it('handles mixed graph and fallback tool calls with correct counts and share ratio', () => {
      const transcript = {
        firstResponse: {
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  { id: '1', function: { name: 'gn_find_related' } },
                  { id: '2', function: { name: 'rg' } },
                  { id: '3', function: { name: 'inspect' } },
                  { id: '4', function: { name: 'bash' } },
                ],
              },
            },
          ],
        },
      };

      const meta = extractTranscriptLocateMetadata(transcript);
      expect(meta).toEqual({
        firstLocateMechanism: 'graph',
        graphLocateCount: 2,
        fallbackLocateCount: 2,
        graphShare: 0.5,
      });
    });

    it('returns mechanism none for empty/no-tool transcripts', () => {
      expect(extractTranscriptLocateMetadata({})).toEqual({
        firstLocateMechanism: 'none',
        graphLocateCount: 0,
        fallbackLocateCount: 0,
        graphShare: 0,
      });

      const emptyTranscript = {
        firstResponse: {
          choices: [{ message: { role: 'assistant', tool_calls: [] } }],
        },
      };
      expect(extractTranscriptLocateMetadata(emptyTranscript)).toEqual({
        firstLocateMechanism: 'none',
        graphLocateCount: 0,
        fallbackLocateCount: 0,
        graphShare: 0,
      });
    });

    it('returns mechanism malformed for invalid or error transcripts', () => {
      expect(extractTranscriptLocateMetadata(null)).toEqual({
        firstLocateMechanism: 'malformed',
        graphLocateCount: 0,
        fallbackLocateCount: 0,
        graphShare: 0,
      });
      expect(extractTranscriptLocateMetadata({ error: 'timeout' })).toEqual({
        firstLocateMechanism: 'malformed',
        graphLocateCount: 0,
        fallbackLocateCount: 0,
        graphShare: 0,
      });
      expect(extractTranscriptLocateMetadata({ choices: 'invalid' })).toEqual({
        firstLocateMechanism: 'malformed',
        graphLocateCount: 0,
        fallbackLocateCount: 0,
        graphShare: 0,
      });
      expect(
        extractTranscriptLocateMetadata({
          tool_calls: [{ function: { name: 'inspect', arguments: '{invalid-json' } }],
        }),
      ).toEqual({
        firstLocateMechanism: 'malformed',
        graphLocateCount: 0,
        fallbackLocateCount: 0,
        graphShare: 0,
      });
    });

    it('ignores assistant prose or prompts mentioning tools when no tool calls are recorded', () => {
      const transcript = {
        firstResponse: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'I will call inspect and rg to locate createMCPServer in server.ts.',
                tool_calls: [],
              },
            },
          ],
        },
      };

      const meta = extractTranscriptLocateMetadata(transcript);
      expect(meta).toEqual({
        firstLocateMechanism: 'none',
        graphLocateCount: 0,
        fallbackLocateCount: 0,
        graphShare: 0,
      });
    });

    it('treats unknown tool names as neutral to locate counts and mechanism', () => {
      const transcript = {
        tool_calls: [{ name: 'calculator_tool' }, { name: 'inspect' }, { name: 'custom_helper' }],
      };

      const meta = extractTranscriptLocateMetadata(transcript);
      expect(meta).toEqual({
        firstLocateMechanism: 'graph',
        graphLocateCount: 1,
        fallbackLocateCount: 0,
        graphShare: 1,
      });

      const unknownOnly = {
        tool_calls: [{ name: 'custom_helper' }],
      };
      expect(extractTranscriptLocateMetadata(unknownOnly)).toEqual({
        firstLocateMechanism: 'none',
        graphLocateCount: 0,
        fallbackLocateCount: 0,
        graphShare: 0,
      });
    });

    it('calculates denominator and graphShare correctly', () => {
      const transcript3Graph1Fallback = {
        tool_calls: [
          { name: 'inspect' },
          { name: 'gn_explore' },
          { name: 'search' },
          { name: 'rg' },
        ],
      };
      expect(extractTranscriptLocateMetadata(transcript3Graph1Fallback)).toEqual({
        firstLocateMechanism: 'graph',
        graphLocateCount: 3,
        fallbackLocateCount: 1,
        graphShare: 0.75,
      });

      const transcript0Graph2Fallback = {
        tool_calls: [{ name: 'rg' }, { name: 'cat' }],
      };
      expect(extractTranscriptLocateMetadata(transcript0Graph2Fallback)).toEqual({
        firstLocateMechanism: 'fallback',
        graphLocateCount: 0,
        fallbackLocateCount: 2,
        graphShare: 0,
      });
    });

    it('correctly classifies tool identities with helper predicates', () => {
      expect(isGraphLocateTool('inspect')).toBe(true);
      expect(isGraphLocateTool('gn_explore')).toBe(true);
      expect(isGraphLocateTool('ontoindex_search')).toBe(true);
      expect(isGraphLocateTool('rg')).toBe(false);

      expect(isFallbackLocateTool('rg')).toBe(true);
      expect(isFallbackLocateTool('ctx_read')).toBe(true);
      expect(isFallbackLocateTool('bash')).toBe(true);
      expect(isFallbackLocateTool('inspect')).toBe(false);
    });
  });
});
