import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SolverError } from './errors.js';

export const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
const PORT_FILE = 'DevToolsActivePort';
const LISTENING = /DevTools listening on (ws:\/\/\S+)/;

export interface LaunchOptions {
  executablePath: string;
  /** Dedicated profile directory (created if missing); never the user's everyday profile. */
  userDataDir: string;
  /** Default true (`--headless=new`). False shows a window (e.g. to pass a Turnstile by hand). */
  headless?: boolean;
  /** Initial page; default about:blank. */
  startUrl?: string;
  extraArgs?: readonly string[];
  timeoutMs?: number;
  /** Test seam. */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

export interface LaunchedBrowser {
  /** Browser-level DevTools WebSocket URL. */
  wsEndpoint: string;
  pid: number | undefined;
  /** Resolves when the process exits. */
  exited: Promise<void>;
  /** Terminate the process (gracefully, then forcibly). */
  kill(): Promise<void>;
}

/** The ws:// URL from a `DevTools listening on ...` stderr line, if the text contains one. */
export function parseDevToolsListening(text: string): string | undefined {
  return LISTENING.exec(text)?.[1];
}

/** `DevToolsActivePort` holds the port on line 1 and the browser target path on line 2. */
export function parseDevToolsActivePort(text: string, host = '127.0.0.1'): string | undefined {
  const [portLine, pathLine] = text.split(/\r?\n/);
  const port = Number(portLine?.trim());
  const target = pathLine?.trim();
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !target?.startsWith('/devtools/browser/')) return undefined;
  return `ws://${host}:${port}${target}`;
}

export function browserArgs(opts: Pick<LaunchOptions, 'userDataDir' | 'headless' | 'startUrl' | 'extraArgs'>): string[] {
  const args = [
    `--user-data-dir=${opts.userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-blink-features=AutomationControlled',
    '--mute-audio',
    '--window-size=1366,768',
  ];
  if (opts.headless !== false) args.push('--headless=new');
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  args.push(...(opts.extraArgs ?? []));
  args.push(opts.startUrl ?? 'about:blank');
  return args;
}

/**
 * Start a Chromium-family browser with remote debugging on an ephemeral port and resolve its
 * DevTools endpoint, read from whichever comes first: the `DevTools listening on` stderr line
 * or the `DevToolsActivePort` file the browser writes into the profile directory.
 */
export async function launchBrowser(opts: LaunchOptions): Promise<LaunchedBrowser> {
  mkdirSync(opts.userDataDir, { recursive: true });
  const portFile = path.join(opts.userDataDir, PORT_FILE);
  rmSync(portFile, { force: true });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const doSpawn = opts.spawnImpl ?? ((cmd, args, o) => spawn(cmd, args, o));
  let child: ChildProcess;
  try {
    child = doSpawn(opts.executablePath, browserArgs(opts), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (err) {
    throw new SolverError('launch', `Cannot start ${opts.executablePath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  let exitedResolve!: () => void;
  const exited = new Promise<void>((resolve) => (exitedResolve = resolve));
  let hasExited = false;
  child.once('exit', () => {
    hasExited = true;
    exitedResolve();
  });

  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const finish = (err: Error | undefined, url?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      if (err) reject(err);
      else resolve(url as string);
    };
    const onData = (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
      const url = parseDevToolsListening(stderr);
      if (url) finish(undefined, url);
    };
    child.stderr?.on('data', onData);
    child.once('error', (err) => finish(new SolverError('launch', `Cannot start ${opts.executablePath}: ${err.message}`, { cause: err })));
    child.once('exit', (code) =>
      finish(new SolverError('launch', `Browser exited (code ${code ?? 'null'}) before DevTools was ready${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`)),
    );
    const poll = setInterval(() => {
      try {
        const url = parseDevToolsActivePort(readFileSync(portFile, 'utf8'));
        if (url) finish(undefined, url);
      } catch {
        // not written yet
      }
    }, 100);
    const timer = setTimeout(() => finish(new SolverError('launch', `Browser did not report a DevTools endpoint within ${timeoutMs} ms`)), timeoutMs);
  }).catch((err: unknown) => {
    if (!hasExited) child.kill();
    throw err;
  });
  // Keep draining stderr so a chatty browser never blocks on a full pipe.
  child.stderr?.resume();

  const kill = async (): Promise<void> => {
    if (hasExited) return;
    child.kill();
    const forced = setTimeout(() => {
      if (!hasExited) child.kill('SIGKILL');
    }, 3000);
    await exited;
    clearTimeout(forced);
  };
  return { wsEndpoint, pid: child.pid, exited, kill };
}
