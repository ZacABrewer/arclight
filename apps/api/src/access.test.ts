import type { RouteOptions } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { Permission, SecuritySettings, type AppArea, type ServerEvent } from '@arclight/shared';
import { buildApp, type AppContext } from './app.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { createTestDb, seedAdmin } from './db/test-utils.js';
import { authServiceFor, isPublicRoute, SESSION_COOKIE, type RouteAccess } from './modules/auth/index.js';
import { profileMay } from './modules/auth/hook.js';
import { COMPAT_PUBLIC_ROUTES } from './modules/compat/index.js';
import { eventVisibleTo, type EventOwners, type EventViewer } from './modules/events/index.js';
import { setSection } from './modules/settings/service.js';

// Who besides admins can reach what. The route table below is the explicit allow-list of every
// route a non-admin (or an anonymous visitor) can reach; every other route is admin-only by
// default. A new route that opens itself (config.access, publicWhen, a public path) without
// being added here fails the first test, and a route listed here that disappears or changes
// its access fails it too. Then HTTP checks per category for a portal user, an app-access
// user and the first-run setup gate, and the live event feed filter.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

/**
 * Every route reachable without admin rights, as `METHOD url` → how. `portal`: any signed-in
 * user (the service scopes the work to the caller); `publicWhen`: also anonymous while the
 * public request portal allows it; `areas:`: read-only with that app access; `perms:`: read-only
 * with one of those permission bits; `public`: no credentials at all.
 */
