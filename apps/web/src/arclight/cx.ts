/** Join class names, skipping falsy values. (Local copy so arclight/ stays self-contained.) */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ');
}
