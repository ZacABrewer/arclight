import { describe, expect, it } from 'vitest';
import { MAX_RPC_BYTES, readBodyText } from './body.js';
import { SabnzbdClient } from './sabnzbd/client.js';
import { SabnzbdSettings } from './sabnzbd/settings.js';
import { DownloadClientError, type ClientRuntime } from './types.js';

// DATA-09: a client address that streams forever is cut off at the cap.
function endless(counter: { sent: number }): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(ctrl) {
        counter.sent += 1024 * 1024;
        ctrl.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
      },
    }),
    { status: 500 },
  );
}

describe('RPC body cap', () => {
  it('readBodyText stops at the cap with bad-response', async () => {
    const counter = { sent: 0 };
    await expect(readBodyText('X', endless(counter))).rejects.toMatchObject({ code: 'bad-response' });
    expect(counter.sent).toBeLessThan(MAX_RPC_BYTES + 4 * 1024 * 1024);
  });

  it('a client call fails instead of buffering an endless error body', async () => {
    const counter = { sent: 0 };
    const runtime: ClientRuntime = { fetch: (async () => endless(counter)) as typeof fetch, now: () => 0, sleep: async () => {}, requestTimeoutMs: 10_000 };
    const client = new SabnzbdClient(SabnzbdSettings.parse({ host: 'sab.example', apiKey: 'k' }), runtime);
    const err = await client.test().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DownloadClientError);
    expect(counter.sent).toBeLessThan(MAX_RPC_BYTES + 4 * 1024 * 1024);
  });
});
