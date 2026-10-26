// Mutating /api/v1 requests become audit actions named `<resource>[.<sub>].<verb>`, derived from
// the route pattern, so new routes are covered without registering anything. A few routes get a
// hand-picked name; noisy or read-only POSTs are skipped (a route can also opt out with
// `config: { audit: false }`).

export const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** `METHOD /pattern` -> action, for names the rule below would get wrong. */
const ACTION_OVERRIDES: Readonly<Record<string, string>> = {
  'POST /auth/logout': 'logout',
  'POST /command': 'command.run',
  'POST /config/import': 'config.import',
  'POST /settings/security/apikey': 'apikey.regenerate',
};

/** Routes (relative to /api/v1) that are never recorded. */
const SKIPPED: ReadonlySet<string> = new Set([
  // Recorded by the auth service itself (login.success / login.failed).
  'POST /auth/login',
  // Plex PIN polling (every few seconds while the sign-in dialog is open).
  'POST /auth/plex/pin',
  'POST /auth/plex/poll',
  // Read-only despite the verb.
  'POST /config/validate',
  'POST /vpn/refresh',
  'POST /system/update/check',
  'POST /system/update/containers/check',
]);

/** Connection tests (`/indexer/test`, `/downloadclient/testall`, `/mediaserver/:id/test`) change nothing. */
const TEST_ROUTE = /\/test(all)?$/;

export function isSkipped(method: string, route: string): boolean {
  return SKIPPED.has(`${method} ${route}`) || TEST_ROUTE.test(route);
}

export interface DescribedAction {
  action: string;
  target: string | null;
}

/** Action name and target for a mutating request on a route pattern (relative to /api/v1). */
export function describeAction(method: string, route: string, params: unknown): DescribedAction {
  const segments = route.split('/').filter((s) => s !== '');
  const statics = segments.filter((s) => !s.startsWith(':') && s !== '*');
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const paramValues = segments
    .filter((s) => s.startsWith(':'))
    .map((s) => p[s.slice(1)])
    .filter((v) => v !== undefined && v !== '')
    .map(String);
  const override = ACTION_OVERRIDES[`${method} ${route}`];
  const resource = statics[0] ?? 'root';
  const rest = statics.slice(1);

  // Every settings page, wherever it lives (/settings/x, /subtitle/settings): settings.update + section.
  const settingsAt = statics.indexOf('settings');
  if (!override && settingsAt >= 0 && (method === 'PUT' || method === 'PATCH')) {
    const section = settingsAt === 0 ? rest.join('.') : statics.filter((s) => s !== 'settings').join('.');
    return { action: 'settings.update', target: [section, ...paramValues].filter((s) => s !== '').join(':') || null };
  }

  let action: string;
  if (override) action = override;
  else if (method === 'DELETE') action = [resource, ...rest, 'delete'].join('.');
  else if (method === 'PUT' || method === 'PATCH') action = [resource, ...rest, 'update'].join('.');
  else if (rest.length > 0) action = [resource, ...rest].join('.');
  else action = paramValues.length > 0 ? `${resource}.action` : `${resource}.create`;
  return { action: action.toLowerCase(), target: paramValues.length > 0 ? paramValues.join(':') : null };
}
