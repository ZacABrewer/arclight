// Registers public/sw.js (offline page, cache-first static assets; /api is never cached).
// Production only: in dev, Vite's module graph and HMR must not be served from a cache.
// Under a base path (lib/base-path.ts) the worker and its scope live below it: /arclight/sw.js, /arclight/.
import { withBase } from './lib/base-path.js';

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(withBase('/sw.js'), { scope: withBase('/') }).catch((err: unknown) => {
      console.warn('Service worker registration failed', err);
    });
  });
}
