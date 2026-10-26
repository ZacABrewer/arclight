import { CdpConnection, type WebSocketFactory } from './cdp.js';
import { detectChallenge, type ChallengeVerdict } from './challenge.js';
import { SolverError } from './errors.js';
import { launchBrowser, type LaunchedBrowser, type LaunchOptions } from './launch.js';
import { SerialQueue } from './queue.js';

export const DEFAULT_SOLVE_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_CLOSE_MS = 300_000;
export const DEFAULT_POLL_INTERVAL_MS = 500;

export interface SolverCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; absent for session cookies. */
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export interface SolveRequest {
  method: 'GET' | 'POST';
  url: string;
  /** `application/x-www-form-urlencoded` body for POST. */
  postData?: string;
  /** Per-request limit; default the solver's timeout. */
  timeoutMs?: number;
  /** Named session (FlareSolverr `session`); default: one reusable tab per host. */
  session?: string;
}

export interface SolveResult {
  url: string;
  status: number;
  html: string;
  /** Lower-cased header names of the final document response. */
  headers: Record<string, string>;
  cookies: SolverCookie[];
  userAgent: string;
  /** A challenge was seen (and passed) on the way. */
  challenged: boolean;
}

export type SolverLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ChallengeSolverOptions {
  executablePath: string;
  userDataDir: string;
  timeoutMs?: number;
  /** Close the browser after this long without work; 0 keeps it open. */
  idleCloseMs?: number;
  pollIntervalMs?: number;
  headless?: boolean;
  /** Test seam: start a browser (default launches `executablePath`). */
  launch?: (opts: LaunchOptions) => Promise<LaunchedBrowser>;
  webSocketFactory?: WebSocketFactory;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: SolverLogLevel, message: string) => void;
}

interface PageHandle {
  targetId: string;
  sessionId: string;
}

interface DocResponse {
  status: number;
  headers: Record<string, string>;
  url: string;
}

interface Browser {
  process: LaunchedBrowser;
  cdp: CdpConnection;
  userAgent: string;
  pages: Map<string, PageHandle>;
}

interface Snapshot {
  title: string;
  url: string;
  ready: string;
  html: string;
}

const SNAPSHOT_EXPRESSION = `JSON.stringify({
  title: document.title || '',
  url: location.href,
  ready: document.readyState,
  html: document.documentElement ? document.documentElement.outerHTML : ''
})`;

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lowerHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObject(raw)) for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null) out[k.toLowerCase()] = String(v);
  return out;
}

/** Headless browsers announce themselves in the UA; present the regular browser's instead. */
export function normalizeUserAgent(ua: string): string {
  return ua.replace(/HeadlessChrome/g, 'Chrome').replace(/\s*Headless\b/g, '');
}

export function toSolverCookie(raw: unknown): SolverCookie | undefined {
  if (!isObject(raw) || typeof raw['name'] !== 'string') return undefined;
  const cookie: SolverCookie = {
    name: raw['name'],
    value: str(raw['value']),
    domain: str(raw['domain']),
    path: str(raw['path'], '/'),
    httpOnly: raw['httpOnly'] === true,
    secure: raw['secure'] === true,
  };
  const expires = raw['expires'];
  if (typeof expires === 'number' && expires > 0 && raw['session'] !== true) cookie.expires = Math.floor(expires);
  if (typeof raw['sameSite'] === 'string') cookie.sameSite = raw['sameSite'];
  return cookie;
}

/**
 * Drives a local Chromium-family browser over the DevTools protocol to get past browser
 * challenges (Cloudflare "Just a moment...", DDoS-Guard). One browser, one request at a time,
 * one reusable tab per host (or per named session) so clearance cookies and JS state carry
 * over; the browser is closed after an idle period and relaunched on demand.
 */
export class ChallengeSolver {
  private readonly opts: ChallengeSolverOptions;
  private readonly queue = new SerialQueue();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private browser: Browser | undefined;
  private starting: Promise<Browser> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sessions = new Set<string>();

  constructor(opts: ChallengeSolverOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.queue.onIdle(() => this.armIdleTimer());
  }

  /** True while a browser process is running. */
  get running(): boolean {
    return this.browser !== undefined;
  }

  /** Requests queued or in progress. */
  get pending(): number {
    return this.queue.size;
  }

  get userAgent(): string | undefined {
    return this.browser?.userAgent;
  }

