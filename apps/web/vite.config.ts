/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = 'http://localhost:7878';

export default defineConfig({
  plugins: [react()],
  // Absolute asset URLs so deep links (/system/tasks) served by the api's SPA fallback
  // still resolve /assets/* from the root.
  base: '/',
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
  },
});
