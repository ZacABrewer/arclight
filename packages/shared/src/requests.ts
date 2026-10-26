import { z } from 'zod';
import { MediaType, MinimumAvailability, MonitorOption, SeriesType } from './library.js';
import { PushPreferences } from './push.js';

// Requests, discover, issues, watchlists, override rules and per-user request settings.
// Behaviour: docs/spec/requests.md (Seerr parity) and docs/API.md "Requests".

// ---------------------------------------------------------------------------------------
// Permissions (docs/spec/requests.md section 3)
// ---------------------------------------------------------------------------------------

/**
 * Permission bits stored in `users.permissions`. ADMIN passes every check; nothing else is
 * implied. Values follow the spec table so exported data stays comparable.
 */
export const Permission = {
  NONE: 0,
  ADMIN: 2,
  MANAGE_SETTINGS: 4,
  MANAGE_USERS: 8,
  MANAGE_REQUESTS: 16,
  REQUEST: 32,
  VOTE: 64,
  AUTO_APPROVE: 128,
  AUTO_APPROVE_MOVIE: 256,
  AUTO_APPROVE_TV: 512,
  REQUEST_4K: 1024,
  REQUEST_4K_MOVIE: 2048,
  REQUEST_4K_TV: 4096,
  REQUEST_ADVANCED: 8192,
  REQUEST_VIEW: 16384,
  AUTO_APPROVE_4K: 32768,
  AUTO_APPROVE_4K_MOVIE: 65536,
  AUTO_APPROVE_4K_TV: 131072,
  REQUEST_MOVIE: 262144,
  REQUEST_TV: 524288,
  MANAGE_ISSUES: 1048576,
  VIEW_ISSUES: 2097152,
  CREATE_ISSUES: 4194304,
  AUTO_REQUEST: 8388608,
  AUTO_REQUEST_MOVIE: 16777216,
  AUTO_REQUEST_TV: 33554432,
  RECENT_VIEW: 67108864,
  WATCHLIST_VIEW: 134217728,
} as const;
export type PermissionName = keyof typeof Permission;

/** True when `held` has at least one of `wanted` (or ADMIN). An empty list passes. */
export function hasAnyPermission(held: number, wanted: readonly number[]): boolean {
  if (wanted.length === 0) return true;
  if ((held & Permission.ADMIN) !== 0) return true;
  return wanted.some((w) => w === 0 || (held & w) === w);
}

export interface PermissionInfo {
  name: PermissionName;
  value: number;
  label: string;
  description: string;
  group: 'admin' | 'request' | 'autoApprove' | 'autoRequest' | 'issues' | 'view';
}

/** Drives the permissions matrix in the web; order is display order. */
export const PERMISSION_INFO: readonly PermissionInfo[] = [
  { name: 'ADMIN', value: Permission.ADMIN, group: 'admin', label: 'Admin', description: 'Full access; bypasses every other check.' },
  { name: 'MANAGE_SETTINGS', value: Permission.MANAGE_SETTINGS, group: 'admin', label: 'Manage settings', description: 'Edit request settings, sliders and override rules.' },
  { name: 'MANAGE_USERS', value: Permission.MANAGE_USERS, group: 'admin', label: 'Manage users', description: 'Edit permissions and quotas; exempt from quotas; request on behalf of others.' },
  { name: 'MANAGE_REQUESTS', value: Permission.MANAGE_REQUESTS, group: 'admin', label: 'Manage requests', description: 'Approve, decline, edit and delete any request; own requests auto-approve.' },
  { name: 'REQUEST', value: Permission.REQUEST, group: 'request', label: 'Request', description: 'Request movies and series.' },
  { name: 'REQUEST_MOVIE', value: Permission.REQUEST_MOVIE, group: 'request', label: 'Request movies', description: 'Request movies only.' },
  { name: 'REQUEST_TV', value: Permission.REQUEST_TV, group: 'request', label: 'Request series', description: 'Request series only.' },
  { name: 'REQUEST_4K', value: Permission.REQUEST_4K, group: 'request', label: 'Request 4K', description: 'Request 4K movies and series.' },
  { name: 'REQUEST_4K_MOVIE', value: Permission.REQUEST_4K_MOVIE, group: 'request', label: 'Request 4K movies', description: 'Request 4K movies only.' },
  { name: 'REQUEST_4K_TV', value: Permission.REQUEST_4K_TV, group: 'request', label: 'Request 4K series', description: 'Request 4K series only.' },
  { name: 'REQUEST_ADVANCED', value: Permission.REQUEST_ADVANCED, group: 'request', label: 'Advanced requests', description: 'Choose root folder, quality profile and tags on a request.' },
  { name: 'AUTO_APPROVE', value: Permission.AUTO_APPROVE, group: 'autoApprove', label: 'Auto-approve', description: 'Own movie and series requests are approved automatically.' },
  { name: 'AUTO_APPROVE_MOVIE', value: Permission.AUTO_APPROVE_MOVIE, group: 'autoApprove', label: 'Auto-approve movies', description: 'Own movie requests are approved automatically.' },
  { name: 'AUTO_APPROVE_TV', value: Permission.AUTO_APPROVE_TV, group: 'autoApprove', label: 'Auto-approve series', description: 'Own series requests are approved automatically.' },
  { name: 'AUTO_APPROVE_4K', value: Permission.AUTO_APPROVE_4K, group: 'autoApprove', label: 'Auto-approve 4K', description: 'Own 4K requests are approved automatically.' },
  { name: 'AUTO_APPROVE_4K_MOVIE', value: Permission.AUTO_APPROVE_4K_MOVIE, group: 'autoApprove', label: 'Auto-approve 4K movies', description: 'Own 4K movie requests are approved automatically.' },
  { name: 'AUTO_APPROVE_4K_TV', value: Permission.AUTO_APPROVE_4K_TV, group: 'autoApprove', label: 'Auto-approve 4K series', description: 'Own 4K series requests are approved automatically.' },
  { name: 'AUTO_REQUEST', value: Permission.AUTO_REQUEST, group: 'autoRequest', label: 'Auto-request', description: 'Watchlist sync may request movies and series.' },
  { name: 'AUTO_REQUEST_MOVIE', value: Permission.AUTO_REQUEST_MOVIE, group: 'autoRequest', label: 'Auto-request movies', description: 'Watchlist sync may request movies.' },
  { name: 'AUTO_REQUEST_TV', value: Permission.AUTO_REQUEST_TV, group: 'autoRequest', label: 'Auto-request series', description: 'Watchlist sync may request series.' },
  { name: 'MANAGE_ISSUES', value: Permission.MANAGE_ISSUES, group: 'issues', label: 'Manage issues', description: 'Resolve, comment on and delete any issue.' },
  { name: 'CREATE_ISSUES', value: Permission.CREATE_ISSUES, group: 'issues', label: 'Report issues', description: 'Report issues and comment on own issues.' },
  { name: 'VIEW_ISSUES', value: Permission.VIEW_ISSUES, group: 'issues', label: 'View issues', description: "See other users' issues." },
  { name: 'REQUEST_VIEW', value: Permission.REQUEST_VIEW, group: 'view', label: 'View requests', description: "See other users' requests." },
  { name: 'RECENT_VIEW', value: Permission.RECENT_VIEW, group: 'view', label: 'View recently added', description: 'See the recently added slider.' },
  { name: 'WATCHLIST_VIEW', value: Permission.WATCHLIST_VIEW, group: 'view', label: 'View watchlists', description: "See other users' watchlists." },
  { name: 'VOTE', value: Permission.VOTE, group: 'view', label: 'Vote', description: 'Reserved; no behaviour yet.' },
];

