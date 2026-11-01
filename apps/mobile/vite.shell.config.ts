import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// dist/arclight-shell.js: one self-contained IIFE that the native layer injects at document
// start into pages of the user's saved servers. It defines window.Capacitor.Plugins.ArclightShell.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version), 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    target: ['es2022', 'safari16', 'chrome100'],
    lib: { entry: 'src/shell/entry.ts', formats: ['iife'], name: 'ArclightShellBundle', fileName: () => 'arclight-shell.js' },
  },
});