const NON_ADMIN_ROUTES: Record<string, string> = {
  // ---- public (no credentials; each checks its own token or only signs in)
  'GET /api/v1/system/ping': 'public',
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/logout': 'public',
  'GET /api/v1/auth/status': 'public',
  'POST /api/v1/auth/plex/pin': 'public',
  'POST /api/v1/auth/plex/poll': 'public',
  // sign-in hardening: second factor, passkeys, identity-provider redirects
  'POST /api/v1/auth/login/2fa': 'public',
  'POST /api/v1/auth/passkey/options': 'public',
  'POST /api/v1/auth/passkey/login': 'public',
  'GET /api/v1/auth/oidc/:id/start': 'public',
  'GET /api/v1/auth/oidc/:id/callback': 'public',
  // own account security (session-only for per-user keys, see hook.ts SESSION_ONLY_PREFIXES)
  'POST /api/v1/auth/oidc/:id/link': 'portal',
  'GET /api/v1/user/me/2fa': 'portal',
  'POST /api/v1/user/me/2fa/totp/setup': 'portal',
  'POST /api/v1/user/me/2fa/totp/enable': 'portal',
  'DELETE /api/v1/user/me/2fa/totp': 'portal',
  'POST /api/v1/user/me/2fa/recovery': 'portal',
  'GET /api/v1/user/me/passkeys': 'portal',
  'POST /api/v1/user/me/passkeys/options': 'portal',
  'POST /api/v1/user/me/passkeys': 'portal',
  'PUT /api/v1/user/me/passkeys/:id': 'portal',
  'DELETE /api/v1/user/me/passkeys/:id': 'portal',
  'GET /api/v1/user/me/identities': 'portal',
  'DELETE /api/v1/user/me/identities/:id': 'portal',
  'GET /api/v1/user/me/apikeys': 'portal',
  'POST /api/v1/user/me/apikeys': 'portal',
  'DELETE /api/v1/user/me/apikeys/:id': 'portal',
  'GET /api/v1/calendar/feed.ics': 'public',
  // the Arclight player app: password sign-in and QR pairing (rate-limited), then a device token
  'POST /api/v1/app/sign-in': 'public',
  'POST /api/v1/app/pair': 'public',
  'POST /api/v1/app/pair-codes': 'portal',
  'POST /api/v1/app/device-codes': 'public',
  'POST /api/v1/app/device-codes/poll': 'public',
  'POST /api/v1/app/device-codes/approve': 'portal',
  'GET /api/v1/app/devices': 'portal',
  'DELETE /api/v1/app/devices/:id': 'portal',
  'POST /api/v1/app/sign-out': 'portal',
  'POST /api/v1/plex/webhook': 'public',
  'GET /api/v1/theme': 'public',
  'GET /api/v1/theme/:id/theme.css': 'public',
  'GET /api/v1/theme/:id/fonts/:file': 'public',
  'GET /api/v1/setup/status': 'public',
  'POST /api/v1/setup/admin': 'public',
  'POST /api/v1/setup/rootfolder': 'public',
  'POST /api/v1/setup/complete': 'public',
  'GET /api': 'public',
  'GET /ping': 'public',
  'GET /initialize.json': 'public',
  'GET /initialize.js': 'public',
  'GET /metrics': 'public when metrics.allowAnonymous',

  // ---- own account, sessions, notifications
  'GET /api/v1/auth/me': 'portal',
  'GET /api/v1/auth/sessions': 'portal',
  'DELETE /api/v1/auth/sessions/:id': 'portal',
  'GET /api/v1/user/me': 'portal',
  'GET /api/v1/settings/features': 'portal',
  'PUT /api/v1/user/me': 'portal',
  'PUT /api/v1/user/me/password': 'portal',
  'GET /api/v1/user/:id/permissions': 'portal',
  'GET /api/v1/user/:id/quota': 'portal',
  'GET /api/v1/user/:id/requestsettings': 'portal',
  'PUT /api/v1/user/:id/requestsettings': 'portal',
  'POST /api/v1/user/:id/requestsettings/test': 'portal',
  'POST /api/v1/user/:id/mediaserver/link': 'portal',
  'DELETE /api/v1/user/:id/mediaserver/link': 'portal',
  'POST /api/v1/user/me/mediaserver/plex/pin': 'portal',
  'POST /api/v1/user/me/mediaserver/plex/poll': 'portal',
  'POST /api/v1/user/me/discord/link-code': 'portal',
  'DELETE /api/v1/user/me/discord/link': 'portal',
  'GET /api/v1/user/:id/notification-destination/options': 'portal',
  'GET /api/v1/user/:id/notification-destination': 'portal',
  'POST /api/v1/user/:id/notification-destination': 'portal',
  'POST /api/v1/user/:id/notification-destination/test': 'portal',
  'PUT /api/v1/user/:id/notification-destination/:destinationId': 'portal',
  'DELETE /api/v1/user/:id/notification-destination/:destinationId': 'portal',
  'GET /api/v1/user/:id/notification-destination/:destinationId/deliveries': 'portal',
  'GET /api/v1/notification/templates': 'portal',
  'POST /api/v1/notification/preview': 'portal',
  'GET /api/v1/push/vapid-public-key': 'portal',
  'GET /api/v1/push/subscription': 'portal',
  'POST /api/v1/push/subscription': 'portal',
  'DELETE /api/v1/push/subscription': 'portal',
  'GET /api/v1/push/preferences': 'portal',
  'PUT /api/v1/push/preferences': 'portal',
  'POST /api/v1/push/test': 'portal',
  'GET /api/v1/mobile/pairing': 'portal',
  'GET /api/v1/mobile/devices': 'portal',
  'POST /api/v1/mobile/devices': 'portal',
  'DELETE /api/v1/mobile/devices/:id': 'portal',
  'POST /api/v1/mobile/devices/:id/test': 'portal',
  'GET /api/v1/events': 'portal',
  // Universal search: kinds scoped in the service (own requests/issues; library, activity, settings by access).
  'GET /api/v1/search/universal': 'portal',

  // ---- discover (public portal: anonymous too while allowed)
  'GET /api/v1/public/portal': 'portal publicWhen',
  'GET /api/v1/discoverslider': 'portal publicWhen',
  'GET /api/v1/discover/movies': 'portal publicWhen',
  'GET /api/v1/discover/tv': 'portal publicWhen',
  'GET /api/v1/discover/trending': 'portal publicWhen',
  'GET /api/v1/discover/upcoming': 'portal publicWhen',
  'GET /api/v1/discover/search': 'portal publicWhen',
  'GET /api/v1/discover/search/people': 'portal publicWhen',
  'GET /api/v1/discover/genres': 'portal publicWhen',
  'GET /api/v1/discover/genres/tiles': 'portal publicWhen',
  'GET /api/v1/discover/genre/:id': 'portal publicWhen',
  'GET /api/v1/discover/keyword/:id': 'portal publicWhen',
  'GET /api/v1/discover/keywords': 'portal publicWhen',
  'GET /api/v1/discover/network/:id': 'portal publicWhen',
  'GET /api/v1/discover/studio/:id': 'portal publicWhen',
  'GET /api/v1/discover/companies': 'portal publicWhen',
  'GET /api/v1/discover/providers': 'portal publicWhen',
  'GET /api/v1/discover/person/:id': 'portal publicWhen',
  'GET /api/v1/discover/movie/:tmdbId': 'portal publicWhen',
  'GET /api/v1/discover/tv/:tmdbId': 'portal publicWhen',
  'GET /api/v1/discover/slider/:id': 'portal publicWhen',
  'GET /api/v1/discover/list/:list': 'portal publicWhen',
  'GET /api/v1/discover/info/:kind/:id': 'portal publicWhen',
  'GET /api/v1/discover/options': 'portal publicWhen',
  'GET /api/v1/discover/collection/:id': 'portal publicWhen',
  'POST /api/v1/discover/collection/:id/request': 'portal',

  // ---- requests (own; everyone's with Manage / View requests), request defaults
  'GET /api/v1/request': 'portal',
  'GET /api/v1/request/count': 'portal',
  'GET /api/v1/request/:id': 'portal',
  'GET /api/v1/request/:id/policy': 'portal',
  'POST /api/v1/request': 'portal',
  'PUT /api/v1/request/:id': 'portal',
  'DELETE /api/v1/request/:id': 'portal',
  'POST /api/v1/request/:id/approve': 'portal',
  'POST /api/v1/request/:id/decline': 'portal',
  'POST /api/v1/request/:id/retry': 'portal',
  'POST /api/v1/request/bulk/approve': 'portal',
  'POST /api/v1/request/bulk/decline': 'portal',
  'POST /api/v1/request/bulk/retry': 'portal',
  'POST /api/v1/request/bulk/delete': 'portal',
  'GET /api/v1/settings/requests': 'portal',

  // ---- music and audiobook requests (service checks the permission bits; settings need MANAGE_SETTINGS)
  'GET /api/v1/discover/music': 'portal publicWhen',
  'GET /api/v1/discover/music/search': 'portal publicWhen',
  'GET /api/v1/discover/music/album/:mbid': 'portal publicWhen',
  'GET /api/v1/discover/music/artist/:mbid': 'portal publicWhen',
  'GET /api/v1/discover/music/artist/:mbid/similar': 'portal publicWhen',
  'GET /api/v1/discover/audiobooks': 'portal publicWhen',
  'GET /api/v1/discover/audiobooks/search': 'portal publicWhen',
  'GET /api/v1/discover/audiobooks/book/:asin': 'portal publicWhen',
  'GET /api/v1/discover/audiobooks/author/:asin': 'portal publicWhen',
  'GET /api/v1/audiorequest': 'portal',
  'GET /api/v1/audiorequest/count': 'portal',
  'GET /api/v1/audiorequest/:id': 'portal',
  'POST /api/v1/audiorequest': 'portal',
  'POST /api/v1/audiorequest/:id/approve': 'portal',
  'POST /api/v1/audiorequest/:id/decline': 'portal',
  'POST /api/v1/audiorequest/:id/retry': 'portal',
  'DELETE /api/v1/audiorequest/:id': 'portal',
  'POST /api/v1/audiorequest/bulk/:action': 'portal',
  'GET /api/v1/settings/audiorequests': 'portal',
  'PUT /api/v1/settings/audiorequests': 'portal',
  // Subtitle and language requests: the service checks REQUEST_LANGUAGE / MANAGE_REQUESTS.
  'GET /api/v1/request/language': 'portal',
  'GET /api/v1/request/language/count': 'portal',
  'GET /api/v1/request/language/options': 'portal',
  'GET /api/v1/request/language/languages': 'portal',
  'GET /api/v1/request/language/:id': 'portal',
  'POST /api/v1/request/language': 'portal',
  'POST /api/v1/request/language/:id/approve': 'portal',
  'POST /api/v1/request/language/:id/decline': 'portal',
  'POST /api/v1/request/language/:id/retry': 'portal',
  'POST /api/v1/request/language/bulk/:action': 'portal',
  'DELETE /api/v1/request/language/:id': 'portal',

  // ---- issues and watchlist (own; others' with the matching permissions)
  'GET /api/v1/issue': 'portal',
  'GET /api/v1/issue/count': 'portal',
  'GET /api/v1/issue/:id': 'portal',
  'POST /api/v1/issue': 'portal',
  'POST /api/v1/issue/:id/comment': 'portal',
  'POST /api/v1/issue/:id/status': 'portal',
  'POST /api/v1/issue/bulk/status': 'portal',
  'POST /api/v1/issue/bulk/delete': 'portal',
  'DELETE /api/v1/issue/:id': 'portal',
  'PUT /api/v1/issuecomment/:id': 'portal',
  'DELETE /api/v1/issuecomment/:id': 'portal',
  'GET /api/v1/watchlist': 'portal',
  // Own watch history (the query scopes non-admins to their linked accounts).
  'GET /api/v1/watchhistory': 'portal',
  // ---- playback stats and Year in review: the caller's own (admins anyone); share links
  'GET /api/v1/watchstats': 'portal',
  'GET /api/v1/watchstats/wrapped': 'portal',
  'GET /api/v1/watchstats/wrapped/image.svg': 'portal',
  'GET /api/v1/watchstats/wrapped/shares': 'portal',
  'POST /api/v1/watchstats/wrapped/shares': 'portal',
  'DELETE /api/v1/watchstats/wrapped/shares/:id': 'portal',
  // Public Year in review share links (random token, expire, revocable)
  'GET /api/v1/share/wrapped/:token': 'publicWhen',
  'GET /api/v1/share/wrapped/:token/image.svg': 'publicWhen',
  'POST /api/v1/watchlist': 'portal',
  'DELETE /api/v1/watchlist/:id': 'portal',

  // ---- app access: Library (read-only)
  'GET /api/v1/series': 'areas:library',
  'GET /api/v1/series/:id': 'areas:library',
  'GET /api/v1/episode': 'areas:library',
  'GET /api/v1/episode/:id': 'areas:library',
  'GET /api/v1/movie': 'areas:library',
  'GET /api/v1/movie/:id': 'areas:library',
  'GET /api/v1/mediafile': 'areas:library',
  'GET /api/v1/mediafile/:id': 'areas:library',
  'GET /api/v1/library/statistics': 'areas:library',
  'GET /api/v1/artist': 'areas:library',
  'GET /api/v1/artist/:id': 'areas:library',
  'GET /api/v1/artist/:id/similar': 'areas:library',
  'GET /api/v1/album': 'areas:library',
  'GET /api/v1/album/:id': 'areas:library',
  'GET /api/v1/audiofile': 'areas:library',
  'GET /api/v1/author': 'areas:library',
  'GET /api/v1/author/:id': 'areas:library',
  'GET /api/v1/book': 'areas:library',
  'GET /api/v1/book/:id': 'areas:library',
  'GET /api/v1/bookseries': 'areas:library',
  'GET /api/v1/bookseries/:id': 'areas:library',
  // ---- podcasts (reads for the library area; search and suggestions for any signed-in user)
  'GET /api/v1/podcast': 'areas:library',
  'GET /api/v1/podcast/:id': 'areas:library',
  'GET /api/v1/podcast/episode': 'areas:library',
  'PUT /api/v1/podcast/episode/:id': 'areas:library',
  'GET /api/v1/podcast/search': 'portal',
  'GET /api/v1/podcast/suggestion': 'portal',
  'POST /api/v1/podcast/suggestion': 'portal',
  'POST /api/v1/podcast/suggestion/:id/approve': 'portal',
  'POST /api/v1/podcast/suggestion/:id/decline': 'portal',
  'DELETE /api/v1/podcast/suggestion/:id': 'portal',
  'GET /api/v1/tagrule/applied': 'areas:library',
  'GET /api/v1/metadata/collection/:tmdbId': 'areas:library',
  'GET /api/v1/rootfolder': 'areas:library perms:REQUEST_ADVANCED+MANAGE_REQUESTS',
  'GET /api/v1/rootfolder/:id': 'areas:library',
  'GET /api/v1/tag': 'areas:library perms:REQUEST_ADVANCED+MANAGE_REQUESTS',
  'GET /api/v1/tag/:id': 'areas:library',
  'GET /api/v1/qualityprofile': 'areas:library+wanted perms:REQUEST_ADVANCED+MANAGE_REQUESTS',
  'GET /api/v1/qualityprofile/:id': 'areas:library+wanted',
  'GET /api/v1/history/series': 'areas:library+activity',
  'GET /api/v1/history/movie': 'areas:library+activity',
  'GET /api/v1/queue/summary': 'areas:library+activity',
  'GET /api/v1/release/searchstatus': 'areas:library+wanted',

  // ---- app access: Calendar, Wanted, Activity (read-only)
  'GET /api/v1/calendar': 'areas:calendar',
  'GET /api/v1/wanted/missing/episodes': 'areas:wanted',
  'GET /api/v1/wanted/missing/movies': 'areas:wanted',
  'GET /api/v1/wanted/cutoff/episodes': 'areas:wanted',
  'GET /api/v1/wanted/cutoff/movies': 'areas:wanted',
  'GET /api/v1/wanted/missing/albums': 'areas:wanted',
  'GET /api/v1/wanted/cutoff/albums': 'areas:wanted',
  'GET /api/v1/wanted/missing/books': 'areas:wanted',
  'GET /api/v1/wanted/cutoff/books': 'areas:wanted',
  'GET /api/v1/profilemigration/mismatch': 'areas:wanted',
  'GET /api/v1/queue': 'areas:activity',
  'GET /api/v1/queue/status': 'areas:activity',
  'GET /api/v1/queue/:id': 'areas:activity',
  'GET /api/v1/queue/:id/timeline': 'areas:activity',
  'GET /api/v1/history': 'areas:activity',
  'GET /api/v1/history/since': 'areas:activity',
  'GET /api/v1/blocklist': 'areas:activity',
  'GET /api/v1/blocklist/series': 'areas:activity',
  'GET /api/v1/blocklist/movie': 'areas:activity',

  // ---- Books (ebooks and comics): library reads by app area; requests scoped by the service
  'GET /api/v1/books/overview': 'areas:library',
  'GET /api/v1/books/authors': 'areas:library',
  'GET /api/v1/books/authors/:id': 'areas:library',
  'GET /api/v1/books/ebooks/:id': 'areas:library',
  'GET /api/v1/books/series/:id': 'areas:library',
  'GET /api/v1/books/comics': 'areas:library',
  'GET /api/v1/books/comics/:id': 'areas:library',
  'GET /api/v1/books/wanted': 'areas:wanted',
  'GET /api/v1/books/calendar': 'areas:calendar',
  'GET /api/v1/books/requests': 'portal',
  'POST /api/v1/books/requests': 'portal',
  'GET /api/v1/books/requests/lookup/ebooks': 'portal',
  'GET /api/v1/books/requests/lookup/comics': 'portal',
  'POST /api/v1/books/requests/:id/approve': 'portal',
  'POST /api/v1/books/requests/:id/decline': 'portal',
  'DELETE /api/v1/books/requests/:id': 'portal',
  // ---- the player: open to signed-in users, then the player guard (enabled, allowed, remote)
  'GET /api/v1/playback/me': 'portal',
  'GET /api/v1/playback/item/:itemKey': 'portal',
  'POST /api/v1/playback/items': 'portal',
  'POST /api/v1/playback/stream-links': 'portal',
  'POST /api/v1/playback/artwork-link': 'portal',
  'GET /api/v1/stream/audio/:fileId': 'portal publicWhen',
  'GET /api/v1/stream/hls/:sessionId/master.m3u8': 'portal publicWhen',
  'GET /api/v1/stream/hls/:sessionId/:rung/index.m3u8': 'portal publicWhen',
  'GET /api/v1/stream/hls/:sessionId/:rung/init.mp4': 'portal publicWhen',
  'GET /api/v1/stream/hls/:sessionId/:rung/:n.m4s': 'portal publicWhen',
  'GET /api/v1/playback/artwork/:kind/:id': 'portal publicWhen',
  'PUT /api/v1/playback/progress/:itemKey': 'portal',
  'POST /api/v1/playback/progress/beacon': 'portal',
  'POST /api/v1/playback/progress/batch': 'portal',
  'PATCH /api/v1/playback/playlists/:id/tracks/:entryId': 'portal',
  'PATCH /api/v1/playback/progress/:itemKey': 'portal',
  'GET /api/v1/playback/progress': 'portal',
  'GET /api/v1/playback/continue': 'portal',
  'GET /api/v1/playback/queue': 'portal',
  'PUT /api/v1/playback/queue': 'portal',
  'GET /api/v1/playback/bookmarks': 'portal',
  'POST /api/v1/playback/bookmarks': 'portal',
  'PUT /api/v1/playback/bookmarks/:id': 'portal',
  'DELETE /api/v1/playback/bookmarks/:id': 'portal',
  'GET /api/v1/playback/playlists': 'portal',
  'POST /api/v1/playback/playlists': 'portal',
  'POST /api/v1/playback/playlists/:id/tracks': 'portal',
  'GET /api/v1/playback/playlists/:id': 'portal',
  'PUT /api/v1/playback/playlists/:id': 'portal',
  'DELETE /api/v1/playback/playlists/:id': 'portal',
  'DELETE /api/v1/playback/playlists/:id/tracks/:entryId': 'portal',
  'GET /api/v1/playback/music/home': 'portal',
  'GET /api/v1/playback/music/albums': 'portal',
  'GET /api/v1/playback/music/albums/:id': 'portal',
  'GET /api/v1/playback/music/artists': 'portal',
  'GET /api/v1/playback/music/artists/:id': 'portal',
  'GET /api/v1/playback/music/tracks': 'portal',
  'GET /api/v1/playback/audiobooks/home': 'portal',
  'GET /api/v1/playback/audiobooks': 'portal',
  'GET /api/v1/playback/audiobooks/:id': 'portal',
  'GET /api/v1/playback/search': 'portal',
  // Movies & TV
  'POST /api/v1/playback/video/session': 'portal',
  'DELETE /api/v1/playback/video/session/:sessionId': 'portal',
  'GET /api/v1/playback/video/session/:sessionId/health': 'portal publicWhen',
  'GET /api/v1/stream/video/:mediaFileId': 'portal publicWhen',
  'GET /api/v1/stream/subtitle/:mediaFileId/:subId.vtt': 'portal publicWhen',
  'GET /api/v1/playback/artwork/movie/:id': 'portal publicWhen',
  'GET /api/v1/playback/artwork/series/:id': 'portal publicWhen',
  'GET /api/v1/playback/artwork/episode/:id': 'portal publicWhen',
  'GET /api/v1/playback/video/home': 'portal',
  'GET /api/v1/playback/video/featured': 'portal',
  'GET /api/v1/playback/video/trickplay/:mediaFileId': 'portal',
  'GET /api/v1/stream/trickplay/:mediaFileId/:sheet.jpg': 'portal publicWhen',
  'GET /api/v1/playback/movies': 'portal',
  'GET /api/v1/playback/movies/:id': 'portal',
  'GET /api/v1/playback/series': 'portal',
  'GET /api/v1/playback/series/:id': 'portal',
  'POST /api/v1/playback/watched': 'portal',
  // household profiles (households/routes.ts); managing needs the owner profile, checked in the route
  'GET /api/v1/households/profiles': 'portal',
  'POST /api/v1/households/profiles': 'portal',
  'GET /api/v1/households/profiles/active/settings': 'portal',
  'PUT /api/v1/households/profiles/active/settings': 'portal',
  'PATCH /api/v1/households/profiles/:id': 'portal',
  'DELETE /api/v1/households/profiles/:id': 'portal',
  'POST /api/v1/households/profiles/:id/select': 'portal',
  // My List (playback/my-list.ts), per household profile
  'GET /api/v1/playback/my-list': 'portal',
  'PUT /api/v1/playback/my-list/:key': 'portal',
  'DELETE /api/v1/playback/my-list/:key': 'portal',
};

