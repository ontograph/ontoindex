#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const defaultRepoPath = path.resolve(packageRoot, '..');
const defaultCliPath = path.join(packageRoot, 'dist', 'cli', 'index.js');
const defaultTargetFile = 'ontoindex/src/mcp/server.ts';
const defaultOutputDir = path.join(defaultRepoPath, '.ontoindex', 'smoke', 'kimi-k3');
const inspectArguments = Object.freeze({
  action: 'context',
  repo: 'ontoindex',
  name: 'createMCPServer',
  include_content: false,
  limit: 5,
});

const inspectTool = Object.freeze({
  type: 'function',
  function: {
    name: 'inspect',
    description: 'Inspect one symbol in the OntoIndex repository.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'repo', 'name', 'include_content', 'limit'],
      properties: {
        action: { type: 'string', enum: ['context'] },
        repo: { type: 'string', enum: ['ontoindex'] },
        name: { type: 'string', enum: ['createMCPServer'] },
        include_content: { type: 'boolean', enum: [false] },
        limit: { type: 'integer', enum: [5] },
      },
    },
  },
});

const prompt = `Read-only smoke test. Call the inspect tool exactly once with these arguments:
${JSON.stringify(inspectArguments)}

After the tool returns, answer with the repository identity, the createMCPServer symbol evidence,
and one sentence identifying its source path. Do not use any other tool and do not grade the run.`;

