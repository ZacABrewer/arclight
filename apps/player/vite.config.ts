/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(here, '../web/src');
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')) as { version: string };

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\?.*$/, '');

/**
 * The app reuses the web UI's player (apps/web/src/features/player) and design system
 * (apps/web/src/arclight) as they are. A few web modules assume a same-origin page with a
 * session cookie; they are swapped for app versions at build time, without editing apps/web:
 *
 *   api/client.ts → src/web-shims/api-client.ts (server base URL + Bearer token; artwork URLs
 *                   come back absolute and signed, so the web's <img> code works unchanged)
 *
 * Only relative imports from web modules are swapped; the app's own `@web/api/client` import
 * (for the shared ApiError class) gets the real module. TypeScript still checks the web code
 * against the real modules; the shim keeps their exports.
 */
const SHIMS: Record<string, string> = {
  [norm(resolve(webSrc, 'api/client.ts'))]: resolve(here, 'src/web-shims/api-client.ts'),
};
const SHIM_FILES = new Set(Object.values(SHIMS).map(norm));

function webShims(): Plugin {
  return {
    name: 'arclight-web-shims',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !source.startsWith('.')) return null;
      if (SHIM_FILES.has(norm(importer))) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const shim = SHIMS[norm(resolved.id)];
      return shim ?? null;
    },
  };
}

/** Message key prefixes of the web catalogue the app's screens use (the rest is the admin UI). */
const WEB_KEY_PREFIXES = ['player.', 'arclight.', 'common.', 'queryClient.'];

/**
 * The web's locale files (apps/web/src/i18n/locales/<code>.json) are big; the app keeps only the
 * player / design-system / common keys and adds its own strings (src/i18n/locales/<code>.json,
 * keys under "app."). The web's i18n store then serves both, with English as the fallback.
 */
function appMessages(): Plugin {
  const localeDir = norm(resolve(webSrc, 'i18n/locales'));
  return {
    name: 'arclight-app-messages',
    enforce: 'pre',
    load(id) {
      const file = norm(id);
      if (!file.startsWith(`${localeDir}/`) || !file.endsWith('.json')) return null;
      const code = file.slice(localeDir.length + 1, -'.json'.length);
      const web = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(web)) if (WEB_KEY_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
      const own = resolve(here, `src/i18n/locales/${code}.json`);
      if (existsSync(own)) Object.assign(out, JSON.parse(readFileSync(own, 'utf8')) as Record<string, string>);
      // Still JSON: Vite's json plugin turns it into a module.
      return JSON.stringify(out);
    },
  };
}

/** `vite dev` injects inline scripts (React refresh) that the app's CSP would block. */
function devCsp(): Plugin {
  return {
    name: 'arclight-dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
  };
}

/**
 * The launch intro (redesign spec §6) uses the MP4s and poster the Jellyfin plugin embeds, from
 * design/brand/intro/: one source of truth, no copy in git. The build emits them as dist/intro/*
 * (`cap sync` then puts them in the APK's assets), and `vite dev` serves the same paths.
 */
const INTRO_DIR = resolve(here, '../../design/brand/intro');
const INTRO_FILES: Record<string, string> = {
  'arclight-intro-720p.mp4': 'video/mp4',
  'arclight-intro-1080p.mp4': 'video/mp4',
  'arclight-intro-poster.png': 'image/png',
};

function introAssets(): Plugin {
  return {
    name: 'arclight-intro-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = /^\/intro\/([^/?#]+)/.exec(req.url ?? '')?.[1];
        const type = name ? INTRO_FILES[name] : undefined;
        if (!name || !type || !existsSync(resolve(INTRO_DIR, name))) return next();
        res.setHeader('Content-Type', type);
        res.end(readFileSync(resolve(INTRO_DIR, name)));
      });
    },
    generateBundle() {
      for (const name of Object.keys(INTRO_FILES)) {
        const file = resolve(INTRO_DIR, name);
        if (!existsSync(file)) {
          this.warn(`launch intro: ${name} is missing from design/brand/intro (the app falls back to no intro)`);
          continue;
        }
        this.emitFile({ type: 'asset', fileName: `intro/${name}`, source: readFileSync(file) });
      }
    },
  };
}

// Where `vite dev` proxies /api (enter the dev server's own address in "Add server").
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:7878';

export default defineConfig({
  plugins: [webShims(), appMessages(), devCsp(), introAssets(), react()],
  // Relative asset URLs: the bundle is served from capacitor://localhost (iOS) and https://localhost (Android).
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { '@web': webSrc },
    // One copy of each, whether imported from this package or from apps/web.
    dedupe: ['react', 'react-dom', '@tanstack/react-query', '@tanstack/react-router', 'zod', '@arclight/shared'],
  },
  server: {
    port: 5175,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    fs: { allow: [resolve(here, '../..')] },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: ['es2022', 'safari16', 'chrome100'], chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
