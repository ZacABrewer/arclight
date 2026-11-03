import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many API tests run real migrations on a fresh SQLite database; under full parallel load
    // the 5 s default is too tight for the heaviest (migrate, backup, audiobook rescans).
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // `pnpm -r test` runs this suite next to the web and player ones. With one worker per core
    // each, the machine runs ~3 workers per core and CPU-bound tests (segment fingerprinting,
    // whole-app injects) took 10-20x their solo time and hit the timeouts above.
    maxWorkers: '50%',
  },
});
