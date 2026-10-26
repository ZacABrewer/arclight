// Client-side preview of the folder the api will create for a new series/movie. Mirrors the
// library service's rule: `<root>/<Title (Year)>`, colons become " - ", characters illegal in
// file names are dropped, trailing dots/spaces trimmed. The server stays the authority; this
// only tells the user where things will land before they press Add.

export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/\s*:\s*/g, ' - ')
    // eslint-disable-next-line no-control-regex -- control characters are illegal in paths
    .replace(/[\\/<>?*|"\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'Untitled';
}

export function folderName(title: string, year: number | null | undefined): string {
  const base = sanitizeFolderName(title);
  return year && year > 0 ? `${base} (${year})` : base;
}

/** Joins with the root's own separator so Windows roots preview with backslashes. */
export function destinationPath(rootFolderPath: string, title: string, year: number | null | undefined): string {
  if (!rootFolderPath) return '';
  const sep = rootFolderPath.includes('\\') && !rootFolderPath.includes('/') ? '\\' : '/';
  const root = rootFolderPath.replace(/[\\/]+$/, '');
  return `${root}${sep}${folderName(title, year)}`;
}
