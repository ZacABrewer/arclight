import type { PathCrumb } from '../../arclight/index.js';

const BS = '\\';

/** Breadcrumbs for a folder listing: "/ › media › tv", "C: › Media", "\\nas\share › tv". */
export function crumbsFor(path: string): PathCrumb[] {
  if (!path) return [{ label: '/', path: '' }];
  const unc = path.startsWith(BS + BS);
  if (unc || /^[A-Za-z]:/.test(path)) {
    const parts = (unc ? path.slice(2) : path).split(/[\\/]/).filter(Boolean);
    const rootCount = unc ? 2 : 1;
    const root = unc ? BS + BS + parts.slice(0, 2).join(BS) : parts[0]!.toUpperCase();
    const crumbs: PathCrumb[] = [{ label: root, path: root + BS }];
    let acc = root;
    for (const part of parts.slice(rootCount)) {
      acc = acc + BS + part;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  const crumbs: PathCrumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of path.split('/').filter(Boolean)) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}