// ---------------------------------------------------------------------------------------
// Content restrictions (kids / certification caps; stored in users.settings.contentRestrictions)
// ---------------------------------------------------------------------------------------

/** US movie certifications, youngest audience first. NR as a cap allows everything, unrated included. */
export const MOVIE_CERTIFICATIONS = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR'] as const;
export const MovieCertification = z.enum(MOVIE_CERTIFICATIONS);
export type MovieCertification = z.infer<typeof MovieCertification>;

/** US TV parental guidelines, youngest audience first. */
export const TV_CERTIFICATIONS = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'] as const;
export const TvCertification = z.enum(TV_CERTIFICATIONS);
export type TvCertification = z.infer<typeof TvCertification>;

/**
 * Per-user caps. A capped type hides (discover) and refuses (requests, title pages) titles
 * rated above the cap; titles without a known US rating count as unrated, which only a movie
 * cap of NR admits. `hideAdultContent` hides NC-17 movies and TV-MA series.
 */
export const ContentRestrictions = z.object({
  maxCertification: z
    .object({
      movie: MovieCertification.nullable().default(null),
      tv: TvCertification.nullable().default(null),
    })
    .default({ movie: null, tv: null }),
  hideAdultContent: z.boolean().default(false),
});
export type ContentRestrictions = z.infer<typeof ContentRestrictions>;

/** Per-user override of the approval policies (users.settings.approvalPolicy). */
export const UserApprovalPolicy = z.object({
  /** inherit: the global policies decide; always: policies always auto-approve; never: policies never do. */
  autoApprove: z.enum(['inherit', 'always', 'never']).default('inherit'),
  /** Replaces the global `autoApproveIfSizeBelowGb` for this user (null: inherit). */
  autoApproveIfSizeBelowGb: z.number().min(0).nullable().default(null),
  /** The user's requests are neither limited by nor counted against approval budgets. */
  budgetExempt: z.boolean().default(false),
});
export type UserApprovalPolicy = z.infer<typeof UserApprovalPolicy>;

/**
 * GET/PUT /user/:id/permissions. PUT needs MANAGE_USERS; `contentRestrictions` and
 * `approvalPolicy` are optional on PUT (absent: unchanged) and always present on GET.
 */
export const UserPermissions = z.object({
  permissions: z.number().int().min(0),
  contentRestrictions: ContentRestrictions.optional(),
  approvalPolicy: UserApprovalPolicy.optional(),
});
export type UserPermissions = z.infer<typeof UserPermissions>;

// ---------------------------------------------------------------------------------------
// Quotas (section 4)
// ---------------------------------------------------------------------------------------

/** Limits and window lengths. null means "use the global default" (on a user) or "no quota". */
export const UserQuota = z.object({
  movieLimit: z.number().int().min(0).nullable().default(null),
  movieDays: z.number().int().min(0).nullable().default(null),
  tvLimit: z.number().int().min(0).nullable().default(null),
  tvDays: z.number().int().min(0).nullable().default(null),
});
export type UserQuota = z.infer<typeof UserQuota>;

export const QuotaInfo = z.object({
  /** Window length in days; null: no window (lifetime count). */
  days: z.number().int().nullable(),
  /** null or 0: unlimited. */
  limit: z.number().int().nullable(),
  used: z.number().int(),
  /** null when unlimited. */
  remaining: z.number().int().nullable(),
  restricted: z.boolean(),
});
export type QuotaInfo = z.infer<typeof QuotaInfo>;

export const QuotaStatus = z.object({ movie: QuotaInfo, series: QuotaInfo });
export type QuotaStatus = z.infer<typeof QuotaStatus>;

/** GET/PUT /user/:id/quota response: the user's overrides, what applies, and usage. */
export const UserQuotaResponse = z.object({
  overrides: UserQuota,
  effective: UserQuota,
  /** Exempt users (MANAGE_USERS/ADMIN) have no limits. */
  exempt: z.boolean(),
  status: QuotaStatus,
});
export type UserQuotaResponse = z.infer<typeof UserQuotaResponse>;

// ---------------------------------------------------------------------------------------
// Per-user request settings (stored inside users.settings)
// ---------------------------------------------------------------------------------------

export const UserNotificationTypes = z.object({
  requestApproved: z.boolean().default(true),
  requestDeclined: z.boolean().default(true),
  requestAvailable: z.boolean().default(true),
  /** Admin-audience events: only sent when the user holds the matching manage permission. */
  requestPending: z.boolean().default(true),
  issueCreated: z.boolean().default(true),
  issueUpdated: z.boolean().default(true),
});
export type UserNotificationTypes = z.infer<typeof UserNotificationTypes>;

/**
 * Personal notification agents. Discord uses the user's own webhook (a DM channel or private
 * server); Telegram reuses the bot of the first enabled Telegram connection with the user's
 * chat id; email reuses the SMTP settings of the first enabled email connection.
 */
export const UserNotificationSettings = z.object({
  discordEnabled: z.boolean().default(false),
  discordWebhookUrl: z.string().max(2048).optional(),
  telegramEnabled: z.boolean().default(false),
  telegramChatId: z.string().max(64).optional(),
  telegramSendSilently: z.boolean().default(false),
  emailEnabled: z.boolean().default(false),
  /** Defaults to the account email. */
  email: z.string().max(254).optional(),
  types: UserNotificationTypes.default(UserNotificationTypes.parse({})),
  /** Browser (web push) notifications; managed by the push module (GET/PUT /push/preferences). */
  push: PushPreferences.optional(),
});
export type UserNotificationSettings = z.infer<typeof UserNotificationSettings>;

// ---------------------------------------------------------------------------------------
// Media server (Settings > Media server; user links, sign-in, import, availability)
// ---------------------------------------------------------------------------------------

export const MediaServerKind = z.enum(['jellyfin', 'emby', 'plex']);
export type MediaServerKind = z.infer<typeof MediaServerKind>;

/**
 * Stored form of the `mediaServer` settings section. `apiKey` is a Jellyfin/Emby API key or
 * the Plex owner's X-Plex-Token. `kind: null` means no media server is configured.
 */
export const MediaServerSettings = z.object({
  kind: MediaServerKind.nullable().default(null),
  /** Base URL, e.g. http://jellyfin.lan:8096 (a URL base path is kept). */
  url: z.string().trim().max(2048).default(''),
  apiKey: z.string().max(512).default(''),
  /** Shown in "available on <name>"; defaults to the kind's product name. */
  name: z.string().trim().max(100).default(''),
  /** Users may sign in with their media-server account (Seerr mediaServerLogin). */
  loginEnabled: z.boolean().default(true),
  /** A first media-server sign-in creates a local account (role user, default permissions). */
  createUsersOnLogin: z.boolean().default(true),
});
export type MediaServerSettings = z.infer<typeof MediaServerSettings>;

/** POST /settings/mediaserver/test. */
export const MediaServerTestResult = z.object({
  ok: z.boolean(),
  serverName: z.string().optional(),
  version: z.string().optional(),
  message: z.string().optional(),
});
export type MediaServerTestResult = z.infer<typeof MediaServerTestResult>;