  /** Load `url` (GET) or submit `postData` to it (POST) and wait until no challenge is shown. */
  solve(req: SolveRequest): Promise<SolveResult> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    return this.queue.run(() => this.solveNow(req));
  }

  createSession(id?: string): string {
    const name = id?.trim() || `arclight-${this.now().toString(36)}-${this.sessions.size + 1}`;
    this.sessions.add(name);
    return name;
  }

  listSessions(): string[] {
    return [...this.sessions];
  }

  async destroySession(id: string): Promise<boolean> {
    if (!this.sessions.delete(id)) return false;
    await this.queue.run(async () => {
      const b = this.browser;
      const page = b?.pages.get(`session:${id}`);
      if (!b || !page) return;
      b.pages.delete(`session:${id}`);
      await b.cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => undefined);
    });
    return true;
  }

  /** Close the browser (pending requests finish first). */
  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    await this.queue.run(() => this.shutdownBrowser());
  }

  // ---- internals ---------------------------------------------------------------------

  private log(level: SolverLogLevel, message: string): void {
    this.opts.log?.(level, message);
  }

  private armIdleTimer(): void {
    const ms = this.opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    if (ms <= 0 || !this.browser) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.queue.size > 0) return;
      this.log('debug', 'closing idle solver browser');
      void this.queue.run(() => this.shutdownBrowser());
    }, ms);
    this.idleTimer.unref?.();
  }

  private async shutdownBrowser(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    if (!b) return;
    await b.cdp.send('Browser.close', {}, undefined, 3000).catch(() => undefined);
    b.cdp.close();
    await b.process.kill().catch(() => undefined);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && !this.browser.cdp.closed) return this.browser;
    this.browser = undefined;
    if (!this.starting) {
      this.starting = this.startBrowser().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async startBrowser(): Promise<Browser> {
    const launch = this.opts.launch ?? launchBrowser;
    this.log('info', `starting solver browser ${this.opts.executablePath}`);
    const process = await launch({
      executablePath: this.opts.executablePath,
      userDataDir: this.opts.userDataDir,
      ...(this.opts.headless !== undefined ? { headless: this.opts.headless } : {}),
    });
    let cdp: CdpConnection;
    try {
      cdp = await CdpConnection.connect(process.wsEndpoint, this.opts.webSocketFactory ? { factory: this.opts.webSocketFactory } : {});
    } catch (err) {
      await process.kill().catch(() => undefined);
      throw err;
    }
    const version = await cdp.send('Browser.getVersion');
    const browser: Browser = { process, cdp, userAgent: normalizeUserAgent(str(version['userAgent'])), pages: new Map() };
    cdp.onClose(() => {
      if (this.browser === browser) this.browser = undefined;
    });
    void process.exited.then(() => cdp.close());
    this.browser = browser;
    return browser;
  }

  private async page(b: Browser, key: string): Promise<PageHandle> {
    const existing = b.pages.get(key);
    if (existing) return existing;
    const { targetId } = await b.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await b.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const handle = { targetId: str(targetId), sessionId: str(sessionId) };
    if (!handle.targetId || !handle.sessionId) throw new SolverError('protocol', 'Browser did not return a page target');
    await b.cdp.send('Page.enable', {}, handle.sessionId);
    await b.cdp.send('Network.enable', {}, handle.sessionId);
    await b.cdp.send('Runtime.enable', {}, handle.sessionId);
    if (b.userAgent) await b.cdp.send('Network.setUserAgentOverride', { userAgent: b.userAgent }, handle.sessionId);
    b.pages.set(key, handle);
    return handle;
  }

  private async evaluate(b: Browser, sessionId: string, expression: string, awaitPromise = false, timeoutMs?: number): Promise<unknown> {
    const res = await b.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId, timeoutMs);
    if (isObject(res['exceptionDetails'])) {
      const ex = res['exceptionDetails'];
      const text = isObject(ex['exception']) ? str(ex['exception']['description'], str(ex['text'])) : str(ex['text']);
      throw new SolverError('protocol', `Page script failed: ${text || 'exception'}`);
    }
    return isObject(res['result']) ? res['result']['value'] : undefined;
  }

  private async snapshot(b: Browser, sessionId: string): Promise<Snapshot | undefined> {
    try {
      const raw = await this.evaluate(b, sessionId, SNAPSHOT_EXPRESSION, false, 10_000);
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined;
      if (!isObject(parsed)) return undefined;
      return { title: str(parsed['title']), url: str(parsed['url']), ready: str(parsed['ready']), html: str(parsed['html']) };
    } catch (err) {
      // Mid-navigation the execution context is torn down; poll again.
      if (err instanceof SolverError && err.code === 'closed') throw err;
      return undefined;
    }
  }

  private async solveNow(req: SolveRequest): Promise<SolveResult> {
    let target: URL;
    try {
      target = new URL(req.url);
    } catch {
      throw new SolverError('bad-request', `"${req.url}" is not a valid URL`);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new SolverError('bad-request', `Unsupported URL scheme ${target.protocol}`);
    const timeoutMs = req.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_SOLVE_TIMEOUT_MS;
    const deadline = this.now() + timeoutMs;
    const b = await this.ensureBrowser();
    const key = req.session && this.sessions.has(req.session) ? `session:${req.session}` : `host:${target.host}`;
    const page = await this.page(b, key);

    const docs = new Map<string, DocResponse>();
    const off = b.cdp.on('Network.responseReceived', (params, sessionId) => {
      if (sessionId !== page.sessionId || params['type'] !== 'Document' || !isObject(params['response'])) return;
      const r = params['response'];
      const frameId = str(params['frameId'], page.targetId);
      docs.set(frameId, { status: typeof r['status'] === 'number' ? r['status'] : 0, headers: lowerHeaders(r['headers']), url: str(r['url']) });
    });
    try {
      const nav = await b.cdp.send('Page.navigate', { url: target.href }, page.sessionId);
      const errorText = str(nav['errorText']);
      if (errorText && errorText !== 'net::ERR_ABORTED') throw new SolverError('navigation', `Cannot load ${target.href}: ${errorText}`);
      const frameId = str(nav['frameId'], page.targetId);

      let challenged = false;
      let verdict: ChallengeVerdict | undefined;
      let snap: Snapshot | undefined;
      let final: Snapshot;
      for (;;) {
        snap = await this.snapshot(b, page.sessionId);
        const doc = docs.get(frameId);
        if (snap) {
          verdict = detectChallenge({
            title: snap.title,
            html: snap.html,
            url: snap.url,
            ...(doc ? { status: doc.status, headers: doc.headers } : {}),
          });
          if (verdict.kind === 'blocked') throw new SolverError('blocked', `${target.host} refused the request (${verdict.reason ?? 'blocked'})`);
          if (verdict.challenge) {
            if (!challenged) this.log('info', `challenge on ${target.host}: ${verdict.reason ?? 'detected'}`);
            challenged = true;
          } else if (snap.ready !== 'loading') {
            final = snap;
            break;
          }
        }
        if (this.now() >= deadline) {
          const hint = verdict?.interactive
            ? ' The page shows an interactive Turnstile challenge, which cannot be solved headlessly: open the site once in the solver browser profile and pass it by hand.'
            : '';
          throw new SolverError('timeout', `Error solving the challenge. Timeout after ${Math.round(timeoutMs / 1000)} seconds.${hint}`);
        }
        await this.sleep(this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      }

      const doc = docs.get(frameId);
      let result: Omit<SolveResult, 'cookies' | 'userAgent' | 'challenged'> = {
        url: final.url || doc?.url || target.href,
        status: doc?.status ?? 200,
        html: final.html,
        headers: doc?.headers ?? {},
      };
      if (req.method === 'POST') result = await this.post(b, page.sessionId, target.href, req.postData ?? '', Math.max(1000, deadline - this.now()));
      const cookiesRes = await b.cdp.send('Network.getCookies', { urls: [result.url, target.href] }, page.sessionId);
      const cookies = (Array.isArray(cookiesRes['cookies']) ? cookiesRes['cookies'] : [])
        .map(toSolverCookie)
        .filter((c): c is SolverCookie => c !== undefined);
      return { ...result, cookies, userAgent: b.userAgent, challenged };
    } finally {
      off();
    }
  }

  /** POST from inside the (now cleared) page so the request carries its cookies and fingerprint. */
  private async post(b: Browser, sessionId: string, url: string, body: string, timeoutMs: number): Promise<Omit<SolveResult, 'cookies' | 'userAgent' | 'challenged'>> {
    const expression = `(async () => {
      const r = await fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: ${JSON.stringify(body)},
        credentials: 'include',
        redirect: 'follow'
      });
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      return JSON.stringify({ status: r.status, url: r.url, headers, body: await r.text() });
    })()`;
    const raw = await this.evaluate(b, sessionId, expression, true, timeoutMs);
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    if (!isObject(parsed)) throw new SolverError('protocol', 'POST from the page returned no result');
    const status = typeof parsed['status'] === 'number' ? parsed['status'] : 0;
    const headers = lowerHeaders(parsed['headers']);
    const html = str(parsed['body']);
    const verdict = detectChallenge({ title: /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '', html, status, headers });
    if (verdict.challenge) throw new SolverError(verdict.kind === 'blocked' ? 'blocked' : 'timeout', `POST to ${url} was answered with a challenge (${verdict.reason ?? 'detected'})`);
    return { url: str(parsed['url'], url), status, html, headers };
  }
}

