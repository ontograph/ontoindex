/**
 * Augment CLI Command
 *
 * Fast-path command for platform hooks.
 * Shells out from Claude Code PreToolUse / Cursor beforeShellExecution hooks.
 *
 * Usage: ontoindex augment <pattern>
 * Returns sentinel-framed enriched text to stderr.
 *
 * Performance: Must cold-start fast (<500ms).
 * Skips unnecessary initialization (no web server, no full DB warmup).
 */

import { augment } from '../core/augmentation/engine.js';

const AUGMENT_FRAME_START = '<<<ONTOINDEX_AUGMENTATION_V1>>>';
const AUGMENT_FRAME_END = '<<<END_ONTOINDEX_AUGMENTATION_V1>>>';

export async function augmentCommand(pattern: string): Promise<void> {
  if (!pattern || pattern.length < 3) {
    process.exit(0);
  }

  try {
    const result = await augment(pattern, process.cwd());

    if (result) {
      // IMPORTANT: Write to stderr, NOT stdout.
      // LadybugDB's native module captures stdout fd at OS level during init,
      // which makes stdout permanently broken in subprocess contexts.
      // stderr is never captured, so it works reliably everywhere.
      // The hook reads from the subprocess's stderr.
      process.stderr.write(`${AUGMENT_FRAME_START}\n${result}\n${AUGMENT_FRAME_END}\n`);
    }
  } catch {
    // Graceful failure — never break the calling hook
    process.exit(0);
  }
}
