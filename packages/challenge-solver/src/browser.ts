import { existsSync } from 'node:fs';
import path from 'node:path';

export interface BrowserCandidate {
  /** edge | chrome | brave | chromium | custom */
  name: string;
  path: string;
}

export interface FindBrowserOptions {
  /** A path from settings; when set it is the only candidate. */
  configuredPath?: string | undefined;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (file: string) => boolean;
}

const WINDOWS_APPS: ReadonlyArray<[string, string]> = [
  ['edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['chrome', 'Google\\Chrome\\Application\\chrome.exe'],
  ['brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ['chromium', 'Chromium\\Application\\chrome.exe'],
];

const MAC_APPS: ReadonlyArray<[string, string]> = [
  ['edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
];

const LINUX_APPS: ReadonlyArray<[string, string]> = [
  ['edge', '/usr/bin/microsoft-edge'],
  ['edge', '/usr/bin/microsoft-edge-stable'],
  ['chrome', '/usr/bin/google-chrome'],
  ['chrome', '/usr/bin/google-chrome-stable'],
  ['brave', '/usr/bin/brave-browser'],
  ['chromium', '/usr/bin/chromium'],
  ['chromium', '/usr/bin/chromium-browser'],
  ['chromium', '/snap/bin/chromium'],
];

/** Every well-known install location, in preference order (Edge, Chrome, Brave, Chromium). */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): BrowserCandidate[] {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env['ProgramFiles'], env['LOCALAPPDATA']].filter((r): r is string => Boolean(r));
    const out: BrowserCandidate[] = [];
    for (const [name, rel] of WINDOWS_APPS) for (const root of roots) out.push({ name, path: path.win32.join(root, rel) });
    return out;
  }
  const list = platform === 'darwin' ? MAC_APPS : LINUX_APPS;
  return list.map(([name, p]) => ({ name, path: p }));
}

/** The first browser that exists on this machine, or null. */
export function findBrowser(opts: FindBrowserOptions = {}): BrowserCandidate | null {
  const exists = opts.exists ?? existsSync;
  const configured = opts.configuredPath?.trim();
  if (configured) return exists(configured) ? { name: 'custom', path: configured } : null;
  for (const c of browserCandidates(opts.platform, opts.env)) if (exists(c.path)) return c;
  return null;
}
