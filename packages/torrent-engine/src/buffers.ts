/**
 * Copies bytes into their own exactly-sized allocation. `Buffer.from(buf)` serves copies of up
 * to 32 KiB from a shared 64 KiB pool slab on current Node 24, so one retained 16 KiB block pins
 * the whole slab (and every other block in it). Use this for anything that outlives the call.
 */
export function copyExact(src: Uint8Array): Buffer {
  const out = Buffer.allocUnsafeSlow(src.length);
  out.set(src);
  return out;
}

/** True when `b` is the sole user of its backing store (no copy needed to retain it). */
export function ownsBacking(b: Buffer): boolean {
  return b.byteOffset === 0 && b.buffer.byteLength === b.length;
}