export function parseArgs(argv) {
  const options = {
    repoPath: defaultRepoPath,
    repoLabel: 'ontoindex',
    cliPath: defaultCliPath,
    targetFile: defaultTargetFile,
    outputDir: defaultOutputDir,
    kimiModel: process.env.KIMI_MODEL || 'kimi-k3',
    kimiBaseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
    kimiApiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '',
    controlModel: process.env.KIMI_CONTROL_MODEL || '',
    controlBaseUrl: process.env.KIMI_CONTROL_BASE_URL || '',
    controlApiKey: process.env.KIMI_CONTROL_API_KEY || '',
    timeoutMs: parsePositiveInt(process.env.KIMI_SMOKE_TIMEOUT_MS, 120_000),
    runId: '',
    mcpOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--repo':
        options.repoPath = path.resolve(requireValue(argv, ++index, arg));
        break;
      case '--repo-label':
        options.repoLabel = requireValue(argv, ++index, arg);
        break;
      case '--cli':
        options.cliPath = path.resolve(requireValue(argv, ++index, arg));
        break;
      case '--target-file':
        options.targetFile = requireValue(argv, ++index, arg);
        break;
      case '--output-dir':
        options.outputDir = path.resolve(requireValue(argv, ++index, arg));
        break;
      case '--kimi-model':
        options.kimiModel = requireValue(argv, ++index, arg);
        break;
      case '--kimi-base-url':
        options.kimiBaseUrl = requireValue(argv, ++index, arg);
        break;
      case '--control-model':
        options.controlModel = requireValue(argv, ++index, arg);
        break;
      case '--control-base-url':
        options.controlBaseUrl = requireValue(argv, ++index, arg);
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInt(requireValue(argv, ++index, arg), 0);
        break;
      case '--run-id':
        options.runId = requireValue(argv, ++index, arg);
        break;
      case '--mcp-only':
        options.mcpOnly = true;
        break;
      case '--help':
      case '-h':
        return { ...options, help: true };
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.repoPath = path.resolve(options.repoPath);
  options.cliPath = path.resolve(options.cliPath);
  options.outputDir = path.resolve(options.outputDir);
  options.runId = options.runId || new Date().toISOString().replace(/[:.]/g, '-');
  return options;
}

export function validateInspectArguments(value) {
  return (
    isRecord(value) &&
    Object.keys(value).length === Object.keys(inspectArguments).length &&
    value.action === inspectArguments.action &&
    value.repo === inspectArguments.repo &&
    value.name === inspectArguments.name &&
    value.include_content === inspectArguments.include_content &&
    value.limit === inspectArguments.limit
  );
}

export function extractInspectEvidence(toolText) {
  const parsed =
    typeof toolText === 'string' ? JSON.parse(toolText.split('\n\n---\n', 1)[0]) : toolText;
  const symbol = isRecord(parsed.symbol) ? parsed.symbol : {};
  return {
    repoLabel: parsed.repoLabel,
    repoPath: parsed.repoPath,
    symbolName: symbol.name,
    filePath: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  };
}

export function buildChatRequest({ model, messages, requireTool }) {
  return {
    model,
    messages,
    tools: [inspectTool],
    tool_choice: requireTool ? 'required' : 'none',
    max_tokens: 1024,
    ...(model.toLowerCase().includes('kimi-k3') ? { reasoning_effort: 'max' } : {}),
  };
}

export function gradeModelRun({
  requestedModel,
  effectiveModel,
  assistantToolMessage,
  finalMessage,
  toolText,
}) {
  const calls = assistantToolMessage?.tool_calls ?? [];
  const call = calls[0];
  let parsedArguments = null;
  try {
    parsedArguments = call ? JSON.parse(call.function?.arguments ?? '') : null;
  } catch {
    parsedArguments = null;
  }

  let evidence = null;
  try {
    evidence = extractInspectEvidence(toolText);
  } catch {
    evidence = null;
  }

  const gates = {
    modelLaunch:
      requestedModel === 'kimi-k3' ? effectiveModel === 'kimi-k3' : Boolean(effectiveModel),
    toolExposure: true,
    repositoryScope:
      validateInspectArguments(parsedArguments) &&
      evidence?.repoLabel === 'ontoindex' &&
      evidence?.repoPath === defaultRepoPath,
    toolExecution: calls.length === 1 && call?.function?.name === 'inspect' && Boolean(evidence),
    mcpEvidence:
      evidence?.symbolName === 'createMCPServer' && evidence?.filePath === defaultTargetFile,
    answerGrounding:
      typeof finalMessage?.content === 'string' &&
      finalMessage.content.includes('createMCPServer') &&
      finalMessage.content.includes(defaultTargetFile),
    noFallbackOrWrites: calls.length === 1 && call?.function?.name === 'inspect',
    cleanCompletion:
      typeof finalMessage?.content === 'string' && finalMessage.content.trim().length > 0,
  };

  return { gates, passed: Object.values(gates).every(Boolean), evidence, parsedArguments };
}

export function classifyOverall({ preflight, control, kimi, mcpOnly, blockReason = null }) {
  if (!preflight.passed) return { status: 'BLOCKED', failureCategory: 'preflight' };
  if (mcpOnly) return { status: 'BLOCKED', failureCategory: 'model-phase-skipped' };
  if (blockReason) return { status: 'BLOCKED', failureCategory: 'model-configuration' };
  if (!control?.passed) return { status: 'BLOCKED', failureCategory: 'harness-control' };
  if (!kimi?.passed) return { status: 'FAIL', failureCategory: 'kimi-model' };
  return { status: 'PASS', failureCategory: null };
}

export async function runSmoke(options, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const preflight = await runPreflight(options, deps);
  const runDir = path.join(options.outputDir, options.runId);
  await fs.mkdir(runDir, { recursive: true });

  let control = null;
  let kimi = null;
  let mcp = null;
  let blockReason = null;
  const transcript = { control: null, kimi: null };

  if (preflight.passed) {
    try {
      mcp = await (deps.openMcp ?? openMcp)(options);
      const direct = await callInspect(mcp.client);
      preflight.mcp = {
        isError: direct.isError,
        evidence: direct.evidence,
        rawText: direct.text,
        startupStderr: mcp.stderr.join(''),
      };
      preflight.mcpPassed = direct.passed;
      preflight.passed = preflight.passed && direct.passed;
      if (!direct.passed)
        preflight.reason = 'MCP inspect preflight did not return expected evidence';

      if (!options.mcpOnly && preflight.passed) {
        const credentialIssue = validateModelConfig(options);
        if (credentialIssue) {
          blockReason = credentialIssue;
        } else {
          const controlRun = await runModelSafely({
            label: 'control',
            model: options.controlModel,
            baseUrl: options.controlBaseUrl,
            apiKey: options.controlApiKey,
            mcpClient: mcp.client,
            fetchImpl,
            timeoutMs: options.timeoutMs,
          });
          control = controlRun.result;
          transcript.control = controlRun.transcript;

          if (control.passed) {
            const kimiRun = await runModelSafely({
              label: 'kimi',
              model: options.kimiModel,
              baseUrl: options.kimiBaseUrl,
              apiKey: options.kimiApiKey,
              mcpClient: mcp.client,
              fetchImpl,
              timeoutMs: options.timeoutMs,
            });
            kimi = kimiRun.result;
            transcript.kimi = kimiRun.transcript;
          }
        }
      }
    } catch (error) {
      preflight.passed = false;
      preflight.reason = `MCP preflight failed: ${errorMessage(error)}`;
    } finally {
      if (mcp) await mcp.close();
    }
  }

  const overall = classifyOverall({
    preflight,
    control,
    kimi,
    mcpOnly: options.mcpOnly,
    blockReason,
  });
  const metadata = {
    version: 1,
    runId: options.runId,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    elapsedMs: Math.max(0, now().getTime() - startedAt.getTime()),
    repository: {
      path: options.repoPath,
      label: options.repoLabel,
      targetFile: options.targetFile,
    },
    requestedModels: { control: options.controlModel || null, kimi: options.kimiModel },
    effectiveModels: {
      control: control?.effectiveModel ?? null,
      kimi: kimi?.effectiveModel ?? null,
    },
    preflight,
    blockReason,
    control,
    kimi,
    overall,
  };

  await fs.writeFile(path.join(runDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await fs.writeFile(
    path.join(runDir, 'transcript.json'),
    `${JSON.stringify(transcript, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(options.outputDir, 'latest.json'),
    `${JSON.stringify({ runId: options.runId, runDir, overall }, null, 2)}\n`,
  );
  return { metadata, transcript, runDir };
}

async function runPreflight(options, deps) {
  const git = deps.git ?? runGit;
  const registry = deps.readRegistry ?? readRegistry;
  const targetHead = git(['rev-parse', 'HEAD'], options.repoPath);
  const targetFileStatus = git(
    ['status', '--porcelain=v1', '--', options.targetFile],
    options.repoPath,
  );
  const widerStatus = git(['status', '--porcelain=v1'], options.repoPath);
  const entries = await registry();
  const repo = entries.find(
    (entry) => entry.name === options.repoLabel && path.resolve(entry.path) === options.repoPath,
  );
  const indexedHead = repo?.lastCommit ?? null;
  const checks = {
    repositoryIndexed: Boolean(repo),
    headsMatch: indexedHead === targetHead,
    targetFileClean: targetFileStatus.trim() === '',
    cliExists: await exists(options.cliPath),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    targetHead,
    indexedHead,
    targetFileClean: checks.targetFileClean,
    widerWorktreeState: widerStatus.trim() ? 'dirty' : 'clean',
    reason: null,
  };
}

async function readRegistry() {
  const registryPath = path.join(process.env.HOME ?? '', '.ontoindex', 'registry.json');
  return JSON.parse(await fs.readFile(registryPath, 'utf8'));
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function openMcp(options) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.cliPath, 'mcp', '--project', options.repoPath, '--repo', options.repoLabel],
    cwd: options.repoPath,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: 'kimi-k3-ontoindex-smoke', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr, close: () => client.close() };
}

async function callInspect(client) {
  const response = await client.callTool({ name: 'inspect', arguments: inspectArguments });
  const text = textContent(response);
  let evidence = null;
  try {
    evidence = extractInspectEvidence(text);
  } catch {
    evidence = null;
  }
  return {
    isError: response.isError === true,
    passed:
      response.isError !== true &&
      evidence?.repoLabel === 'ontoindex' &&
      evidence?.repoPath === defaultRepoPath &&
      evidence?.symbolName === 'createMCPServer' &&
      evidence?.filePath === defaultTargetFile,
    evidence,
    text,
  };
}

async function runModel({ label, model, baseUrl, apiKey, mcpClient, fetchImpl, timeoutMs }) {
  const messages = [{ role: 'user', content: prompt }];
  const firstRequest = buildChatRequest({ model, messages, requireTool: true });
  const firstResponse = await postChat({
    baseUrl,
    apiKey,
    body: firstRequest,
    fetchImpl,
    timeoutMs,
  });
  const assistantToolMessage = firstResponse.choices?.[0]?.message ?? {};
  const calls = assistantToolMessage.tool_calls ?? [];
  let toolText = '';

  if (calls.length === 1 && calls[0]?.function?.name === 'inspect') {
    let args = null;
    try {
      args = JSON.parse(calls[0].function.arguments);
    } catch {
      args = null;
    }
    if (validateInspectArguments(args)) {
      toolText = textContent(await mcpClient.callTool({ name: 'inspect', arguments: args }));
    }
  }

  const finalMessages = [
    ...messages,
    assistantToolMessage,
    ...calls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: toolText })),
  ];
  const secondRequest = buildChatRequest({ model, messages: finalMessages, requireTool: false });
  const secondResponse = await postChat({
    baseUrl,
    apiKey,
    body: secondRequest,
    fetchImpl,
    timeoutMs,
  });
  const finalMessage = secondResponse.choices?.[0]?.message ?? {};
  const grade = gradeModelRun({
    requestedModel: label === 'kimi' ? 'kimi-k3' : model,
    effectiveModel: firstResponse.model || model,
    assistantToolMessage,
    finalMessage,
    toolText,
  });
  return {
    result: {
      label,
      requestedModel: model,
      effectiveModel: firstResponse.model || model,
      passed: grade.passed,
      gates: grade.gates,
      evidence: grade.evidence,
    },
    transcript: { firstRequest, firstResponse, toolText, secondRequest, secondResponse },
  };
}

async function runModelSafely(options) {
  try {
    return await runModel(options);
  } catch (error) {
    const message = errorMessage(error);
    return {
      result: {
        label: options.label,
        requestedModel: options.model,
        effectiveModel: null,
        passed: false,
        gates: {},
        evidence: null,
        error: message,
      },
      transcript: { error: message },
    };
  }
}

async function postChat({ baseUrl, apiKey, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`Model API ${response.status}: ${JSON.stringify(payload)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function validateModelConfig(options) {
  if (!options.controlModel) return 'KIMI_CONTROL_MODEL is required';
  if (!options.controlBaseUrl) return 'KIMI_CONTROL_BASE_URL is required';
  if (!options.controlApiKey) return 'KIMI_CONTROL_API_KEY is required';
  if (!options.kimiApiKey) return 'KIMI_API_KEY or MOONSHOT_API_KEY is required';
  return null;
}

function textContent(result) {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (fallback > 0) return fallback;
  throw new Error(`Expected a positive integer, received: ${value}`);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function printHelp() {
  console.log(`Usage: npm run smoke:kimi-k3 -- [options]

Required model environment:
  KIMI_CONTROL_MODEL, KIMI_CONTROL_BASE_URL, KIMI_CONTROL_API_KEY
  KIMI_API_KEY or MOONSHOT_API_KEY

Options:
  --mcp-only              Run repository and MCP preflight without model calls
  --output-dir <path>     Artifact directory (default: .ontoindex/smoke/kimi-k3)
  --run-id <id>           Stable artifact subdirectory name
  --control-model <id>    Override KIMI_CONTROL_MODEL
  --control-base-url <u>  Override KIMI_CONTROL_BASE_URL
  --kimi-model <id>       Default: kimi-k3
  --kimi-base-url <url>   Default: https://api.moonshot.ai/v1
  --help                  Show this help
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const { metadata, runDir } = await runSmoke(options);
  console.log(
    `${metadata.overall.status}: ${metadata.overall.failureCategory ?? 'all gates passed'}`,
  );
  console.log(`Artifacts: ${runDir}`);
  process.exitCode =
    metadata.overall.status === 'PASS' ? 0 : metadata.overall.status === 'BLOCKED' ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
