import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NetworkInterfaceInfo } from 'node:os';
import type { ShellResult, ShellRunner } from './shell.js';

// Test-only helpers: recorded command outputs, a scripted shell runner, fake fetch and
// network interface tables. Not used by production code.

const FIXTURES = join(import.meta.dirname, 'fixtures');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export interface ShellCall {
  file: string;
  args: readonly string[];
}

/** A shell runner answering by the first matching rule; records every call. */
export function scriptedShell(rules: Array<{ match: (file: string, args: readonly string[]) => boolean; reply: Partial<ShellResult> | (() => Partial<ShellResult>) }>) {
  const calls: ShellCall[] = [];
  const run: ShellRunner = async (file, args) => {
    calls.push({ file, args });
    const rule = rules.find((r) => r.match(file, args));
    if (!rule) return { code: 1, stdout: '', stderr: `unexpected command ${file}` };
    const reply = typeof rule.reply === 'function' ? rule.reply() : rule.reply;
    return { code: 0, stdout: '', stderr: '', ...reply };
  };
  return { run, calls };
}

export function iface(address: string, family: 'IPv4' | 'IPv6' = 'IPv4'): NetworkInterfaceInfo {
  return family === 'IPv4'
    ? { address, netmask: '255.255.255.255', family, mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/32` }
    : { address, netmask: 'ffff:ffff:ffff:ffff::', family, mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/64`, scopeid: 0 };
}

export interface FakeRequest {
  url: string;
  headers: Headers;
}

/** fetch that routes by URL substring; `reply` may throw to simulate network errors. */
export function fakeFetch(routes: Record<string, (req: FakeRequest) => Response | Promise<Response>>) {
  const requests: FakeRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const req = { url, headers: new Headers(init?.headers) };
    requests.push(req);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    return routes[key]!(req);
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, requests };
}

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
