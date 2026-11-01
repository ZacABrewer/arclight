/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The app's own screens (server list, add server, settings...). Built into dist/, which
// `cap sync` copies into the native projects. vite.shell.config.ts adds dist/arclight-shell.js.
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: the bundle is served from capacitor://localhost (iOS) and https://localhost (Android).
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: ['es2022', 'safari16', 'chrome100'] },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