/** A user's link to their media-server account, stored in users.settings.mediaServerLink. */
export const MediaServerLink = z.object({
  kind: MediaServerKind,
  /** Jellyfin/Emby user id or the plex.tv account id. */
  externalId: z.string().min(1),
  username: z.string(),
  /** Jellyfin/Emby access token or Plex auth token. Masked on read. */
  accessToken: z.string().optional(),
  /** Stable Jellyfin/Emby device id used for the token. */
  deviceId: z.string().optional(),
  linkedAt: z.string(),
});
export type MediaServerLink = z.infer<typeof MediaServerLink>;

/** POST /user/:id/mediaserver/link: Jellyfin/Emby credentials, or a completed Plex PIN. */
export const MediaServerLinkRequest = z.union([
  z.object({ username: z.string().trim().min(1), password: z.string() }),
  z.object({ pinId: z.number().int().positive() }),
]);
export type MediaServerLinkRequest = z.infer<typeof MediaServerLinkRequest>;

/** One account on the media server (GET /user/import/mediaserver). */
export const MediaServerUser = z.object({
  externalId: z.string(),
  username: z.string(),
  email: z.string().optional(),
  isAdmin: z.boolean(),
  isDisabled: z.boolean(),
  /** Local user already linked to this account. */
  linkedUserId: z.number().int().nullable(),
});
export type MediaServerUser = z.infer<typeof MediaServerUser>;

/** POST /user/import/mediaserver. Absent `externalIds`: every enabled, unlinked account. */
export const MediaServerImportRequest = z.object({ externalIds: z.array(z.string().min(1)).optional() });
export type MediaServerImportRequest = z.infer<typeof MediaServerImportRequest>;

export const MediaServerImportResult = z.object({
  created: z.array(z.object({ id: z.number().int(), username: z.string(), externalId: z.string() })),
  skipped: z.array(z.object({ externalId: z.string(), reason: z.string() })),
});
export type MediaServerImportResult = z.infer<typeof MediaServerImportResult>;

/** POST /auth/plex/pin: open `authUrl` in a popup, then poll with `id`. */
export const PlexPin = z.object({ id: z.number().int(), code: z.string(), authUrl: z.string() });
export type PlexPin = z.infer<typeof PlexPin>;

export const PlexPollRequest = z.object({ id: z.number().int().positive(), rememberMe: z.boolean().default(true) });
export type PlexPollRequest = z.input<typeof PlexPollRequest>;

/** POST /auth/plex/poll while the user has not finished in the popup. */
export const PlexPollPending = z.object({ pending: z.literal(true) });
export type PlexPollPending = z.infer<typeof PlexPollPending>;

/** GET/PUT /user/:id/requestsettings. `plexToken` and the link's token read back masked; the link is read-only here. */
export const UserRequestSettings = z.object({
  notifications: UserNotificationSettings.default(UserNotificationSettings.parse({})),
  plexToken: z.string().max(256).optional(),
  watchlistSyncMovies: z.boolean().default(false),
  watchlistSyncSeries: z.boolean().default(false),
  /** Master switch: watchlist sync may create requests (still needs AUTO_REQUEST and the per-type flag). */
  autoRequestFromWatchlist: z.boolean().default(true),
  /** Set through /user/:id/mediaserver/link; ignored on PUT. */
  mediaServerLink: MediaServerLink.optional(),
});
export type UserRequestSettings = z.infer<typeof UserRequestSettings>;

/** Placeholder returned for stored secrets; sending it back keeps the stored value. */
export const REQUEST_SECRET_MASK = '********';

export const UserNotificationTestResult = z.object({
  results: z.array(z.object({ agent: z.enum(['discord', 'telegram', 'email']), ok: z.boolean(), error: z.string().optional() })),
});
export type UserNotificationTestResult = z.infer<typeof UserNotificationTestResult>;

// ---------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------

export const RequestStatus = z.enum(['pending', 'approved', 'declined', 'failed', 'completed']);
export type RequestStatus = z.infer<typeof RequestStatus>;

/** Availability of a title (one per track: normal and 4K). */
export const MediaStatus = z.enum(['unknown', 'pending', 'processing', 'partiallyAvailable', 'available']);
export type MediaStatus = z.infer<typeof MediaStatus>;

export const RequestUser = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string().optional(),
  avatar: z.string().optional(),
});
export type RequestUser = z.infer<typeof RequestUser>;

// ---------------------------------------------------------------------------------------
// Requests (sections 5-7)
// ---------------------------------------------------------------------------------------

export const SeasonRequest = z.object({
  seasonNumber: z.number().int().min(0),
  status: RequestStatus,
});
export type SeasonRequest = z.infer<typeof SeasonRequest>;

export const MediaRequest = z.object({
  id: z.number().int(),
  type: MediaType,
  status: RequestStatus,
  is4k: z.boolean(),
  mediaTmdbId: z.number().int(),
  mediaTvdbId: z.number().int().nullish(),
  mediaTitle: z.string(),
  mediaYear: z.number().int().nullish(),
  mediaPoster: z.string().nullish(),
  mediaBackdrop: z.string().nullish(),
  /** Series only; empty for movies. */
  seasons: z.array(SeasonRequest),
  requestedBy: RequestUser,
  modifiedBy: RequestUser.nullable(),
  /** Overrides applied when the request is sent to the library (null: settings default). */
  rootFolderPath: z.string().nullish(),
  qualityProfileId: z.number().int().nullish(),
  tags: z.array(z.number().int()),
  ignoreQuota: z.boolean(),
  isAutoRequest: z.boolean(),
  declineReason: z.string().nullish(),
  failureReason: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The request's track (normal or 4K). */
  mediaStatus: MediaStatus,
  /** Library series/movie id once added. */
  libraryId: z.number().int().nullish(),
  /** Whether the caller may delete this request. */
  canRemove: z.boolean(),
  /** Name of the media server the title was found on (useMediaServerAvailability), else null. */
  availableOn: z.string().nullish(),
  /** Pending because an approval window holds it (GET /request/:id/policy explains). */
  heldByPolicy: z.boolean().optional(),
});
export type MediaRequest = z.infer<typeof MediaRequest>;

/** POST /request. 201 with the request, or 202 with a message when no seasons remain. */
export const CreateRequest = z.object({
  mediaType: MediaType,
  tmdbId: z.number().int().positive(),
  /** Series only: season numbers or "all" (every regular season not already requested/available). */
  seasons: z.union([z.array(z.number().int().min(0)).min(1), z.literal('all')]).optional(),
  is4k: z.boolean().default(false),
  rootFolderPath: z.string().min(1).optional(),
  qualityProfileId: z.number().int().optional(),
  tags: z.array(z.number().int()).optional(),
  /** Request on behalf of another user (MANAGE_USERS or MANAGE_REQUESTS). */
  userId: z.number().int().positive().optional(),
  /** MANAGE_REQUESTS only: the request does not count toward the requester's quota. */
  ignoreQuota: z.boolean().optional(),
});
export type CreateRequest = z.input<typeof CreateRequest>;

/** PUT /request/:id. Only pending requests; null clears an override. */
export const UpdateRequest = z.object({
  seasons: z.array(z.number().int().min(0)).min(1).optional(),
  rootFolderPath: z.string().min(1).nullable().optional(),
  qualityProfileId: z.number().int().nullable().optional(),
  tags: z.array(z.number().int()).optional(),
  userId: z.number().int().positive().optional(),
});
export type UpdateRequest = z.infer<typeof UpdateRequest>;

export const DeclineRequest = z.object({ reason: z.string().max(1000).optional() });
export type DeclineRequest = z.infer<typeof DeclineRequest>;

