import { describe, expect, it } from 'vitest';
import { readBody } from '../import-lists/providers/http.js';
import { SourceHttp } from '../migrate/http.js';
import { MAX_TORRENT_FILE_BYTES, readReleaseFile } from './release-file.js';

// DATA-09: remote bodies are read with a byte cap while streaming, so an endless or runaway
// answer stops at the cap instead of filling memory.

/** A response whose body never ends; `pulled` counts the bytes the reader asked for. */
function endless(chunk = 1024 * 1024): { res: Response; pulled: () => number } {
  let n = 0;
  const block = new Uint8Array(chunk);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      n += block.length;
      controller.enqueue(block);
    },
  });
  return { res: new Response(body), pulled: () => n };
}

describe('remote body caps', () => {
  it('stops an endless .torrent at the cap', async () => {
    const { res, pulled } = endless();
    await expect(readReleaseFile(res, 'torrent')).rejects.toMatchObject({ code: 'tooLarge' });
    expect(pulled()).toBeLessThan(MAX_TORRENT_FILE_BYTES + 4 * 1024 * 1024);
  });

  it('accepts a normal .nzb', async () => {
    const bytes = await readReleaseFile(new Response('<nzb/>'), 'usenet');
    expect(Buffer.from(bytes).toString()).toBe('<nzb/>');
  });

  it('maps an endless import-list page to bad-response', async () => {
    await expect(readBody('Some list', endless().res)).rejects.toMatchObject({ name: 'ImportListFetchError', code: 'bad-response' });
  });

  it('maps an endless *arr answer to SOURCE_UNREADABLE', async () => {
    const http = new SourceHttp({ baseUrl: 'http://arr.example.com', appName: 'Sonarr', fetch: async () => endless(8 * 1024 * 1024).res });
    await expect(http.json('/api/v3/series')).rejects.toMatchObject({ code: 'SOURCE_UNREADABLE' });
  });
});
