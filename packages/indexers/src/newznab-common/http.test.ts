import { describe, expect, it } from 'vitest';
import { getXml, MAX_XML_BYTES } from './http.js';

// DATA-09: an indexer that streams forever is cut off at the cap.
describe('getXml body cap', () => {
  it('rejects an endless body with bad-response', async () => {
    let sent = 0;
    const fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(ctrl) {
            sent += 1024 * 1024;
            ctrl.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
          },
        }),
        { headers: { 'content-type': 'application/xml' } },
      )) as typeof globalThis.fetch;
    await expect(getXml('https://indexer.example/api?t=caps&apikey=k', { fetch })).rejects.toMatchObject({ code: 'bad-response' });
    expect(sent).toBeLessThan(MAX_XML_BYTES + 4 * 1024 * 1024);
  });
});
