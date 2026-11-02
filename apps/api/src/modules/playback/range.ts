import type { Stats } from 'node:fs';

// HTTP range handling for the original-file stream (RFC 9110 section 14). One range per request:
// players ask for one, and a multi-range request simply gets the whole file (200), which the RFC
// allows. Validators are an ETag from size and mtime (as common static servers do) plus
// Last-Modified.

export type RangeResult = { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

/** Parses a Range header against a file of `size` bytes. */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'full' };
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return { kind: 'full' };
  const specs = m[1]!.split(',');
  if (specs.length !== 1) return { kind: 'full' };
  const spec = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(specs[0]!);
  if (!spec || (spec[1] === '' && spec[2] === '')) return { kind: 'unsatisfiable' };
  if (spec[1] === '') {
    // Suffix: the last N bytes.
    const n = Number(spec[2]);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(spec[1]);
  const end = spec[2] === '' ? size - 1 : Math.min(Number(spec[2]), size - 1);
  if (start >= size || (spec[2] !== '' && Number(spec[2]) < start)) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end };
}

export function etagOf(stat: Pick<Stats, 'size' | 'mtimeMs'>): string {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/** True when the client's copy is current (If-None-Match, else If-Modified-Since). */
export function notModified(headers: { 'if-none-match'?: string | undefined; 'if-modified-since'?: string | undefined }, etag: string, mtime: Date): boolean {
  const inm = headers['if-none-match'];
  if (inm) return inm.split(',').some((t) => t.trim() === etag || t.trim() === '*');
  const ims = headers['if-modified-since'];
  if (ims) {
    const since = Date.parse(ims);
    return Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000);
  }
  return false;
}

/** If-Range: honour the Range header only while the validator still matches. */
export function rangeStillValid(ifRange: string | undefined, etag: string, mtime: Date): boolean {
  if (!ifRange) return true;
  const v = ifRange.trim();
  if (v.startsWith('"') || v.startsWith('W/')) return v === etag;
  const at = Date.parse(v);
  return Number.isFinite(at) && Math.floor(mtime.getTime() / 1000) === Math.floor(at / 1000);
}