const PERMISSION_NAMES = new Map<number, string>(Object.entries(Permission).map(([name, bit]) => [bit, name]));

/** How a registered route admits non-admins; null: admins only. */
function describeAccess(url: string, config: { access?: RouteAccess; publicWhen?: unknown } | undefined): string | null {
  if (url.startsWith('/api/v1/')) {
    if (isPublicRoute(url)) return 'public';
  } else if (COMPAT_PUBLIC_ROUTES.has(url)) {
    return 'public';
  } else if (url === '/metrics') {
    return 'public when metrics.allowAnonymous';
  }
  const parts: string[] = [];
  const access = config?.access;
  if (access?.portal) parts.push('portal');
  if (access?.areas?.length) parts.push(`areas:${access.areas.join('+')}`);
  if (access?.permissions?.length) parts.push(`perms:${access.permissions.map((p) => PERMISSION_NAMES.get(p) ?? String(p)).join('+')}`);
  if (config?.publicWhen) parts.push('publicWhen');
  return parts.length ? parts.join(' ') : null;
}

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
  routes: RouteOptions[];
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.app.close();
});

async function harness(opts: { admin?: boolean } = {}): Promise<Harness> {
  const db = await createTestDb();
  if (opts.admin ?? true) seedAdmin(db);
  const routes: RouteOptions[] = [];
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: process.env['ACCESS_LOG'] ?? 'silent' }), {
    probe: false,
    onContext: (c) => (ctx = c),
    onRoute: (r) => routes.push(r),
  });
  await app.ready();
  const h = { app, ctx: ctx!, db, routes };
  open.push(h);
  return h;
}

