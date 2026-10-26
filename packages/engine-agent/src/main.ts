// Entry point of the standalone engine agent: `node agent.mjs` (bundled) or
// `tsx src/main.ts` (sources). Configuration comes from the environment; see config.ts.
import { jsonLog, startAgent } from './agent.js';
import { AgentConfigError, parseAgentEnv } from './config.js';

async function main(): Promise<void> {
  let config;
  try {
    config = parseAgentEnv(process.env);
  } catch (error) {
    if (error instanceof AgentConfigError) {
      jsonLog('error', error.message);
      process.exit(2);
    }
    throw error;
  }
  const agent = await startAgent(config);
  let signals = 0;
  const shutdown = (signal: string) => {
    signals++;
    if (signals > 1) {
      jsonLog('warn', 'second signal; exiting without saving', { signal });
      process.exit(1);
    }
    jsonLog('info', 'shutting down', { signal });
    // Resume data is saved by Session.shutdown(); give trackers a bounded time for `stopped`.
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    agent.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        jsonLog('error', 'shutdown failed', { err: String(error) });
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  jsonLog('error', 'engine agent failed to start', { err: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
