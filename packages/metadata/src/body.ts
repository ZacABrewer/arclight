// Capped response reads for the metadata providers: the stream is cancelled as soon as it
// passes the cap (checked per chunk, not after buffering), so a misbehaving endpoint cannot
// stream an endless body into memory. The caller's timeout signal stays attached to the body.

/** Largest JSON document read from a metadata provider. */
export const MAX_METADATA_BYTES = 16 * 1024 * 1024;
/** Largest error body read for its message. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response is larger than ${Math.round(maxBytes / 1024)} KB`);
    this.name = 'BodyTooLargeError';
  }
}

export async function readLimitedText(response: Response, maxBytes = MAX_METADATA_BYTES): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(maxBytes);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(out);
}

/** `readLimitedText` + `JSON.parse` (throws on either). */
export async function readLimitedJson(response: Response, maxBytes = MAX_METADATA_BYTES): Promise<unknown> {
  return JSON.parse(await readLimitedText(response, maxBytes)) as unknown;
}
