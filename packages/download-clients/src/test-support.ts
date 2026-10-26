/** Test support shared by the package's tests. Not exported from the entry point. */

const encoder = new TextEncoder();

export function bytes(...parts: Array<string | Uint8Array>): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? encoder.encode(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A minimal single-file v1 torrent. */
export const V1_TORRENT = bytes(
  'd8:announce22:http://tracker.test/an4:info',
  'd6:lengthi12345e4:name8:test.mkv12:piece lengthi16384e6:pieces20:',
  'A'.repeat(20),
  'ee',
);
/** SHA-1 of V1_TORRENT's info dictionary, computed independently. */
export const V1_TORRENT_HASH = 'b48b1c1182e270fd061acc1c7f322ca0848f9c56';
