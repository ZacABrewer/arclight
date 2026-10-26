/** Lenient, locale-neutral number parsing for scraped field values (spec S10.4). */

/** Digits with `.`/`,` treated as thousands separators. Empty -> 0; `1.234,5` -> undefined. */
export function parseInteger(raw: string): number | undefined {
  const kept = raw.replace(/[^\d.,]/g, '');
  if (kept === '') return 0;
  // A comma decimal part after dot thousands (`1.234,5`) is not an integer.
  if (/[.,]/.test(kept)) {
    const groups = kept.split(/[.,]/);
    const separators = kept.replace(/\d/g, '');
    const mixed = separators.includes('.') && separators.includes(',');
    if (mixed) return undefined;
    // A single separator followed by 1-2 digits is a decimal mark, not thousands.
    const last = groups[groups.length - 1] ?? '';
    if (groups.length === 2 && last.length !== 3) {
      const value = Math.trunc(Number(kept.replace(',', '.')));
      return Number.isFinite(value) ? value : undefined;
    }
  }
  const value = Number(kept.replace(/[.,]/g, ''));
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Digits, `.` and `,`; comma -> dot; the last dot is the decimal point. Empty -> 0. */
export function parseDecimal(raw: string): number | undefined {
  let kept = raw.replace(/[^\d.,]/g, '').replace(/,/g, '.');
  if (kept === '') return 0;
  const lastDot = kept.lastIndexOf('.');
  if (lastDot >= 0) kept = kept.slice(0, lastDot).replace(/\./g, '') + kept.slice(lastDot);
  const value = Number(kept);
  return Number.isFinite(value) ? value : undefined;
}

/** First contiguous digit run (`tt0133093` -> 133093); none -> 0. */
export function extractId(raw: string): number {
  const match = /\d+/.exec(raw);
  return match ? Number(match[0]) : 0;
}

const UNITS: ReadonlyArray<[string, number]> = [
  ['pb', 1024 ** 5],
  ['tb', 1024 ** 4],
  ['gb', 1024 ** 3],
  ['mb', 1024 ** 2],
  ['kb', 1024],
];

/**
 * Size string to bytes using binary multiples. The letter `i` is ignored so `GiB` == `GB`;
 * bare `B`/`Bytes`/digits are bytes. `1,5 GB` and `1.5 GB` are the same value.
 */
export function parseSize(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const letters = text.toLowerCase().replace(/i/g, '').replace(/[^a-z]/g, '');
  let multiplier = 1;
  for (const [unit, factor] of UNITS) {
    if (letters.includes(unit)) {
      multiplier = factor;
      break;
    }
  }
  if (multiplier === 1) {
    // Short forms such as `1.2 G` or `700M`.
    const unit = /\d\s*([kmgtp])i?b?\s*$/i.exec(text)?.[1]?.toLowerCase();
    const factor = UNITS.find(([u]) => u[0] === unit)?.[1];
    if (factor) multiplier = factor;
  }
  if (!/\d/.test(text)) return undefined;
  const number = parseDecimal(text);
  if (number === undefined) return undefined;
  return Math.trunc(number * multiplier);
}
