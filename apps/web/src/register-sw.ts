// Registers public/sw.js (offline page, cache-first static assets; /api is never cached).
// Production only: in dev, Vite's module graph and HMR must not be served from a cache.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err: unknown) => {
      console.warn('Service worker registration failed', err);
    });
  });
}
