// The app's own screens, addressed by the URL hash so the server page can send people back to a
// specific one (switchServer -> #/servers, Android error page -> #/unreachable).

export type Route =
  | { name: 'auto' }
  | { name: 'servers' }
  | { name: 'add'; url?: string }
  | { name: 'edit'; id: string }
  | { name: 'unreachable' }
  | { name: 'settings' }
  | { name: 'about' }
  | { name: 'licenses' };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = h.split('?');
  const params = new URLSearchParams(query);
  const [head, arg] = path.split('/');
  switch (head) {
    case 'servers':
      return { name: 'servers' };
    case 'add': {
      const url = params.get('url');
      return url ? { name: 'add', url } : { name: 'add' };
    }
    case 'edit':
      return arg ? { name: 'edit', id: decodeURIComponent(arg) } : { name: 'servers' };
    case 'unreachable':
      return { name: 'unreachable' };
    case 'settings':
      return { name: 'settings' };
    case 'about':
      return { name: 'about' };
    case 'licenses':
      return { name: 'licenses' };
    default:
      return { name: 'auto' };
  }
}

export function routeHash(r: Route): string {
  switch (r.name) {
    case 'auto':
      return '#/';
    case 'add':
      return r.url ? `#/add?url=${encodeURIComponent(r.url)}` : '#/add';
    case 'edit':
      return `#/edit/${encodeURIComponent(r.id)}`;
    default:
      return `#/${r.name}`;
  }
}