/** A signed-in non-admin; returns its session cookie and id. */
async function signedIn(h: Harness, opts: { appAccess?: AppArea[]; permissions?: number } = {}): Promise<{ cookie: string; id: number }> {
  const auth = authServiceFor(h.ctx);
  const user = await auth.createUser({
    username: `u${Math.random().toString(36).slice(2, 8)}`,
    password: 'password1',
    role: 'user',
    permissions: opts.permissions ?? Permission.REQUEST | Permission.CREATE_ISSUES,
    ...(opts.appAccess ? { appAccess: opts.appAccess } : {}),
  });
  return { cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}`, id: user.id };
}

describe('route table', () => {
  it('opens to non-admins exactly the routes on the allow-list; everything else is admin-only', async () => {
    const h = await harness();
    const actual: Record<string, string> = {};
    const getAccess = new Map<string, string | null>();
    for (const route of h.routes) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        // CORS preflight answers OPTIONS for every path with headers only; it serves no data.
        if (method === 'OPTIONS' && route.url === '*') continue;
        const how = describeAccess(route.url, route.config as { access?: RouteAccess; publicWhen?: unknown } | undefined);
        if (method === 'HEAD') {
          // HEAD twins of GET routes must not be more open than their GET.
          getAccess.set(`HEAD ${route.url}`, how);
          continue;
        }
        if (method === 'GET') getAccess.set(`GET ${route.url}`, how);
        if (how !== null) actual[`${method} ${route.url}`] = how;
      }
    }
    expect(actual).toEqual(NON_ADMIN_ROUTES);
    for (const [key, how] of getAccess) {
      if (!key.startsWith('HEAD ')) continue;
      expect([how, key], 'HEAD route more open than its GET').toEqual([getAccess.get(`GET ${key.slice(5)}`) ?? null, key]);
    }
    // Sanity: the table really covers the app (hundreds of admin-only routes stay closed).
    expect(h.routes.length).toBeGreaterThan(500);
  });
});

describe('portal user over HTTP', () => {
  const ADMIN_ONLY_READS = [
    '/api/v1/series',
    '/api/v1/movie',
    '/api/v1/calendar',
    '/api/v1/queue',
    '/api/v1/history',
    '/api/v1/wanted/missing/episodes',
    '/api/v1/settings/security',
    '/api/v1/settings/mediamanagement',
    '/api/v1/settings/mediaserver',
    '/api/v1/settings/signin',
    '/api/v1/settings/compat',
    '/api/v1/system/status',
    '/api/v1/system/debug/snapshot',
    '/api/v1/system/backup',
    '/api/v1/system/update',
    '/api/v1/log',
    '/api/v1/log/file',
    '/api/v1/user',
    '/api/v1/user/1',
    '/api/v1/health',
    '/api/v1/jobs',
    '/api/v1/indexer',
    '/api/v1/downloadclient',
    '/api/v1/rootfolder',
    '/api/v1/qualityprofile',
    '/api/v1/overriderule',
    '/api/v1/audit',
    '/api/v1/config/export',
    '/api/v1/mediaserver',
    '/api/v1/user/import/mediaserver',
    '/api/v3/series',
    '/api/v3/system/status',
    '/metrics',
  ];

  it('gets 403 on every admin area, reads included', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h);
    for (const url of ADMIN_ONLY_READS) {
      for (const method of ['GET', 'HEAD'] as const) {
        const res = await h.app.inject({ method, url, headers: { cookie } });
        expect([url, method, res.statusCode]).toEqual([url, method, 403]);
      }
    }
  });

  it('cannot write to admin routes or other users', async () => {
    const h = await harness();
    const { cookie, id } = await signedIn(h);
    const other = await signedIn(h);
    const tries: Array<['POST' | 'PUT' | 'DELETE', string, object?]> = [
      ['POST', '/api/v1/series', {}],
      ['PUT', '/api/v1/settings/requests', {}],
      ['PUT', '/api/v1/settings/security', { method: 'none', requireForLocal: false, sessionDays: 30 }],
      ['POST', '/api/v1/user', { username: 'evil', password: 'password1', role: 'admin' }],
      ['PUT', `/api/v1/user/${id}`, { role: 'admin' }],
      ['PUT', `/api/v1/user/${id}/permissions`, { permissions: Permission.ADMIN }],
      ['PUT', `/api/v1/user/${id}/quota`, {}],
      ['POST', '/api/v1/discoverslider', {}],
      ['POST', '/api/v1/watchlist/sync'],
      ['POST', '/api/v1/request/digest'],
      ['POST', '/api/v1/settings/security/apikey'],
      ['POST', '/api/v1/system/debug/run', { input: 'help' }],
    ];
    for (const [method, url, payload] of tries) {
      const res = await h.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
      expect([method, url, res.statusCode]).toEqual([method, url, 403]);
    }
    // Portal routes under /user/:id act on the caller's own account only.
    for (const url of [`/api/v1/user/${other.id}/quota`, `/api/v1/user/${other.id}/requestsettings`, `/api/v1/user/${other.id}/permissions`]) {
      expect((await h.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(403);
    }
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/user/${id}/quota`, headers: { cookie } })).statusCode).toBe(200);
  });

  it('cannot open System → Debugging; admins (API key) can', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h);
    const key = authServiceFor(h.ctx).apiKey();
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/system/debug/snapshot', headers: { cookie } })).statusCode).toBe(403);
    const denied = await h.app.inject({ method: 'POST', url: '/api/v1/system/debug/run', headers: { cookie }, payload: { input: 'logs' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('log line');
    const snap = await h.app.inject({ method: 'GET', url: '/api/v1/system/debug/snapshot', headers: { 'x-api-key': key } });
    expect(snap.statusCode).toBe(200);
    expect(snap.json()).toMatchObject({ memory: { rss: expect.any(Number) }, handles: { available: true } });
    const run = await h.app.inject({ method: 'POST', url: '/api/v1/system/debug/run', headers: { 'x-api-key': key }, payload: { input: 'version\nengine' } });
    expect(run.statusCode).toBe(200);
    expect(run.json().results.map((r: { command: string; ok: boolean }) => [r.command, r.ok])).toEqual([
      ['version', true],
      ['engine', true],
    ]);
  });

  it('reaches its own account, requests, issues and the portal descriptor', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h);
    for (const url of ['/api/v1/auth/me', '/api/v1/user/me', '/api/v1/auth/sessions', '/api/v1/request', '/api/v1/request/count', '/api/v1/issue', '/api/v1/settings/requests', '/api/v1/public/portal', '/api/v1/watchlist']) {
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie } });
      expect([url, res.statusCode]).toEqual([url, 200]);
    }
    const me = (await h.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).json();
    expect(me).toMatchObject({ isAdmin: false, user: { role: 'user', appAccess: [] } });
  });

  it('with app access reads only the granted areas, and never writes', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h, { appAccess: ['library'] });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/series', headers: { cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/movie', headers: { cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/qualityprofile', headers: { cookie } })).statusCode).toBe(200);
    for (const url of ['/api/v1/calendar', '/api/v1/queue', '/api/v1/history', '/api/v1/wanted/missing/movies', '/api/v1/system/status', '/api/v1/settings/mediamanagement']) {
      expect([url, (await h.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode]).toEqual([url, 403]);
    }
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/series', headers: { cookie }, payload: {} })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/movie/1', headers: { cookie } })).statusCode).toBe(403);
    const activity = await signedIn(h, { appAccess: ['activity', 'calendar'] });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/queue', headers: { cookie: activity.cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/calendar', headers: { cookie: activity.cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/series', headers: { cookie: activity.cookie } })).statusCode).toBe(403);
  });

  it('advanced requesters may read the root folder, profile and tag lists, nothing more', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h, { permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED });
    for (const url of ['/api/v1/rootfolder', '/api/v1/qualityprofile', '/api/v1/tag']) {
      expect([url, (await h.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode]).toEqual([url, 200]);
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/series', headers: { cookie } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/rootfolder', headers: { cookie }, payload: { path: '/x' } })).statusCode).toBe(403);
  });

  it('admin promotion needs a local password, and ends the promoted user\'s sessions', async () => {
    const h = await harness();
    const auth = authServiceFor(h.ctx);
    const key = auth.apiKey();
    const { cookie, id } = await signedIn(h);
    // A media-server account has no local password.
    const { users } = await import('./db/schema.js');
    const { eq } = await import('drizzle-orm');
    h.db.update(users).set({ localPassword: false }).where(eq(users.id, id)).run();
    const refused = await h.app.inject({ method: 'PUT', url: `/api/v1/user/${id}`, headers: { 'x-api-key': key }, payload: { role: 'admin' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('PASSWORD_REQUIRED');
    const promoted = await h.app.inject({ method: 'PUT', url: `/api/v1/user/${id}`, headers: { 'x-api-key': key }, payload: { role: 'admin', password: 'a-new-password' } });
    expect(promoted.json()).toMatchObject({ role: 'admin', localPassword: true, appAccess: [] });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('local sign-in can be turned off for users, never for admins', async () => {
    const h = await harness();
    const auth = authServiceFor(h.ctx);
    await auth.createUser({ username: 'boss', password: 'password1', role: 'admin' });
    await auth.createUser({ username: 'pat', password: 'password1', role: 'user' });
    auth.updateSignInSettings({ local: false, jellyfin: true, emby: true, plex: true, newUsers: 'automatic' });
    const pat = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'pat', password: 'password1' } });
    expect(pat.statusCode).toBe(403);
    const boss = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'boss', password: 'password1' } });
    expect(boss.statusCode).toBe(200);
  });
});

