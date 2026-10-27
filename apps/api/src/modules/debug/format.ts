// Plain-text formatting for console output: monospace tables that survive a paste.

export function mib(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

/** Human size: B, KiB, MiB, GiB. */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  if (abs < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
  if (abs < 1073741824) return `${(n / 1048576).toFixed(1)} MiB`;
  return `${(n / 1073741824).toFixed(2)} GiB`;
}

export function rate(bytesPerSecond: number): string {
  return `${bytes(Math.round(bytesPerSecond))}/s`;
}

export function duration(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : '', `${s % 60}s`].filter(Boolean);
  return parts.slice(0, 3).join(' ');
}

/** Two-column key/value block, keys padded to the widest. Undefined values are skipped. */
export function kv(rows: ReadonlyArray<readonly [string, string | number | boolean | null | undefined]>, indent = '  '): string {
  const present = rows.filter(([, v]) => v !== undefined);
  const width = Math.max(0, ...present.map(([k]) => k.length));
  return present.map(([k, v]) => `${indent}${k.padEnd(width)}  ${v === null ? '—' : String(v)}`).join('\n');
}

/** Fixed-width table; numbers right-aligned. */
export function table(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>, indent = '  '): string {
  const cells = rows.map((r) => r.map(String));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)));
  const numeric = headers.map((_h, i) => rows.length > 0 && rows.every((r) => typeof r[i] === 'number'));
  const line = (r: readonly string[]) =>
    indent +
    r
      .map((c, i) => (numeric[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...cells.map(line)].join('\n');
}

export function hexToAscii(hex: string): string {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return out;
}

export function spacedHex(hex: string): string {
  return hex.replace(/(..)(?!$)/g, '$1 ');
}
