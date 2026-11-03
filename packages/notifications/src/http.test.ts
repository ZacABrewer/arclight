import { describe, expect, it } from 'vitest';
import { httpRequest, MAX_RESPONSE_BYTES, type FetchLike } from './http.js';

/** A body that never ends (and counts how much was pulled from it). */
function endless(status: number, onPull: (n: number) => void): Response {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 64 * 1024;
      onPull(pulled);
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  return new Response(stream, { status });
}

describe('httpRequest bodies (DATA-09)', () => {
  it('stops reading an endless error body after a few KB', async () => {
    let pulled = 0;
    const fetchImpl: FetchLike = async () => endless(500, (n) => (pulled = n));
    await expect(httpRequest(fetchImpl, 'webhook', 'https://example.com/hook')).rejects.toMatchObject({ code: 'remoteError' });
    expect(pulled).toBeLessThan(1024 * 1024);
  });

  it('refuses an endless success body at the cap instead of buffering it', async () => {
    let pulled = 0;
    const fetchImpl: FetchLike = async () => endless(200, (n) => (pulled = n));
    await expect(httpRequest(fetchImpl, 'webhook', 'https://example.com/hook')).rejects.toMatchObject({ code: 'network' });
    expect(pulled).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 2 * 64 * 1024);
  });

  it('keeps the timeout running while the body is read', async () => {
    const fetchImpl: FetchLike = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 },
      );
    const started = Date.now();
    await expect(httpRequest(fetchImpl, 'webhook', 'https://example.com/hook', { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still hands back small bodies', async () => {
    const fetchImpl: FetchLike = async () => new Response('{"ok":true}', { status: 200 });
    const res = await httpRequest(fetchImpl, 'webhook', 'https://example.com/hook');
    expect(await res.json()).toEqual({ ok: true });
  });
});
