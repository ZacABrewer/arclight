/** Fake fetch shared by the tests. Not exported from index. */

import { readFileSync } from 'node:fs';
import type { FetchLike } from './types.js';

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = (call: RecordedCall) => { status?: number; json?: unknown; body?: string } | undefined;

/**
 * Routes by `METHOD /path` (path relative to the server origin, query ignored) or a function
 * for anything fancier. Unmatched requests answer 404 so a missing route fails loudly.
 */
export function fakeServer(routes: Record<string, unknown>, fallback?: Route): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const key = `${call.method} ${url.pathname}`;
    let answer: { status?: number; json?: unknown; body?: string } | undefined;
    if (key in routes) {
      const value = routes[key];
      answer = typeof value === 'function' ? (value as Route)(call) : { json: value };
    } else {
      answer = fallback?.(call);
    }
    if (!answer) return new Response('not found', { status: 404 });
    const text = answer.json !== undefined ? JSON.stringify(answer.json) : (answer.body ?? '');
    return new Response(text, { status: answer.status ?? 200 });
  };
  return { fetch, calls };
}

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;
}
