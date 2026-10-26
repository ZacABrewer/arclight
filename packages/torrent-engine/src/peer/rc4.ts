/**
 * RC4 stream cipher, as used by Message Stream Encryption. MSE discards the first 1024
 * keystream bytes of each direction (`discard`).
 */
export class RC4 {
  private readonly s = new Uint8Array(256);
  private i = 0;
  private j = 0;

  constructor(key: Uint8Array, discard = 0) {
    if (key.length === 0 || key.length > 256) throw new RangeError('RC4 key must be 1..256 bytes');
    const s = this.s;
    for (let n = 0; n < 256; n++) s[n] = n;
    let j = 0;
    for (let n = 0; n < 256; n++) {
      const sn = s[n] as number;
      j = (j + sn + (key[n % key.length] as number)) & 0xff;
      s[n] = s[j] as number;
      s[j] = sn;
    }
    if (discard > 0) this.skip(discard);
  }

  /** Advances the keystream by `n` bytes without producing output. */
  skip(n: number): void {
    const s = this.s;
    let i = this.i;
    let j = this.j;
    for (let k = 0; k < n; k++) {
      i = (i + 1) & 0xff;
      const si = s[i] as number;
      j = (j + si) & 0xff;
      s[i] = s[j] as number;
      s[j] = si;
    }
    this.i = i;
    this.j = j;
  }

  /** Encrypts or decrypts `data` (XOR with the keystream) into a new buffer. */
  update(data: Uint8Array): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    const s = this.s;
    let i = this.i;
    let j = this.j;
    for (let k = 0; k < data.length; k++) {
      i = (i + 1) & 0xff;
      const si = s[i] as number;
      j = (j + si) & 0xff;
      const sj = s[j] as number;
      s[i] = sj;
      s[j] = si;
      out[k] = (data[k] as number) ^ (s[(si + sj) & 0xff] as number);
    }
    this.i = i;
    this.j = j;
    return out;
  }
}