describe('first launch', () => {
  it('answers SETUP_REQUIRED everywhere but the setup bootstrap until the admin exists, API key included', async () => {
    const h = await harness({ admin: false });
    const key = authServiceFor(h.ctx).apiKey();
    for (const [method, url] of [
      ['GET', '/api/v1/series'],
      ['GET', '/api/v1/system/status'],
      ['GET', '/api/v1/settings/security'],
      ['GET', '/api/v1/user'],
      ['POST', '/api/v1/auth/login'],
      ['POST', '/api/v1/setup/rootfolder'],
      ['GET', '/api/v1/public/portal'],
      ['GET', '/api/v1/discover/trending'],
      ['GET', '/api/v3/series'],
      ['GET', '/api/v3/system/status'],
      ['GET', '/metrics'],
    ] as const) {
      for (const headers of [{}, { 'x-api-key': key }]) {
        const res = await h.app.inject({ method, url, headers, ...(method === 'POST' ? { payload: {} } : {}) });
        expect([method, url, res.statusCode, res.json().code]).toEqual([method, url, 403, 'SETUP_REQUIRED']);
      }
    }
    await expect(h.app.injectWS('/api/v1/events', { headers: { 'x-api-key': key } })).rejects.toThrow(/403/);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/system/ping' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/ping' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/setup/status' })).json()).toMatchObject({ needsSetup: true, steps: [{ id: 'admin', complete: false }, {}, {}, {}, {}] });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toMatchObject({ needsSetup: true, adminExists: false, authenticated: false });
  });

  it('creates exactly one admin when two first-launch requests race', async () => {
    const h = await harness({ admin: false });
    const create = (username: string) =>
      h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username, password: 'a-long-password-1' } });
    const codes = (await Promise.all([create('first'), create('second')])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
    const admins = authServiceFor(h.ctx).listUsers().filter((u) => u.role === 'admin');
    expect(admins).toHaveLength(1);
  });

  it('stays closed even if setup was marked complete without an admin (no default account, no skipping)', async () => {
    const h = await harness({ admin: false });
    setSection(h.db, 'security', SecuritySettings.parse({ setupComplete: true, method: 'none', requireForLocal: false }));
    // No local bypass without an admin either.
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/series', remoteAddress: '192.168.1.5' });
    expect(res.statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toMatchObject({ needsSetup: true, adminExists: false });
    // The admin step is still the way in, and only once.
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'owner', password: 'password1' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ isAdmin: true, user: { role: 'admin', localPassword: true } });
    const second = await h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'evil', password: 'password1' } });
    expect(second.statusCode).toBe(409);
    const headless = await h.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { username: 'evil2', password: 'password1' } });
    expect([401, 409]).toContain(headless.statusCode);
    expect(authServiceFor(h.ctx).listUsers().map((u) => u.username)).toEqual(['owner']);
  });

  it('refuses anonymous setup writes before the admin exists', async () => {
    const h = await harness({ admin: false });
    const folder = await h.app.inject({ method: 'POST', url: '/api/v1/setup/rootfolder', payload: { path: '/tmp/x', mediaType: 'series' } });
    expect(folder.statusCode).toBe(403);
    const noAdmin = await h.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { tmdbApiKey: 'k' } });
    expect(noAdmin.statusCode).toBe(400);
  });
});

