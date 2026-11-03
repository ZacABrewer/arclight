// TV mode: the 10-foot layout for Google TV / Android TV. On when the native plugin says the
// device is a TV (leanback / television UI mode), or with `?tv=1` in the address for trying it in
// a browser (`?tv=0` turns that off again). Decided once at start-up (main.tsx); the choice for
// `?tv=` is kept for the browser session so the hash router's navigation does not lose it.

const SESSION_KEY = 'arclight.app.tv';

let tvMode = false;

/** `?tv=1` / `?tv=0` in a query string (search or the part after "?" in the hash). */
export function tvParam(href: string): boolean | null {
  const m = /[?&]tv=([^&#]*)/.exec(href);
  if (!m) return null;
  const v = decodeURIComponent(m[1] ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' ? true : v === '0' || v === 'false' || v === 'no' ? false : null;
}

/** Works out TV mode from the device and the address, remembers it and marks <html>. */
export function decideTvMode(deviceIsTv: boolean, href = typeof location === 'undefined' ? '' : location.href): boolean {
  const param = tvParam(href);
  let stored: string | null = null;
  try {
    if (param !== null) sessionStorage.setItem(SESSION_KEY, param ? '1' : '0');
    stored = sessionStorage.getItem(SESSION_KEY);
  } catch {
    // Blocked storage: the parameter alone decides.
  }
  tvMode = deviceIsTv || param === true || (param === null && stored === '1');
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('tv-mode', tvMode);
  return tvMode;
}

export function isTvMode(): boolean {
  return tvMode;
}

/** Tests. */
export function setTvMode(on: boolean): void {
  tvMode = on;
}
