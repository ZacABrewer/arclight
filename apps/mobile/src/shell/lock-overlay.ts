import { verifyBiometric } from '../platform/handlers.js';

// The biometric lock inside a server page: a full-screen cover (in a closed shadow root so the
// page's styles cannot reach it) until Face ID / Touch ID / fingerprint succeeds.

export async function showLockOverlay(): Promise<void> {
  const host = document.createElement('arclight-lock');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:block;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;
        background:linear-gradient(160deg,#0b1830,#02070a);color:#e9fdff;font:17px -apple-system,system-ui,Roboto,sans-serif;
        padding:env(safe-area-inset-top) 24px env(safe-area-inset-bottom);text-align:center}
      svg{width:72px;height:72px}
      h1{margin:0;font-size:22px;letter-spacing:.04em}
      button{font:inherit;font-weight:600;color:#02070a;background:#6ef6ff;border:0;border-radius:12px;padding:14px 28px;min-height:48px}
    </style>
    <div class="wrap" role="dialog" aria-modal="true" aria-label="Arclight is locked">
      <svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#2f7bff"/><stop offset="1" stop-color="#6ef6ff"/></linearGradient></defs>
        <path d="M48,22 L76,50 L48,78" fill="none" stroke="url(#g)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity=".45"/>
        <path d="M24,22 L52,50 L24,78" fill="none" stroke="url(#g)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <h1>Arclight is locked</h1>
      <button type="button">Unlock</button>
    </div>`;
  (document.body ?? document.documentElement).appendChild(host);
  const button = root.querySelector('button')!;
  try {
    for (;;) {
      if (await verifyBiometric('Unlock to continue')) return;
      await new Promise<void>((resolve) => button.addEventListener('click', () => resolve(), { once: true }));
    }
  } finally {
    host.remove();
  }
}
