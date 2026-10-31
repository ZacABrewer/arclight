import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many API tests run real migrations on a fresh SQLite database; under full parallel load
    // the 5 s default is too tight for the heaviest (migrate, backup, audiobook rescans).
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
