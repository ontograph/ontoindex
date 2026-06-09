import path from 'path';
import { runChecks } from '../checks/runner.js';

function getThrownMessage(value: unknown): unknown {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'message' in value) {
    return value.message;
  }
  return undefined;
}

export async function checkCommand(options?: { repo?: string }): Promise<void> {
  const repoPath = options?.repo ? path.resolve(options.repo) : process.cwd();

  try {
    const results = await runChecks(repoPath);

    if (results.length === 0) {
      console.log('No checks defined.');
      return;
    }

    let allPass = true;
    for (const res of results) {
      const icon = res.success ? '✅' : '❌';
      console.log(`${icon} [${res.id}] ${res.message}`);
      if (!res.success) allPass = false;
    }

    if (!allPass) {
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error(`Check failed: ${getThrownMessage(err)}`);
    process.exit(1);
  }
}