/** POST /request/:id/approve body (optional): last-minute overrides by the approver. */
export const ApproveRequest = z.object({
  rootFolderPath: z.string().min(1).optional(),
  qualityProfileId: z.number().int().optional(),
  tags: z.array(z.number().int()).optional(),
  /** Series only: how episodes are monitored when the series is added (default: the requested seasons only). */
  monitorOption: MonitorOption.optional(),
  /** Movies only: minimum availability for the library movie (default: the requests settings). */
  minimumAvailability: MinimumAvailability.optional(),
  /** Series only: replaces the requested seasons before the request is sent to the library. */
  seasons: z.array(z.number().int().min(0)).min(1).optional(),
});
export type ApproveRequest = z.infer<typeof ApproveRequest>;

export const BulkRequestAction = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });
export type BulkRequestAction = z.infer<typeof BulkRequestAction>;

export const BulkRequestResult = z.object({
  ok: z.array(z.number().int()),
  failed: z.array(z.object({ id: z.number().int(), error: z.string() })),
});
export type BulkRequestResult = z.infer<typeof BulkRequestResult>;

export const RequestAccepted = z.object({ message: z.string() });
export type RequestAccepted = z.infer<typeof RequestAccepted>;

export const RequestFilter = z.enum([
  'all',
  'pending',
  'approved',
  'processing',
  'unavailable',
  'declined',
  'failed',
  'completed',
  'available',
]);
export type RequestFilter = z.infer<typeof RequestFilter>;