describe('live event feed', () => {
  const owners: EventOwners = { requestOwner: (id) => (id === 1 ? 7 : 8), issueOwner: (id) => (id === 1 ? 7 : 8) };
  const portal: EventViewer = { isAdmin: false, userId: 7, appAccess: [], permissions: Permission.REQUEST };
  const job = { type: 'job', job: {} } as unknown as ServerEvent;

  it('shows a portal user only their own requests and issues', () => {
    expect(eventVisibleTo({ type: 'request', action: 'approved', id: 1 }, portal, owners)).toBe(true);
    expect(eventVisibleTo({ type: 'request', action: 'approved', id: 2 }, portal, owners)).toBe(false);
    expect(eventVisibleTo({ type: 'issue', action: 'updated', id: 1 }, portal, owners)).toBe(true);
    expect(eventVisibleTo({ type: 'issue', action: 'updated', id: 2 }, portal, owners)).toBe(false);
    expect(eventVisibleTo({ type: 'request', action: 'approved', id: 2 }, { ...portal, permissions: Permission.REQUEST_VIEW }, owners)).toBe(true);
    for (const event of [
      job,
      { type: 'settings', section: 'security' },
      { type: 'queue', action: 'changed' },
      { type: 'library', action: 'added', mediaType: 'series', id: 1 },
      { type: 'indexer', action: 'failed', id: 1, name: 'x' },
      { type: 'summary', action: 'generated', id: 1 },
    ] as ServerEvent[]) {
      expect([event.type, eventVisibleTo(event, portal, owners)]).toEqual([event.type, false]);
    }
  });

  it('adds library and activity events for granted areas; admins see everything', () => {
    const lib: EventViewer = { ...portal, appAccess: ['library'] };
    expect(eventVisibleTo({ type: 'library', action: 'added', mediaType: 'movie', id: 3 }, lib, owners)).toBe(true);
    expect(eventVisibleTo({ type: 'queue', action: 'changed' }, lib, owners)).toBe(false);
    expect(eventVisibleTo({ type: 'queue', action: 'changed' }, { ...portal, appAccess: ['activity'] }, owners)).toBe(true);
    expect(eventVisibleTo(job, { ...portal, appAccess: ['library', 'calendar', 'activity', 'wanted'] }, owners)).toBe(false);
    expect(eventVisibleTo(job, { isAdmin: true, userId: null, appAccess: [], permissions: 0 }, owners)).toBe(true);
  });

  it('filters the socket: a portal user receives nothing admin-only', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h, { permissions: Permission.REQUEST | Permission.REQUEST_VIEW });
    const ws = await h.app.injectWS('/api/v1/events', { headers: { cookie } });
    const received: ServerEvent[] = [];
    const done = new Promise<void>((resolve) =>
      ws.on('message', (data: Buffer) => {
        const event = JSON.parse(data.toString()) as ServerEvent;
        received.push(event);
        if (event.type === 'request') resolve();
      }),
    );
    h.ctx.bus.publish({ type: 'settings', section: 'security' });
    h.ctx.bus.publish({ type: 'queue', action: 'changed' });
    h.ctx.bus.publish({ type: 'library', action: 'added', mediaType: 'series', id: 1 });
    h.ctx.bus.publish({ type: 'indexer', action: 'failed', id: 1, name: 'x' });
    h.ctx.bus.publish({ type: 'request', action: 'created', id: 99 });
    await done;
    ws.terminate();
    expect(received.map((e) => e.type)).toEqual(['request']);
  });

  it('refuses the socket to anonymous callers', async () => {
    const h = await harness();
    await expect(h.app.injectWS('/api/v1/events')).rejects.toThrow(/401/);
  });
});

