// Sub-path hosting: the server can serve the whole app below a prefix such as /arclight
// (ARCLIGHT_BASE_PATH, docs/getting-started/sub-path-hosting.md). The build itself is
// base-agnostic (Vite base './'); the server writes the prefix into each page load as
// <meta name="arclight-base" content="/arclight"> (apps/api/src/spa.ts). No tag (the root,
// the dev server, tests) means "". Every absolute URL the app builds for the server — api
// calls, WebSockets, downloads, the service worker — goes through withBase().

const META_NAME = 'arclight-base';
const VALID = /^(\/[A-Za-z0-9._~-]+)+$/;

/** The base path this page was served under: "/arclight", or "" at the root. */
export function basePath(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): string {
  const content = doc?.querySelector(`meta[name="${META_NAME}"]`)?.getAttribute('content')?.trim() ?? '';
  const value = content.replace(/\/+$/, '');
  return VALID.test(value) && !value.split('/').some((s) => s === '.' || s === '..') ? value : '';
}

/** An app-absolute path ("/api/v1/x") below the base path ("/arclight/api/v1/x"). Full URLs pass through; never pass an already-prefixed path. */
export function withBase(path: string, base: string = basePath()): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  return `${base}${path}`;
}

/** This page's origin plus the base path, without a trailing slash ("https://example.com/arclight"). */
export function appOrigin(origin: string = typeof location === 'undefined' ? '' : location.origin, base: string = basePath()): string {
  return `${origin.replace(/\/+$/, '')}${base}`;
}
