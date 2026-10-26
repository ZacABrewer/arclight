/**
 * Challenge-page detection for pages rendered in the browser. Unlike the HTTP-level check in
 * @arclight/indexers (which only sees a 403/503 response), this looks at what the browser is
 * currently showing: the document title, interstitial markers in the HTML and the
 * `cf-mitigated` header of the last document response.
 */

export interface PageSnapshot {
  title: string;
  html: string;
  url?: string;
  /** Status of the last main-document response, when known. */
  status?: number;
  /** Headers of the last main-document response (any case). */
  headers?: Record<string, string>;
}

export type ChallengeKind = 'cloudflare' | 'ddos-guard' | 'blocked';

export interface ChallengeVerdict {
  challenge: boolean;
  kind?: ChallengeKind;
  /**
   * A Turnstile widget is on the challenge page. Managed challenges often pass on their own in
   * a real browser; interactive ones need a human click and cannot be solved headlessly.
   */
  interactive: boolean;
  /** The signal that decided the verdict (for logs). */
  reason?: string;
}

/** Lower-cased titles of interstitial pages. Data, not logic. */
export const CHALLENGE_TITLES: readonly string[] = [
  'just a moment...',
  'just a moment…',
  'attention required! | cloudflare',
  'checking your browser',
  'please wait...',
  'ddos-guard',
];

/**
 * Lower-cased HTML markers that only appear on challenge interstitials. The bot-management
 * script Cloudflare injects into ordinary pages (`/cdn-cgi/challenge-platform/.../jsd/`) is
 * deliberately not one of them.
 */
export const CHALLENGE_HTML_MARKERS: readonly string[] = [
  '_cf_chl_opt',
  '__cf_chl_tk',
  '__cf_chl_f_tk',
  '__cf_chl_rt_tk',
  'cf-browser-verification',
  'id="challenge-form"',
  'id="challenge-running"',
  'id="challenge-stage"',
];

const DDOS_GUARD_MARKERS: readonly string[] = ['ddos-guard.net/', 'check.ddos-guard'];
const TURNSTILE_MARKERS: readonly string[] = ['challenges.cloudflare.com/turnstile', 'cf-turnstile'];
const BLOCKED_MARKERS: readonly string[] = ['error code: 1020', 'cf-error-code">1020', 'you have been blocked'];

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

export function detectChallenge(page: PageSnapshot): ChallengeVerdict {
  const title = page.title.trim().toLowerCase();
  const html = page.html.toLowerCase();
  const interactive = TURNSTILE_MARKERS.some((m) => html.includes(m));

  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text === 'error code: 1020' || BLOCKED_MARKERS.some((m) => html.includes(m) && (page.status ?? 403) === 403)) {
    return { challenge: true, kind: 'blocked', interactive: false, reason: 'access denied (1020)' };
  }
  const mitigated = header(page.headers, 'cf-mitigated');
  if (mitigated && mitigated.toLowerCase() === 'challenge') {
    return { challenge: true, kind: 'cloudflare', interactive, reason: 'cf-mitigated: challenge' };
  }
  if (CHALLENGE_TITLES.some((t) => title === t || title.startsWith(t))) {
    const kind: ChallengeKind = title.includes('ddos-guard') ? 'ddos-guard' : 'cloudflare';
    return { challenge: true, kind, interactive, reason: `title "${page.title.trim()}"` };
  }
  const marker = CHALLENGE_HTML_MARKERS.find((m) => html.includes(m));
  if (marker) return { challenge: true, kind: 'cloudflare', interactive, reason: `marker ${marker}` };
  if (DDOS_GUARD_MARKERS.some((m) => html.includes(m)) && (page.status === 403 || page.status === 503)) {
    return { challenge: true, kind: 'ddos-guard', interactive: false, reason: 'ddos-guard interstitial' };
  }
  return { challenge: false, interactive: false };
}