export const RequestListQuery = z.object({
  take: z.coerce.number().int().min(1).max(500).default(20),
  skip: z.coerce.number().int().min(0).default(0),
  filter: RequestFilter.default('all'),
  mediaType: z.enum(['all', 'movie', 'series']).default('all'),
  requestedBy: z.coerce.number().int().positive().optional(),
  sort: z.enum(['added', 'modified']).default('added'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
});
export type RequestListQuery = z.input<typeof RequestListQuery>;

export const PageInfo = z.object({ total: z.number().int(), take: z.number().int(), skip: z.number().int() });
export type PageInfo = z.infer<typeof PageInfo>;

export const RequestPage = z.object({ pageInfo: PageInfo, results: z.array(MediaRequest) });
export type RequestPage = z.infer<typeof RequestPage>;

export const RequestCount = z.object({
  total: z.number().int(),
  movie: z.number().int(),
  series: z.number().int(),
  pending: z.number().int(),
  approved: z.number().int(),
  declined: z.number().int(),
  failed: z.number().int(),
  processing: z.number().int(),
  available: z.number().int(),
  completed: z.number().int(),
});
export type RequestCount = z.infer<typeof RequestCount>;

// ---------------------------------------------------------------------------------------
// Issues (section 13)
// ---------------------------------------------------------------------------------------

export const IssueType = z.enum(['video', 'audio', 'subtitles', 'other']);
export type IssueType = z.infer<typeof IssueType>;
export const IssueStatus = z.enum(['open', 'resolved']);
export type IssueStatus = z.infer<typeof IssueStatus>;

export const IssueComment = z.object({
  id: z.number().int(),
  user: RequestUser,
  message: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueComment = z.infer<typeof IssueComment>;

export const Issue = z.object({
  id: z.number().int(),
  type: IssueType,
  status: IssueStatus,
  mediaType: MediaType,
  mediaTmdbId: z.number().int(),
  mediaTitle: z.string(),
  mediaYear: z.number().int().nullish(),
  mediaPoster: z.string().nullish(),
  libraryId: z.number().int().nullish(),
  /** 0: not specific. */
  problemSeason: z.number().int().min(0),
  problemEpisode: z.number().int().min(0),
  createdBy: RequestUser,
  modifiedBy: RequestUser.nullable(),
  comments: z.array(IssueComment),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const CreateIssue = z.object({
  type: IssueType,
  mediaType: MediaType,
  tmdbId: z.number().int().positive(),
  /** Becomes the first comment. */
  message: z.string().trim().min(1).max(5000),
  problemSeason: z.number().int().min(0).default(0),
  problemEpisode: z.number().int().min(0).default(0),
  /** Report on behalf of another user (MANAGE_ISSUES). */
  userId: z.number().int().positive().optional(),
});
export type CreateIssue = z.input<typeof CreateIssue>;

export const IssueCommentInput = z.object({ message: z.string().trim().min(1).max(5000) });
export type IssueCommentInput = z.infer<typeof IssueCommentInput>;

export const IssueStatusUpdate = z.object({ status: IssueStatus });
export type IssueStatusUpdate = z.infer<typeof IssueStatusUpdate>;

export const IssueListQuery = z.object({
  take: z.coerce.number().int().min(1).max(500).default(20),
  skip: z.coerce.number().int().min(0).default(0),
  filter: z.enum(['open', 'resolved', 'all']).default('open'),
  sort: z.enum(['added', 'modified']).default('added'),
  createdBy: z.coerce.number().int().positive().optional(),
  tmdbId: z.coerce.number().int().positive().optional(),
  mediaType: MediaType.optional(),
  type: IssueType.optional(),
});
export type IssueListQuery = z.input<typeof IssueListQuery>;

export const IssuePage = z.object({ pageInfo: PageInfo, results: z.array(Issue) });
export type IssuePage = z.infer<typeof IssuePage>;

export const IssueCount = z.object({
  total: z.number().int(),
  video: z.number().int(),
  audio: z.number().int(),
  subtitles: z.number().int(),
  other: z.number().int(),
  open: z.number().int(),
  resolved: z.number().int(),
});
export type IssueCount = z.infer<typeof IssueCount>;

// ---------------------------------------------------------------------------------------
// Override rules (section 8)
// ---------------------------------------------------------------------------------------

export const OverrideRuleInput = z.object({
  name: z.string().trim().min(1).max(100),
  mediaType: MediaType,
  /** null: applies to both tracks. */
  is4k: z.boolean().nullable().default(null),
  enabled: z.boolean().default(true),
  /** Conditions; an empty condition always holds. */
  users: z.array(z.number().int()).default([]),
  genres: z.array(z.number().int()).default([]),
  /** ISO 639-1 codes; matches the title's original language. */
  languages: z.array(z.string().min(2).max(3)).default([]),
  keywords: z.array(z.number().int()).default([]),
  /** Results; null leaves the value alone. Tags are unioned. */
  qualityProfileId: z.number().int().nullable().default(null),
  rootFolderPath: z.string().min(1).nullable().default(null),
  tags: z.array(z.number().int()).default([]),
  /** Matching requests are approved automatically. */
  autoApprove: z.boolean().default(false),
});
export type OverrideRuleInput = z.input<typeof OverrideRuleInput>;

export const OverrideRule = OverrideRuleInput.extend({ id: z.number().int() });
export type OverrideRule = z.infer<typeof OverrideRule>;

// ---------------------------------------------------------------------------------------
// Discover (section 15)
// ---------------------------------------------------------------------------------------

export const DiscoverSliderType = z.enum([
  'recentlyAdded',
  'recentRequests',
  'watchlist',
  'trending',
  'popularMovies',
  'movieGenres',
  'upcomingMovies',
  'studios',
  'popularTv',
  'tvGenres',
  'upcomingTv',
  'networks',
  'tmdbMovieKeyword',
  'tmdbMovieGenre',
  'tmdbTvKeyword',
  'tmdbTvGenre',
  'tmdbSearch',
  'tmdbStudio',
  'tmdbNetwork',
  // Built-ins added with the full catalogue (existing installs get them appended).
  'nowPlaying',
  'topRatedMovies',
  'airingTv',
  'topRatedTv',
  'providers',
]);
export type DiscoverSliderType = z.infer<typeof DiscoverSliderType>;

/** Built-in slider types, in default order (a fresh install shows them like this). */
export const BUILT_IN_SLIDERS: readonly DiscoverSliderType[] = [
  'recentlyAdded',
  'recentRequests',
  'watchlist',
  'trending',
  'popularMovies',
  'movieGenres',
  'upcomingMovies',
  'nowPlaying',
  'topRatedMovies',
  'studios',
  'popularTv',
  'tvGenres',
  'upcomingTv',
  'airingTv',
  'topRatedTv',
  'networks',
  'providers',
];

/** Sliders that render a list of tiles (genres, logos) rather than posters. */
export const TILE_SLIDERS: readonly DiscoverSliderType[] = ['movieGenres', 'tvGenres', 'studios', 'networks', 'providers'];

/** Sliders about the caller (their requests, their watchlist): hidden from anonymous portal visitors. */
export const PERSONAL_SLIDERS: readonly DiscoverSliderType[] = ['recentRequests', 'watchlist'];

export const DiscoverSlider = z.object({
  id: z.number().int(),
  type: DiscoverSliderType,
  order: z.number().int(),
  isBuiltIn: z.boolean(),
  enabled: z.boolean(),
  /** null for built-ins (the web names them). */
  title: z.string().nullable(),
  /** Keyword/genre/studio/network id or search text for custom sliders. */
  data: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DiscoverSlider = z.infer<typeof DiscoverSlider>;

export const DiscoverSliderInput = z.object({
  type: DiscoverSliderType,
  title: z.string().trim().min(1).max(100),
  data: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
});
export type DiscoverSliderInput = z.input<typeof DiscoverSliderInput>;

export const DiscoverSliderUpdate = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  data: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
});
export type DiscoverSliderUpdate = z.infer<typeof DiscoverSliderUpdate>;

/** PUT /discoverslider/order: every slider id in display order with its enabled flag. */
export const DiscoverSliderOrder = z.array(z.object({ id: z.number().int(), enabled: z.boolean() })).min(1);
export type DiscoverSliderOrder = z.infer<typeof DiscoverSliderOrder>;

/** A TMDB result annotated with what Arclight knows about it. */
export const DiscoverItem = z.object({
  mediaType: MediaType,
  tmdbId: z.number().int(),
  title: z.string(),
  originalTitle: z.string().optional(),
  year: z.number().int().nullish(),
  overview: z.string(),
  posterUrl: z.string().nullish(),
  backdropUrl: z.string().nullish(),
  rating: z.number().nullish(),
  voteCount: z.number().int().nullish(),
  popularity: z.number().nullish(),
  releaseDate: z.string().nullish(),
  originalLanguage: z.string().optional(),
  mediaStatus: MediaStatus,
  mediaStatus4k: MediaStatus,
  /** The newest active request on the normal track, if any. */
  requestId: z.number().int().nullish(),
  /**
   * Status of that request; `declined` when there is no active request and the newest request
   * on the normal track was declined (so posters can show a Declined badge).
   */
  requestStatus: RequestStatus.nullish(),
  libraryId: z.number().int().nullish(),
});
export type DiscoverItem = z.infer<typeof DiscoverItem>;

export const DiscoverPage = z.object({
  page: z.number().int(),
  totalPages: z.number().int(),
  totalResults: z.number().int(),
  results: z.array(DiscoverItem),
  /** Network/studio/keyword name when the page is about one. */
  title: z.string().optional(),
  imageUrl: z.string().optional(),
});
export type DiscoverPage = z.infer<typeof DiscoverPage>;

export const DISCOVER_MOVIE_SORTS = [
  'popularity.desc',
  'popularity.asc',
  'vote_average.desc',
  'vote_average.asc',
  'vote_count.desc',
  'vote_count.asc',
  'primary_release_date.desc',
  'primary_release_date.asc',
  'revenue.desc',
  'revenue.asc',
  'original_title.asc',
  'original_title.desc',
] as const;
export const DISCOVER_TV_SORTS = [
  'popularity.desc',
  'popularity.asc',
  'vote_average.desc',
  'vote_average.asc',
  'vote_count.desc',
  'vote_count.asc',
  'first_air_date.desc',
  'first_air_date.asc',
  'original_name.asc',
  'original_name.desc',
] as const;

const csvIds = z
  .string()
  .regex(/^\d+([,|]\d+)*$/, 'comma or pipe separated ids')
  .optional();
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
/** A query-string flag: true/1 or false/0 (z.coerce.boolean would read "false" as true). */
const queryFlag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')
  .optional();
const regionCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .transform((v) => v.toUpperCase())
  .optional();

/** GET /discover/movies and /discover/tv. Invalid sort values fall back to popularity.desc. */
export const DiscoverQuery = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  sortBy: z.string().max(40).optional(),
  genre: csvIds,
  keywords: csvIds,
  studio: z.coerce.number().int().positive().optional(),
  network: z.coerce.number().int().positive().optional(),
  language: z.string().min(2).max(3).optional(),
  releaseDateGte: dateOnly,
  releaseDateLte: dateOnly,
  voteAverageGte: z.coerce.number().min(0).max(10).optional(),
  voteAverageLte: z.coerce.number().min(0).max(10).optional(),
  voteCountGte: z.coerce.number().int().min(0).optional(),
  runtimeGte: z.coerce.number().int().min(0).optional(),
  runtimeLte: z.coerce.number().int().min(0).optional(),
  watchProviders: csvIds,
  /** Region for watchProviders; defaults to the instance region (Settings > Metadata). */
  watchRegion: regionCode,
  /** Exact certification, e.g. PG-13 or TV-14. */
  certification: z.string().trim().min(1).max(12).optional(),
  /** Certifications up to and including this one. */
  certificationLte: z.string().trim().min(1).max(12).optional(),
  /** Country of the certification filters; defaults to the instance region. */
  certificationCountry: regionCode,
  /** Leave out titles already available in the library (this page only). */
  hideAvailable: queryFlag,
  /** Leave out titles with an active request (this page only). */
  hideRequested: queryFlag,
});
export type DiscoverQuery = z.input<typeof DiscoverQuery>;

/** Ready-made lists: GET /discover/list/:list. */
export const DiscoverListName = z.enum([
  'popularMovies',
  'popularTv',
  'upcomingMovies',
  'upcomingTv',
  'nowPlaying',
  'topRatedMovies',
  'topRatedTv',
  'airingToday',
  'onTheAir',
]);
export type DiscoverListName = z.infer<typeof DiscoverListName>;

export const DiscoverListQuery = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  hideAvailable: queryFlag,
  hideRequested: queryFlag,
});
export type DiscoverListQuery = z.input<typeof DiscoverListQuery>;

export const TrendingQuery = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  mediaType: z.enum(['all', 'movie', 'tv']).default('all'),
  timeWindow: z.enum(['day', 'week']).default('day'),
});
export type TrendingQuery = z.input<typeof TrendingQuery>;

export const DiscoverKindQuery = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  mediaType: z.enum(['movie', 'tv']).default('movie'),
});
export type DiscoverKindQuery = z.input<typeof DiscoverKindQuery>;