describe('household profile confinement', () => {
  /** An admin account with a Kids profile selected on a session and on an app device. */
  async function kidsOnAdmin(h: Harness) {
    const auth = authServiceFor(h.ctx);
    const admin = await auth.createUser({ username: `kidsadmin${Math.random().toString(36).slice(2, 6)}`, password: 'password1', role: 'admin', settings: { player: { allowed: true } } });
    const ownerCookie = `${SESSION_COOKIE}=${auth.createSession(admin.id).token}`;
    const kidsCookie = `${SESSION_COOKIE}=${auth.createSession(admin.id).token}`;
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/households/profiles', headers: { cookie: ownerCookie }, payload: { name: 'Kids', contentRestrictions: { maxCertification: { movie: 'G', tv: 'TV-Y' }, hideAdultContent: true } } });
    expect(created.statusCode, created.body).toBe(201);
    const kidId = created.json().id as number;
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/households/profiles/${kidId}/select`, headers: { cookie: kidsCookie }, payload: {} })).statusCode).toBe(200);
    const signIn = await h.app.inject({ method: 'POST', url: '/api/v1/app/sign-in', payload: { username: admin.username, password: 'password1', deviceName: 'TV', platform: 'android', appVersion: '1.0.0' } });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const bearer = `Bearer ${signIn.json().token}`;
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/households/profiles/${kidId}/select`, headers: { authorization: bearer }, payload: {} })).statusCode).toBe(200);
    return { ownerCookie, kidId, credentials: [{ cookie: kidsCookie }, { authorization: bearer }] as Array<Record<string, string>> };
  }

  // Allowed routes answer (whatever the route itself then says); never 403 profile-forbidden.
  const ALLOWED: Array<[string, string]> = [
    ['GET', '/api/v1/auth/me'],
    ['GET', '/api/v1/households/profiles'],
    ['GET', '/api/v1/households/profiles/active/settings'],
    ['GET', '/api/v1/playback/me'],
    ['GET', '/api/v1/playback/video/home'],
    ['GET', '/api/v1/playback/my-list'],
    ['GET', '/api/v1/playback/queue'],
    ['GET', '/api/v1/user/me'],
    ['GET', '/api/v1/theme'],
  ];
  // A sample of admin, portal, request and account routes: all 403 profile-forbidden.
  const REFUSED: Array<[string, string, object?]> = [
    ['GET', '/api/v1/settings/player'],
    ['PUT', '/api/v1/settings/player', { enabled: true }],
    ['GET', '/api/v1/user'],
    ['GET', '/api/v1/users/1/profiles'],
    ['GET', '/api/v1/system/status'],
    ['GET', '/api/v1/series'],
    ['GET', '/api/v1/movie'],
    ['GET', '/api/v1/request'],
    ['POST', '/api/v1/request', { mediaType: 'movie', tmdbId: 1 }],
    ['GET', '/api/v1/watchlist'],
    ['GET', '/api/v1/auth/sessions'],
    ['GET', '/api/v1/user/me/apikeys'],
    ['POST', '/api/v1/app/pair-codes'],
    ['GET', '/api/v1/app/devices'],
    ['POST', '/api/v1/households/profiles', { name: 'Sneaky' }],
    ['GET', '/api/v1/settings/security'],
  ];

  it('the allow-list rule: player prefixes, exact routes and methods; segment editing and player settings excluded', () => {
    expect(profileMay('GET', '/api/v1/playback/movies')).toBe(true);
    expect(profileMay('PUT', '/api/v1/playback/my-list/:key')).toBe(true);
    expect(profileMay('GET', '/api/v1/stream/video/:mediaFileId')).toBe(true);
    expect(profileMay('PUT', '/api/v1/households/profiles/active/settings')).toBe(true);
    expect(profileMay('POST', '/api/v1/households/profiles/:id/select')).toBe(true);
    expect(profileMay('GET', '/api/v1/playback/segments')).toBe(false);
    expect(profileMay('PUT', '/api/v1/playback/segments/:itemKey')).toBe(false);
    expect(profileMay('GET', '/api/v1/settings/player')).toBe(false);
    expect(profileMay('POST', '/api/v1/households/profiles')).toBe(false);
    expect(profileMay('PATCH', '/api/v1/households/profiles/:id')).toBe(false);
    expect(profileMay('POST', '/api/v1/auth/me')).toBe(false);
    expect(profileMay('GET', '/api/v1/playbackx')).toBe(false);
    expect(profileMay('GET', undefined)).toBe(false);
  });

  it('a Kids profile on an admin account reaches only the player allow-list, on a session and on an app token', async () => {
    const h = await harness();
    setSection(h.db, 'player', { enabled: true, video: true });
    const kids = await kidsOnAdmin(h);
    for (const headers of kids.credentials) {
      for (const [method, url] of ALLOWED) {
        const res = await h.app.inject({ method: method as 'GET', url, headers });
        expect([method, url, res.statusCode < 400, res.body]).toEqual([method, url, true, res.body]);
      }
      for (const [method, url, payload] of REFUSED) {
        const res = await h.app.inject({ method: method as 'GET', url, headers, ...(payload ? { payload } : {}) });
        // A route an app bearer may never call is refused by that rule first; either way it is a 403.
        const error = res.json().error as string;
        const refusedBy = error === 'profile-forbidden' || (headers.authorization !== undefined && /Arclight app may not/.test(error));
        expect([res.statusCode, refusedBy, method, url]).toEqual([403, true, method, url]);
      }
      // The masked auth never reports admin rights.
      const me = (await h.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers })).json();
      expect(me.activeProfile).toMatchObject({ id: kids.kidId, isOwner: false });
      expect(me.user.role).not.toBe('admin');
    }
    // The owner session on the same account is untouched.
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/settings/player', headers: { cookie: kids.ownerCookie } })).statusCode).toBe(200);
  });
});
