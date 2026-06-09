import fs from 'fs/promises';
import path from 'path';

async function run() {
  const baselinePath = 'test/bench/baseline.json';
  const currentPath = 'test/bench/current.json';

  try {
    const baselineRaw = await fs.readFile(baselinePath, 'utf8');
    const baseline = JSON.parse(baselineRaw);

    const currentRaw = await fs.readFile(currentPath, 'utf8');
    const currentResults = JSON.parse(currentRaw);

    // Vitest JSON reporter (if it worked) would have a different structure.
    // For this task, we assume a simplified structure that matches baseline.
    // We'll map vitest's real output to this structure in the CI command.

    let failed = false;
    for (const [name, base] of Object.entries(baseline)) {
      const curr = currentResults[name];
      if (!curr) {
        console.warn(`⚠️ Warning: No current results for benchmark "${name}"`);
        continue;
      }

      const regression = (curr.mean - base.mean) / base.mean;
      const status = regression > 0.15 ? '❌ FAIL' : '✅ PASS';

      console.log(
        `${status} ${name}: ${base.mean.toFixed(2)}ms -> ${curr.mean.toFixed(2)}ms (${(regression * 100).toFixed(1)}%)`,
      );

      if (regression > 0.15) {
        failed = true;
      }
    }

    if (failed) {
      console.error('\n🚨 Benchmark regression detected (> 15%)!');
      process.exit(1);
    } else {
      console.log('\n✨ Performance within acceptable limits.');
    }
  } catch (error) {
    console.error(`Error running bench-gate: ${error.message}`);
    process.exit(1);
  }
}

run();
