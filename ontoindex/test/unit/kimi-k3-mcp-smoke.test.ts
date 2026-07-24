import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildChatRequest,
  classifyOverall,
  extractInspectEvidence,
  gradeModelRun,
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
});