export const DiscoverSearchQuery = z.object({
  query: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().min(1).max(500).default(1),
  /** all: movies and series (multi search). */
  mediaType: z.enum(['all', 'movie', 'tv']).default('all'),
});
export type DiscoverSearchQuery = z.input<typeof DiscoverSearchQuery>;

/** GET /discover/search/people and /discover/keywords. */
export const DiscoverTextQuery = z.object({
  query: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().min(1).max(500).default(1),
});
export type DiscoverTextQuery = z.input<typeof DiscoverTextQuery>;

export const DiscoverGenre = z.object({ id: z.number().int(), name: z.string() });
export type DiscoverGenre = z.infer<typeof DiscoverGenre>;

/** A home-page tile: genre with a backdrop, studio/network/provider with a logo. */
export const DiscoverTile = z.object({
  id: z.number().int(),
  name: z.string(),
  imageUrl: z.string().nullish(),
});
export type DiscoverTile = z.infer<typeof DiscoverTile>;

/** GET /discover/genres/tiles, /discover/companies, /discover/providers. */
export const DiscoverTileQuery = z.object({
  mediaType: z.enum(['movie', 'tv']).default('movie'),
  /** Providers only; defaults to the instance region. */
  region: regionCode,
});
export type DiscoverTileQuery = z.input<typeof DiscoverTileQuery>;

/** GET /discover/info/:kind/:id: the name (and logo) of what a grid page is about. */
export const DiscoverEntityKind = z.enum(['studio', 'network', 'keyword']);
export type DiscoverEntityKind = z.infer<typeof DiscoverEntityKind>;
export const DiscoverEntity = z.object({ id: z.number().int(), name: z.string(), imageUrl: z.string().nullish() });
export type DiscoverEntity = z.infer<typeof DiscoverEntity>;

export const DiscoverCode = z.object({ code: z.string(), name: z.string() });
export type DiscoverCode = z.infer<typeof DiscoverCode>;

export const DiscoverCertification = z.object({ certification: z.string(), meaning: z.string() });
export type DiscoverCertification = z.infer<typeof DiscoverCertification>;

/** GET /discover/options: filter vocabularies for the browse filter bar. */
export const DiscoverFilterOptions = z.object({
  /** Instance defaults (Settings > Metadata). */
  region: z.string(),
  language: z.string(),
  regions: z.array(DiscoverCode),
  languages: z.array(DiscoverCode),
  certifications: z.object({ movie: z.array(DiscoverCertification), tv: z.array(DiscoverCertification) }),
});
export type DiscoverFilterOptions = z.infer<typeof DiscoverFilterOptions>;

export const PersonSummary = z.object({
  tmdbId: z.number().int(),
  name: z.string(),
  profileUrl: z.string().nullish(),
  knownForDepartment: z.string().nullish(),
  /** Titles of what the person is known for. */
  knownFor: z.array(z.string()),
});
export type PersonSummary = z.infer<typeof PersonSummary>;

export const PersonPage = z.object({
  page: z.number().int(),
  totalPages: z.number().int(),
  totalResults: z.number().int(),
  results: z.array(PersonSummary),
});
export type PersonPage = z.infer<typeof PersonPage>;

export const KeywordPage = z.object({
  page: z.number().int(),
  totalPages: z.number().int(),
  totalResults: z.number().int(),
  results: z.array(DiscoverGenre),
});
export type KeywordPage = z.infer<typeof KeywordPage>;

/** GET /discover/collection/:id. */
export const CollectionDetail = z.object({
  tmdbId: z.number().int(),
  name: z.string(),
  overview: z.string(),
  posterUrl: z.string().nullish(),
  backdropUrl: z.string().nullish(),
  parts: z.array(DiscoverItem),
  /** Parts nobody has requested and the library lacks (what "Request all missing" sends). */
  missing: z.number().int(),
  canRequest: z.boolean(),
  canRequest4k: z.boolean(),
});
export type CollectionDetail = z.infer<typeof CollectionDetail>;

/** POST /discover/collection/:id/request. */
export const CollectionRequestInput = z.object({ is4k: z.boolean().default(false) });
export type CollectionRequestInput = z.input<typeof CollectionRequestInput>;

export const CollectionRequestResult = z.object({
  requested: z.array(z.object({ tmdbId: z.number().int(), title: z.string(), status: RequestStatus.nullable() })),
  skipped: z.number().int(),
  failed: z.array(z.object({ tmdbId: z.number().int(), title: z.string(), error: z.string() })),
});
export type CollectionRequestResult = z.infer<typeof CollectionRequestResult>;

export const CastMember = z.object({
  tmdbId: z.number().int(),
  name: z.string(),
  character: z.string().optional(),
  profileUrl: z.string().nullish(),
});
export type CastMember = z.infer<typeof CastMember>;

export const CrewMember = z.object({
  tmdbId: z.number().int(),
  name: z.string(),
  job: z.string(),
  department: z.string().optional(),
  profileUrl: z.string().nullish(),
});
export type CrewMember = z.infer<typeof CrewMember>;

export const TitleVideo = z.object({
  name: z.string(),
  key: z.string(),
  site: z.string(),
  type: z.string(),
  /** Watch URL (YouTube/Vimeo) when the site is known. */
  url: z.string().optional(),
});
export type TitleVideo = z.infer<typeof TitleVideo>;

export const TitleCompany = z.object({ id: z.number().int(), name: z.string(), logoUrl: z.string().nullish() });
export type TitleCompany = z.infer<typeof TitleCompany>;

export const TitleSeason = z.object({
  seasonNumber: z.number().int(),
  name: z.string().optional(),
  episodeCount: z.number().int(),
  airDate: z.string().nullish(),
  posterUrl: z.string().nullish(),
  status: MediaStatus,
  status4k: MediaStatus,
  /** Status of the active request covering this season, if any. */
  requestStatus: RequestStatus.nullish(),
  requestStatus4k: RequestStatus.nullish(),
});
export type TitleSeason = z.infer<typeof TitleSeason>;

/** GET /discover/movie/:tmdbId and /discover/tv/:tmdbId. */
export const TitleDetail = DiscoverItem.extend({
  tagline: z.string().nullish(),
  status: z.string().nullish(),
  runtimeMinutes: z.number().int().nullish(),
  imdbId: z.string().nullish(),
  tvdbId: z.number().int().nullish(),
  genres: z.array(DiscoverGenre),
  keywords: z.array(DiscoverGenre),
  companies: z.array(TitleCompany),
  cast: z.array(CastMember),
  crew: z.array(CrewMember),
  videos: z.array(TitleVideo),
  similar: z.array(DiscoverItem),
  recommendations: z.array(DiscoverItem),
  /** Series only. */
  seasons: z.array(TitleSeason),
  /** Requests for this title the caller may see. */
  requests: z.array(MediaRequest),
  canRequest: z.boolean(),
  canRequest4k: z.boolean(),
  /** The caller may set root folder, profile and tags. */
  canRequestAdvanced: z.boolean(),
  onWatchlist: z.boolean(),
  openIssues: z.number().int(),
  /** Movies: the collection the movie belongs to. */
  collection: z.object({ id: z.number().int(), name: z.string() }).nullish(),
  /** Movies: release dates in the instance region (YYYY-MM-DD). */
  releaseDates: z
    .object({ inCinemas: z.string().nullish(), digital: z.string().nullish(), physical: z.string().nullish() })
    .nullish(),
  /** Age rating in the instance region (US fallback), e.g. PG-13 or TV-14. */
  certification: z.string().nullish(),
  /** Series: first and last air date. */
  firstAirDate: z.string().nullish(),
  lastAirDate: z.string().nullish(),
});
export type TitleDetail = z.infer<typeof TitleDetail>;

