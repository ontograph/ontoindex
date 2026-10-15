#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalBackend } from '../dist/mcp/local/local-backend.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const questionPath = path.join(scriptDir, 'search-budget-questions.json');
const configs = [
  { label: 'uncapped', options: {} },
  { label: 'max_tokens: 1200', options: { max_tokens: 1200 } },
  { label: 'include_content', options: { include_content: true } },
  {
    label: 'include_content + max_tokens: 1200',
    options: { include_content: true, max_tokens: 1200 },
  },
  {
    label: 'docs policy + max_tokens: 1200',
    options: {
      retrieval_policy: 'graph-with-passive-docs',
      max_tokens: 1200,
    },
  },
];

const argv = process.argv.slice(2);
let projectPath;
let outputPath;
let assertResults = false;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--out') {
    if (!argv[i + 1]) throw new Error('--out requires a path');
    outputPath = argv[++i];
  } else if (argv[i] === '--assert') {
    assertResults = true;
  } else if (argv[i].startsWith('--')) {
    throw new Error(`Unknown option: ${argv[i]}`);
  } else if (projectPath === undefined) {
    projectPath = argv[i];
  } else {
    throw new Error(`Unexpected argument: ${argv[i]}`);
  }
}

const questions = JSON.parse(await fs.readFile(questionPath, 'utf8'));
const backend = new LocalBackend({
  preferredProjectPath: projectPath ?? process.cwd(),
});
await backend.init();

const rows = [];
for (const config of configs) {
  for (const question of questions) {
    const result = await backend.callTool('query', {
      query: question.query,
      limit: 3,
      max_symbols: 3,
      ...config.options,
    });
    const serialized = JSON.stringify(result ?? '');
    const bytes = Buffer.byteLength(serialized, 'utf8');
    const hits = [
      ...(Array.isArray(result?.process_symbols) ? result.process_symbols : []),
      ...(Array.isArray(result?.definitions) ? result.definitions : []),
    ];
    rows.push({
      config: config.label,
      query: question.query,
      expect_file: question.expect_file,
      response_bytes: bytes,
      tokens: Math.ceil(bytes / 4),
      hit: hits.some(
        (item) =>
          typeof item?.filePath === 'string' && item.filePath.endsWith(question.expect_file),
      ),
    });
  }
}

for (const config of configs) {
  const configRows = rows.filter((row) => row.config === config.label);
  const meanTokens = configRows.reduce((sum, row) => sum + row.tokens, 0) / configRows.length;
  const hitRate = configRows.filter((row) => row.hit).length / configRows.length;
  console.log(`\n### ${config.label}`);
  console.log('| Mean tokens | Hit rate |');
  console.log('| ---: | ---: |');
  console.log(`| ${meanTokens.toFixed(1)} | ${(hitRate * 100).toFixed(1)}% |`);
}

if (outputPath) {
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(rows, null, 2)}\n`);
}

if (assertResults) {
  const baseline = rows.filter((row) => row.config === 'uncapped');
  const baselineHitRate = baseline.filter((row) => row.hit).length / baseline.length;
  let failed = false;
  for (const config of configs.filter(({ options }) => options.max_tokens)) {
    const configRows = rows.filter((row) => row.config === config.label);
    const meanTokens = configRows.reduce((sum, row) => sum + row.tokens, 0) / configRows.length;
    const hitRate = configRows.filter((row) => row.hit).length / configRows.length;
    const ceiling = config.options.max_tokens * (config.options.retrieval_policy ? 1.6 : 1.15);
    const reasons = [];
    if (hitRate < baselineHitRate) reasons.push('hit rate below uncapped');
    if (meanTokens > ceiling) reasons.push(`mean tokens ${meanTokens} exceeds ceiling ${ceiling}`);
    if (reasons.length > 0) {
      failed = true;
      console.log(`ASSERT FAIL: ${config.label}: ${reasons.join('; ')}`);
      for (const row of configRows.filter((row) => row.hit === false))
        console.log(JSON.stringify(row));
    }
  }
  if (failed) process.exit(1);
  console.log('ASSERT OK');
}

process.exit(0);
