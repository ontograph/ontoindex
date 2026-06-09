import { createServer } from '../server/api.js';

function getThrownField(value: unknown, field: 'code' | 'message' | 'stack'): unknown {
  if (value && (typeof value === 'object' || typeof value === 'function') && field in value) {
    return value[field];
  }
  return undefined;
}

// Catch anything that would cause a silent exit
process.on('uncaughtException', (err) => {
  console.error('\n[ontoindex serve] Uncaught exception:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  console.error(
    '\n[ontoindex serve] Unhandled rejection:',
    getThrownField(reason, 'message') || reason,
  );
  if (process.env.DEBUG) console.error(getThrownField(reason, 'stack'));
  process.exit(1);
});

export const serveCommand = async (options?: { port?: string; host?: string }) => {
  const port = Number(options?.port ?? 4747);
  // Default to 'localhost' so the OS decides whether to bind to 127.0.0.1 or
  // ::1 based on system configuration, avoiding spurious CORS errors when the
  // hosted frontend at ontoindex.vercel.app connects to localhost.
  const host = options?.host ?? 'localhost';

  try {
    await createServer(port, host);
  } catch (err: unknown) {
    console.error(`\nFailed to start OntoIndex server:\n`);
    console.error(`  ${getThrownField(err, 'message') || err}\n`);
    if (getThrownField(err, 'code') === 'EADDRINUSE') {
      console.error(`  Port ${port} is already in use. Either:`);
      console.error(`    1. Stop the other process using port ${port}`);
      console.error(`    2. Use a different port: ontoindex serve --port 4748\n`);
    }
    const stack = getThrownField(err, 'stack');
    if (stack && process.env.DEBUG) {
      console.error(stack);
    }
    process.exit(1);
  }
};