export const PersonCredit = DiscoverItem.extend({
  character: z.string().optional(),
  job: z.string().optional(),
});
export type PersonCredit = z.infer<typeof PersonCredit>;

export const PersonDetail = z.object({
  tmdbId: z.number().int(),
  name: z.string(),
  biography: z.string(),
  birthday: z.string().nullish(),
  deathday: z.string().nullish(),
  placeOfBirth: z.string().nullish(),
  knownForDepartment: z.string().nullish(),
  profileUrl: z.string().nullish(),
  cast: z.array(PersonCredit),
  crew: z.array(PersonCredit),
});
export type PersonDetail = z.infer<typeof PersonDetail>;

/** Well-known TMDB studios/networks for the built-in "studios" and "networks" sliders. */
export const POPULAR_STUDIOS: readonly { id: number; name: string }[] = [
  { id: 2, name: 'Disney' },
  { id: 127928, name: '20th Century Studios' },
  { id: 34, name: 'Sony Pictures' },
  { id: 174, name: 'Warner Bros. Pictures' },
  { id: 33, name: 'Universal' },
  { id: 4, name: 'Paramount' },
  { id: 3, name: 'Pixar' },
  { id: 521, name: 'DreamWorks' },
  { id: 420, name: 'Marvel Studios' },
  { id: 9993, name: 'DC' },
  { id: 41077, name: 'A24' },
];
export const POPULAR_NETWORKS: readonly { id: number; name: string }[] = [
  { id: 213, name: 'Netflix' },
  { id: 2739, name: 'Disney+' },
  { id: 1024, name: 'Prime Video' },
  { id: 2552, name: 'Apple TV+' },
  { id: 453, name: 'Hulu' },
  { id: 49, name: 'HBO' },
  { id: 3186, name: 'Max' },
  { id: 2, name: 'ABC' },
  { id: 19, name: 'FOX' },
  { id: 6, name: 'NBC' },
  { id: 16, name: 'CBS' },
  { id: 4330, name: 'Paramount+' },
  { id: 4, name: 'BBC One' },
  { id: 67, name: 'Showtime' },
];

// ---------------------------------------------------------------------------------------
// Watchlist (section 11)
// ---------------------------------------------------------------------------------------

export const WatchlistSource = z.enum(['manual', 'plex', 'jellyfin', 'emby']);
export type WatchlistSource = z.infer<typeof WatchlistSource>;

export const WatchlistItem = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  mediaType: MediaType,
  tmdbId: z.number().int(),
  title: z.string(),
  year: z.number().int().nullish(),
  posterUrl: z.string().nullish(),
  source: WatchlistSource,
  createdAt: z.string(),
  mediaStatus: MediaStatus,
  requestId: z.number().int().nullish(),
  requestStatus: RequestStatus.nullish(),
});
export type WatchlistItem = z.infer<typeof WatchlistItem>;

export const WatchlistCreate = z.object({ mediaType: MediaType, tmdbId: z.number().int().positive() });
export type WatchlistCreate = z.infer<typeof WatchlistCreate>;

export const WatchlistQuery = z.object({ userId: z.coerce.number().int().positive().optional() });
export type WatchlistQuery = z.input<typeof WatchlistQuery>;

export const WatchlistSyncResult = z.object({ users: z.number().int(), added: z.number().int(), requested: z.number().int() });

/** POST /request/digest: what the digest contained (sent: false when nothing was pending). */
export const RequestsDigestResult = z.object({
  sent: z.boolean(),
  pendingRequests: z.number().int(),
  openIssues: z.number().int(),
});
export type RequestsDigestResult = z.infer<typeof RequestsDigestResult>;
export type WatchlistSyncResult = z.infer<typeof WatchlistSyncResult>;

// ---------------------------------------------------------------------------------------
// Settings (GET/PUT /settings/requests)
// ---------------------------------------------------------------------------------------

export const RequestTypeDefaults = z.object({
  /** null: the first root folder of the media type. */
  rootFolderPath: z.string().min(1).nullable().default(null),
  /** null: the first quality profile. */
  qualityProfileId: z.number().int().nullable().default(null),
  tags: z.array(z.number().int()).default([]),
  /** Series added for a request always monitor only the requested seasons; this applies to new seasons. */
  monitorNewItems: z.enum(['all', 'none']).default('none'),
  monitorOption: MonitorOption.default('none'),
  minimumAvailability: MinimumAvailability.default('released'),
  seriesType: SeriesType.default('standard'),
  seasonFolder: z.boolean().default(true),
  searchOnAdd: z.boolean().default(true),
});
export type RequestTypeDefaults = z.infer<typeof RequestTypeDefaults>;

export const Request4kDefaults = z.object({
  enabled: z.boolean().default(false),
  rootFolderPath: z.string().min(1).nullable().default(null),
  qualityProfileId: z.number().int().nullable().default(null),
  tags: z.array(z.number().int()).default([]),
});
export type Request4kDefaults = z.infer<typeof Request4kDefaults>;

// ---------------------------------------------------------------------------------------
// Approval policies (budgets, windows, size) and the public portal
// ---------------------------------------------------------------------------------------

/**
 * A rolling auto-approval budget. Requests it covers are auto-approved while the usage of the
 * last `periodDays` (approved and completed requests of the scope) plus this request stays
 * within `movieGb` (estimated sizes of movie requests) / `tvSeasons` (seasons of series
 * requests). A limit left out means the budget does not cover that media type.
 * `autoApproveUnder.sizeGb` additionally requires the request itself to be smaller.
 */
export const ApprovalBudget = z.object({
  /** user: each user has their own budget; role: one budget per role; all: one shared budget. */
  scope: z.enum(['user', 'role', 'all']),
  /** scope role: the role it applies to (absent: every role, each with its own budget). */
  role: z.enum(['admin', 'user']).optional(),
  /** scope user: limit to these users (absent: everyone). */
  userIds: z.array(z.number().int().positive()).optional(),
  movieGb: z.number().min(0).optional(),
  tvSeasons: z.number().int().min(0).optional(),
  periodDays: z.number().int().min(1).max(365),
  autoApproveUnder: z.object({ sizeGb: z.number().min(0).optional() }).default({}),
});
export type ApprovalBudget = z.infer<typeof ApprovalBudget>;

/**
 * A weekly window (server local time). `days` are 0 (Sunday) to 6; `endHour` is exclusive and
 * may be at or below `startHour` to wrap past midnight (the window belongs to the day it
 * starts on). autoApprove: requests made inside are approved, and requests held outside are
 * approved when it opens (RequestsPolicySweep). hold: nothing is auto-approved inside;
 * requests that would have been are held until it closes.
 */
export const ApprovalWindow = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(24),
  action: z.enum(['autoApprove', 'hold']),
});
export type ApprovalWindow = z.infer<typeof ApprovalWindow>;

export const PolicyStep = z.object({
  rule: z.enum(['permission', 'settings', 'overrideRule', 'userOverride', 'size', 'budget', 'window']),
  outcome: z.enum(['pass', 'fail', 'skip']),
  message: z.string(),
});
export type PolicyStep = z.infer<typeof PolicyStep>;

