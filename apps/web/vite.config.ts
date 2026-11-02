/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Where the dev server proxies /api. Override when 7878 is taken locally, e.g.
// `VITE_API_TARGET=http://localhost:17895 pnpm --filter @arclight/web dev`.
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:7878';

export default defineConfig({
  plugins: [react()],
  // Relative URLs so one build works under any base path chosen at runtime (ARCLIGHT_BASE_PATH):
  // the api's SPA fallback rewrites index.html's "./" URLs to "<base>/" (apps/api/src/spa.ts),
  // so deep links (/system/tasks) still load /assets/*; chunks and CSS resolve relative to
  // their own files.
  base: './',
  server: {
    port: 5173,
    proxy: {
      // REST and the /api/v1/events WebSocket both go to the api in dev.
      '/api': { target: apiTarget, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Route-level page tests chain several 10 s findBy waits (see src/test/setup.ts).
    testTimeout: 30000,
    // jsdom page tests are CPU-heavy; one worker per core starves them on many-core machines.
    maxWorkers: '50%',
  },
});
