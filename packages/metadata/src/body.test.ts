import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { MAX_METADATA_BYTES, readLimitedJson } from './body.js';
import { createJsonTransport } from './http.js';
import { RateLimiter } from './rate-limit.js';

// DATA-09: a provider that streams forever is cut off at the cap.
function endless(counter: { sent: number }): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(ctrl) {
        counter.sent += 1024 * 1024;
        ctrl.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
      },
    }),
  );
}

describe('metadata body cap', () => {
  it('readLimitedJson stops at the cap', async () => {
    const counter = { sent: 0 };
    await expect(readLimitedJson(endless(counter))).rejects.toThrow(/larger than/);
    expect(counter.sent).toBeLessThan(MAX_METADATA_BYTES + 4 * 1024 * 1024);
  });

  it('the JSON transport maps an endless body to bad-response', async () => {
    const counter = { sent: 0 };
    const transport = createJsonTransport({
      label: 'Test',
      providerKey: 'test',
      limiter: new RateLimiter(),
      fetchImpl: async () => endless(counter),
      headers: {},
      timeoutMs: 10_000,
      maxRetries: 0,
      now: () => new Date(0),
      defaultPriority: 'background',
    });
    await expect(transport.get('https://api.example.com/x', z.unknown(), { ttlMs: 0 })).rejects.toMatchObject({ code: 'bad-response' });
    expect(counter.sent).toBeLessThan(MAX_METADATA_BYTES + 4 * 1024 * 1024);
  });
});
