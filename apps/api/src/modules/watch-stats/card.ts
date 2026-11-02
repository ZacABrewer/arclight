import type { Wrapped } from '@arclight/shared';

// The Year in review image (SVG, 1080 x 1350, a portrait card that fits social feeds) and the
// small public page a share link opens. Both are generated from a Wrapped value; nothing user
// supplied reaches them unescaped.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function hours(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 100) return String(Math.round(h));
  if (h >= 10) return h.toFixed(0);
  return h.toFixed(1).replace(/\.0$/, '');
}

/** Highlights as short lines (shared by the image and the page). */
export function wrappedHighlights(w: Wrapped): string[] {
  const out: string[] = [];
  if (w.topGenres[0]) out.push(`Favourite genre: ${w.topGenres[0].name}`);
  if (w.busiestMonth !== null) out.push(`Busiest month: ${MONTHS_LONG[w.busiestMonth - 1]}`);
  if (w.favouriteWeekday !== null) out.push(`Most plays on ${WEEKDAYS[w.favouriteWeekday]}s`);
  if (w.longestDay) out.push(`Longest day: ${hours(w.longestDay.watchMs)} h on ${w.longestDay.date}`);
  if (w.percentile !== null && w.percentile >= 50) out.push(`Watched more than ${w.percentile}% of viewers`);
  if (w.topDevice) out.push(`Mostly on ${w.topDevice}`);
  return out;
}

export function wrappedSvg(w: Wrapped): string {
  const W = 1080;
  const H = 1350;
  const text = (x: number, y: number, size: number, value: string, opts: { weight?: number; fill?: string; anchor?: string; opacity?: number } = {}) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${opts.fill ?? '#e8f4ff'}"${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''}${
      opts.opacity !== undefined ? ` opacity="${opts.opacity}"` : ''
    }>${escapeXml(value)}</text>`;
  const parts: string[] = [];
  parts.push(
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#071a2b"/><stop offset="1" stop-color="#12233f"/></linearGradient>` +
      `<linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5fd4ff"/><stop offset="1" stop-color="#2a7fd4"/></linearGradient></defs>`,
  );
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
  parts.push(`<rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="36" fill="none" stroke="#5fd4ff" stroke-opacity="0.35" stroke-width="3"/>`);
  parts.push(text(90, 150, 40, 'YEAR IN REVIEW', { weight: 700, fill: '#5fd4ff' }));
  parts.push(text(90, 240, 76, clip(`${w.name}'s ${w.year}`, 24), { weight: 800 }));

  // Headline numbers.
  const stats: [string, string][] = [
    [hours(w.watchMs), 'hours watched'],
    [String(w.plays), 'plays'],
    [String(w.movies), 'movies'],
    [String(w.episodes), 'episodes'],
  ];
  stats.forEach(([value, label], i) => {
    const x = 90 + i * 235;
    parts.push(text(x, 380, 72, value, { weight: 800 }));
    parts.push(text(x, 425, 28, label, { opacity: 0.7 }));
  });

  // Top lists.
  const list = (x: number, title: string, items: string[]) => {
    parts.push(text(x, 530, 32, title, { weight: 700, fill: '#5fd4ff' }));
    if (items.length === 0) parts.push(text(x, 585, 30, '-', { opacity: 0.6 }));
    items.slice(0, 5).forEach((item, i) => parts.push(text(x, 585 + i * 50, 30, `${i + 1}. ${clip(item, 26)}`)));
  };
  list(90, 'Top movies', w.topMovies.map((t) => t.title));
  list(560, 'Top shows', w.topSeries.map((t) => t.title));

  // Monthly bars.
  const chartTop = 880;
  const chartH = 170;
  const max = Math.max(1, ...w.monthly);
  const barW = 58;
  w.monthly.forEach((v, i) => {
    const h = Math.round((v / max) * chartH);
    const x = 90 + i * 76;
    parts.push(`<rect x="${x}" y="${chartTop + chartH - h}" width="${barW}" height="${Math.max(h, 3)}" rx="8" fill="url(#bar)"/>`);
    parts.push(text(x + barW / 2, chartTop + chartH + 40, 22, MONTHS[i]!, { anchor: 'middle', opacity: 0.7 }));
  });

  wrappedHighlights(w)
    .slice(0, 3)
    .forEach((line, i) => parts.push(text(90, 1160 + i * 46, 30, clip(line, 60), { opacity: 0.9 })));
  parts.push(text(W - 90, H - 80, 26, 'Arclight', { anchor: 'end', weight: 700, fill: '#5fd4ff', opacity: 0.8 }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif">${parts.join('')}</svg>`;
}

/** The public page of a share link: the card plus the same facts as text. */
export function wrappedPage(w: Wrapped, opts: { imagePath: string; expiresAt: string }): string {
  const title = `${w.name}'s ${w.year} in review`;
  const rows = [
    `${hours(w.watchMs)} hours watched, ${w.plays} plays`,
    `${w.movies} movies and ${w.episodes} episodes from ${w.series} shows`,
    ...wrappedHighlights(w),
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeXml(title)}</title>
<meta property="og:title" content="${escapeXml(title)}">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #071a2b; color: #e8f4ff; font-family: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  img { width: 100%; height: auto; border-radius: 16px; display: block; }
  h1 { font-size: 1.4rem; margin: 24px 0 8px; }
  ul { padding-left: 1.2rem; line-height: 1.6; }
  p { opacity: 0.7; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
<img src="${escapeXml(opts.imagePath)}" alt="${escapeXml(title)}" width="1080" height="1350">
<h1>${escapeXml(title)}</h1>
<ul>${rows.map((r) => `<li>${escapeXml(r)}</li>`).join('')}</ul>
<p>This link expires on ${escapeXml(opts.expiresAt.slice(0, 10))}.</p>
</main>
</body>
</html>`;
}