/** The built-in portal path; always on while the portal is enabled. */
export const DEFAULT_PORTAL_PATH = '/portal';

/**
 * First path segments the portal path list may not use: the app's own pages, the api, the
 * Sonarr/Radarr compatibility routes and the static files the server answers at the root.
 */
export const RESERVED_PORTAL_SEGMENTS: readonly string[] = [
  // app pages (apps/web/src/router.tsx)
  'activity', 'calendar', 'design', 'discover', 'docs', 'indexers', 'issues', 'library', 'login', 'portal',
  'profile', 'requests', 'search', 'settings', 'setup', 'subtitles', 'system', 'wanted', 'watchlist',
  // server routes and static files
  'api', 'assets', 'icons', 'metrics', 'ping', 'initialize.json', 'initialize.js', 'sw.js', 'manifest.webmanifest',
  'offline.html', 'index.html', 'favicon.ico', 'robots.txt',
];

/**
 * The portal's own pages, by first segment below the portal root (`<path>/movie/603`). On a
 * portal hostname these answer at the root (`/movie/603`); the root itself is portal home.
 */
export const PORTAL_ROUTE_SEGMENTS: readonly string[] = [
  'movies', 'tv', 'movie', 'person', 'search', 'trending', 'upcoming', 'list', 'collection',
  'genre', 'keyword', 'studio', 'network', 'provider', 'requests',
];

/** "/watch", "watch" or "/Watch/" → "/watch". */
export function normalizePortalPath(raw: string): string {
  return `/${raw.trim().toLowerCase().replace(/^\/+|\/+$/g, '')}`;
}

/** A portal path: one segment of letters, digits, '-' or '_', not used by the app. */
export const PortalPath = z
  .string()
  .max(64)
  .transform(normalizePortalPath)
  .refine((p) => /^\/[a-z0-9][a-z0-9_-]{0,62}$/.test(p), { message: 'one path segment of letters, digits, - or _' })
  .refine((p) => !RESERVED_PORTAL_SEGMENTS.includes(p.slice(1)), { message: 'this path is used by Arclight itself' });

/** A hostname that serves the portal at its root (e.g. requests.example.com). */
export const PortalHost = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'a hostname without scheme, port or path'),
  /** Admin pages on this hostname send visitors to the portal (signed-in admins too). */
  portalOnly: z.boolean().default(true),
});
export type PortalHost = z.infer<typeof PortalHost>;

export const PublicPortalSettings = z.object({
  enabled: z.boolean().default(false),
  /** Anonymous visitors may browse GET /discover/* (rate-limited per IP); requesting needs sign-in. */
  allowAnonymousDiscover: z.boolean().default(false),
  message: z.string().max(2000).default(''),
  /** Extra paths that open the portal on any hostname, besides /portal (e.g. /watch). */
  paths: z
    .array(PortalPath)
    .max(20)
    .default([])
    .refine((list) => new Set(list).size === list.length, { message: 'each path once' }),
  /** Hostnames that show the portal at their root. */
  hosts: z
    .array(PortalHost)
    .max(20)
    .default([])
    .refine((list) => new Set(list.map((h) => h.hostname)).size === list.length, { message: 'each hostname once' }),
});
export type PublicPortalSettings = z.infer<typeof PublicPortalSettings>;

export const RequestsSettings = z.object({
  movie: RequestTypeDefaults.default(RequestTypeDefaults.parse({})),
  series: RequestTypeDefaults.default(RequestTypeDefaults.parse({})),
  movie4k: Request4kDefaults.default(Request4kDefaults.parse({})),
  series4k: Request4kDefaults.default(Request4kDefaults.parse({})),
  /** Everyone's requests of that kind are approved automatically. */
  autoApprove: z
    .object({
      movie: z.boolean().default(false),
      series: z.boolean().default(false),
      movie4k: z.boolean().default(false),
      series4k: z.boolean().default(false),
    })
    .default({ movie: false, series: false, movie4k: false, series4k: false }),
  defaultQuotas: UserQuota.default(UserQuota.parse({})),
  /** Suggested permissions for new users (the users editor pre-fills it). */
  defaultPermissions: z.number().int().min(0).default(Permission.REQUEST | Permission.CREATE_ISSUES),
  /** false: series requests must cover every season. */
  partialRequestsEnabled: z.boolean().default(true),
  enableSpecialEpisodes: z.boolean().default(false),
  hideAvailable: z.boolean().default(false),
  hideRequested: z.boolean().default(false),
  /**
   * Availability comes from the media server (Settings > Media server; falling back to the
   * Jellyfin/Emby connections under Settings > Notifications): requests complete only once the
   * server has the title (series: every requested season fully present). false: library only.
   */
  useMediaServerAvailability: z.boolean().default(false),
  /** Public URL of this Arclight, used for links (approve/decline) in notifications. */
  applicationUrl: z.string().trim().max(2048).default(''),
  /** Daily admin digest of pending requests and open issues (RequestsDigest job). */
  digestEnabled: z.boolean().default(false),
  /** Local hour (0-23) the digest is sent at. */
  digestHour: z.number().int().min(0).max(23).default(9),
  /** Auto-approval budgets (approval policies; evaluated after permissions and override rules). */
  approvalBudgets: z.array(ApprovalBudget).default([]),
  /** Weekly windows that auto-approve or hold requests (server local time). */
  approvalWindows: z.array(ApprovalWindow).default([]),
  /** Auto-approve when the best approved release (quick interactive search) is smaller; null: off. */
  autoApproveIfSizeBelowGb: z.number().min(0).nullable().default(null),
  /** Public request portal: anonymous discover and the login page's portal message. */
  publicPortal: PublicPortalSettings.default(PublicPortalSettings.parse({})),
});
export type RequestsSettings = z.infer<typeof RequestsSettings>;

/** GET /request/:id/policy: why a request is (or would be) pending, held or approved. */
export const RequestPolicyExplanation = z.object({
  requestId: z.number().int(),
  status: RequestStatus,
  /** What the policies decide now. */
  decision: z.enum(['approve', 'hold', 'pending']),
  /** The request waits for a window (RequestsPolicySweep approves it). */
  held: z.boolean(),
  estimatedSizeBytes: z.number().int().nullable(),
  /** Next autoApprove window opening (for held requests), else null. */
  nextWindowAt: z.string().nullable(),
  steps: z.array(PolicyStep),
});
export type RequestPolicyExplanation = z.infer<typeof RequestPolicyExplanation>;

/** GET /public/portal (public while the portal is enabled). */
export const PublicPortal = z.object({
  enabled: z.boolean(),
  /** Branding. */
  title: z.string(),
  applicationUrl: z.string(),
  message: z.string(),
  allowAnonymousDiscover: z.boolean(),
  loginMethods: z.object({
    local: z.boolean(),
    mediaServer: z.object({ kind: MediaServerKind, name: z.string().optional() }).nullable(),
    plex: z.boolean(),
  }),
});
export type PublicPortal = z.infer<typeof PublicPortal>;

/**
 * How the page the server sent relates to the portal; the server writes it into index.html
 * (`<meta name="arclight-portal">`) so the web router can map the address bar onto its routes.
 * path: the portal answers below `base` (e.g. /watch). host: this hostname is a portal hostname
 * and the portal answers at the root.
 */
export const PortalDocument = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('path'), base: z.string() }),
  z.object({ mode: z.literal('host'), portalOnly: z.boolean() }),
]);
export type PortalDocument = z.infer<typeof PortalDocument>;
