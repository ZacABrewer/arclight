import {
  SECRET_MASK,
  SUBTITLE_PROVIDER_IDS,
  type SubtitleMediaType,
  type SubtitleProviderConfig,
  type SubtitleProviderField,
  type SubtitleProviderId,
  type SubtitleProviderSchema,
} from '@arclight/shared';
import {
  Addic7edProvider,
  AnimetoshoProvider,
  EmbeddedProvider,
  GestdownProvider,
  JimakuProvider,
  Napisy24Provider,
  OpenSubtitlesComProvider,
  PodnapisiProvider,
  Subf2mProvider,
  SubdlProvider,
  WhisperProvider,
  YifySubtitlesProvider,
  type EmbeddedDeps,
  type ProviderContext,
  type SubtitleProvider,
  type WhisperDeps,
} from '@arclight/subtitles';

// Provider registry: the settings form for each provider (field definitions derived from the
// package's config types) and the factory that turns stored settings into a client.

export interface ProviderDeps {
  ctx: ProviderContext;
  embedded: EmbeddedDeps;
  whisper: WhisperDeps;
  ffmpegPath: string;
}

interface ProviderDef {
  name: string;
  description: string;
  mediaTypes: SubtitleMediaType[];
  needsAuth: boolean;
  fields: SubtitleProviderField[];
  create(settings: Record<string, unknown>, deps: ProviderDeps): SubtitleProvider;
}

const BOTH: SubtitleMediaType[] = ['series', 'movie'];
const DEFAULT_BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

type FieldOpts = Partial<Omit<SubtitleProviderField, 'name' | 'label' | 'type'>>;
const field = (name: string, label: string, type: SubtitleProviderField['type'], o: FieldOpts = {}): SubtitleProviderField => ({
  name,
  label,
  type,
  required: false,
  secret: type === 'password',
  ...o,
});

const str = (s: Record<string, unknown>, k: string): string | undefined => {
  const v = s[k];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const num = (s: Record<string, unknown>, k: string): number | undefined => {
  const v = typeof s[k] === 'string' ? Number(s[k]) : s[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const bool = (s: Record<string, unknown>, k: string): boolean | undefined => (typeof s[k] === 'boolean' ? (s[k] as boolean) : undefined);

export const PROVIDER_DEFS: Readonly<Record<SubtitleProviderId, ProviderDef>> = {
  embeddedsubtitles: {
    name: 'Embedded Subtitles',
    description: 'Extracts text subtitle tracks already inside the video container (needs ffprobe and ffmpeg).',
    mediaTypes: BOTH,
    needsAuth: false,
    fields: [
      field('hiFallback', 'Use HI track as fallback', 'checkbox', { default: false, helpText: 'Use a hearing-impaired track when no normal one exists.' }),
      field('unknownAsFallback', 'Use unknown-language tracks', 'checkbox', { default: false }),
      field('fallbackLanguage', 'Fallback language', 'text', { default: 'en', advanced: true, helpText: 'Language assumed for tracks without one.' }),
    ],
    create: (s, d) =>
      new EmbeddedProvider(
        {
          hiFallback: bool(s, 'hiFallback'),
          unknownAsFallback: bool(s, 'unknownAsFallback'),
          fallbackLanguage: str(s, 'fallbackLanguage'),
          ffmpegPath: d.ffmpegPath,
        },
        d.embedded,
        d.ctx,
      ),
  },
  opensubtitlescom: {
    name: 'OpenSubtitles.com',
    description: 'OpenSubtitles REST API. Needs an account and an API consumer key.',
    mediaTypes: BOTH,
    needsAuth: true,
    fields: [
      field('username', 'Username', 'text', { required: true }),
      field('password', 'Password', 'password', { required: true }),
      field('apiKey', 'API key', 'password', { required: true, helpText: 'Consumer key from opensubtitles.com/consumers.' }),
      field('useHash', 'Search by file hash', 'checkbox', { default: true }),
      field('includeAiTranslated', 'Include AI translated', 'checkbox', { default: false, advanced: true }),
      field('includeMachineTranslated', 'Include machine translated', 'checkbox', { default: false, advanced: true }),
    ],
    create: (s, d) =>
      new OpenSubtitlesComProvider(
        {
          username: str(s, 'username') ?? '',
          password: str(s, 'password') ?? '',
          apiKey: str(s, 'apiKey') ?? '',
          useHash: bool(s, 'useHash'),
          includeAiTranslated: bool(s, 'includeAiTranslated'),
          includeMachineTranslated: bool(s, 'includeMachineTranslated'),
        },
        d.ctx,
      ),
  },
  subdl: {
    name: 'Subdl',
    description: 'subdl.com API. Needs an API key.',
    mediaTypes: BOTH,
    needsAuth: true,
    fields: [
      field('apiKey', 'API key', 'password', { required: true }),
      field('includeAiTranslated', 'Include AI translated', 'checkbox', { default: false, advanced: true }),
    ],
    create: (s, d) => new SubdlProvider({ apiKey: str(s, 'apiKey') ?? '', includeAiTranslated: bool(s, 'includeAiTranslated') }, d.ctx),
  },
  addic7ed: {
    name: 'Addic7ed',
    description: 'TV-focused site. Needs an account (or session cookies); free accounts are limited per day.',
    mediaTypes: BOTH,
    needsAuth: true,
    fields: [
      field('username', 'Username', 'text'),
      field('password', 'Password', 'password'),
      field('cookies', 'Cookies', 'password', { advanced: true, helpText: 'Raw cookie header; overrides the login.' }),
      field('vip', 'VIP account', 'checkbox', { default: false }),
    ],
    create: (s, d) =>
      new Addic7edProvider(
        { username: str(s, 'username'), password: str(s, 'password'), cookies: str(s, 'cookies'), vip: bool(s, 'vip') },
        d.ctx,
      ),
  },
  podnapisi: {
    name: 'Podnapisi',
    description: 'podnapisi.net search (best effort).',
    mediaTypes: BOTH,
    needsAuth: false,
    fields: [
      field('maxPages', 'Pages per search', 'number', { default: 3, min: 1, max: 10, advanced: true }),
      field('baseUrl', 'Base URL', 'text', { advanced: true }),
    ],
    create: (s, d) => new PodnapisiProvider({ maxPages: num(s, 'maxPages'), baseUrl: str(s, 'baseUrl') }, d.ctx),
  },
  gestdown: {
    name: 'Gestdown',
    description: 'Addic7ed proxy API by series TVDB id. Episodes only.',
    mediaTypes: ['series'],
    needsAuth: false,
    fields: [field('baseUrl', 'Base URL', 'text', { advanced: true })],
    create: (s, d) => new GestdownProvider({ baseUrl: str(s, 'baseUrl') }, d.ctx),
  },
  subf2m: {
    name: 'Subf2m',
    description: 'subf2m.co scraping. A browser user agent is required.',
    mediaTypes: BOTH,
    needsAuth: false,
    fields: [field('userAgent', 'User agent', 'text', { required: true, default: DEFAULT_BROWSER_UA })],
    create: (s, d) => new Subf2mProvider({ userAgent: str(s, 'userAgent') ?? DEFAULT_BROWSER_UA }, d.ctx),
  },
  napisy24: {
    name: 'Napisy24',
    description: 'Polish subtitles by file hash. Needs an account.',
    mediaTypes: BOTH,
    needsAuth: true,
    fields: [field('username', 'Username', 'text', { required: true }), field('password', 'Password', 'password', { required: true })],
    create: (s, d) => new Napisy24Provider({ username: str(s, 'username') ?? '', password: str(s, 'password') ?? '' }, d.ctx),
  },
  animetosho: {
    name: 'Animetosho',
    description: 'Anime subtitles attached to releases, by AniDB episode id. Episodes only.',
    mediaTypes: ['series'],
    needsAuth: false,
    fields: [
      field('searchThreshold', 'Releases to inspect', 'number', { default: 6, min: 1, max: 30 }),
      field('feedUrl', 'Feed URL', 'text', { advanced: true }),
      field('storageUrl', 'Storage URL', 'text', { advanced: true }),
    ],
    create: (s, d) =>
      new AnimetoshoProvider({ searchThreshold: num(s, 'searchThreshold') ?? 6, feedUrl: str(s, 'feedUrl'), storageUrl: str(s, 'storageUrl') }, d.ctx),
  },
  jimaku: {
    name: 'Jimaku',
    description: 'Japanese anime subtitles. Needs an API key.',
    mediaTypes: BOTH,
    needsAuth: true,
    fields: [
      field('apiKey', 'API key', 'password', { required: true }),
      field('nameSearchFallback', 'Search by name without AniList id', 'checkbox', { default: true }),
      field('archives', 'Allow archives', 'checkbox', { default: true, advanced: true }),
      field('aiSubs', 'Allow AI-generated subtitles', 'checkbox', { default: false, advanced: true }),
    ],
    create: (s, d) =>
      new JimakuProvider(
        { apiKey: str(s, 'apiKey') ?? '', nameSearchFallback: bool(s, 'nameSearchFallback'), archives: bool(s, 'archives'), aiSubs: bool(s, 'aiSubs') },
        d.ctx,
      ),
  },
  yifysubtitles: {
    name: 'YIFY Subtitles',
    description: 'Movie subtitles by IMDb id. Movies only.',
    mediaTypes: ['movie'],
    needsAuth: false,
    fields: [field('baseUrl', 'Base URL', 'text', { advanced: true })],
    create: (s, d) => new YifySubtitlesProvider({ baseUrl: str(s, 'baseUrl') }, d.ctx),
  },
  whisperai: {
    name: 'Whisper (ASR)',
    description: 'Generates subtitles from the audio through a Whisper-ASR web service. Slow; keep last.',
    mediaTypes: BOTH,
    needsAuth: false,
    fields: [
      field('endpoint', 'Endpoint', 'text', { required: true, default: 'http://127.0.0.1:9000' }),
      field('transcribeTimeoutMs', 'Transcription timeout (ms)', 'number', { default: 3_600_000, advanced: true }),
      field('passVideoName', 'Send the video name', 'checkbox', { default: false, advanced: true }),
    ],
    create: (s, d) =>
      new WhisperProvider(
        {
          endpoint: str(s, 'endpoint') ?? '',
          transcribeTimeoutMs: num(s, 'transcribeTimeoutMs'),
          passVideoName: bool(s, 'passVideoName'),
          ffmpegPath: d.ffmpegPath,
        },
        d.whisper,
        d.ctx,
      ),
  },
};

export function providerSchemas(): SubtitleProviderSchema[] {
  return SUBTITLE_PROVIDER_IDS.map((id) => {
    const d = PROVIDER_DEFS[id];
    return { id, name: d.name, description: d.description, mediaTypes: d.mediaTypes, needsAuth: d.needsAuth, fields: d.fields };
  });
}

export function providerName(id: string): string {
  return (PROVIDER_DEFS as Record<string, ProviderDef | undefined>)[id]?.name ?? id;
}

/** Missing required fields, or null when the settings look complete. */
export function configError(id: SubtitleProviderId, settings: Record<string, unknown>): string | null {
  const missing = PROVIDER_DEFS[id].fields.filter((f) => f.required && (settings[f.name] === undefined || settings[f.name] === null || settings[f.name] === ''));
  return missing.length ? `missing ${missing.map((f) => f.label).join(', ')}` : null;
}

const secretNames = (id: SubtitleProviderId) => new Set(PROVIDER_DEFS[id].fields.filter((f) => f.secret).map((f) => f.name));

/** Replace stored secrets with SECRET_MASK. */
export function maskProviders(list: readonly SubtitleProviderConfig[]): SubtitleProviderConfig[] {
  return list.map((p) => {
    const secrets = secretNames(p.id);
    const settings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p.settings)) settings[k] = secrets.has(k) && typeof v === 'string' && v !== '' ? SECRET_MASK : v;
    return { ...p, settings };
  });
}

/** Restore stored secrets where the client sent SECRET_MASK back. */
export function unmaskSettings(id: SubtitleProviderId, incoming: Record<string, unknown>, stored: Record<string, unknown> | undefined): Record<string, unknown> {
  const secrets = secretNames(id);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (secrets.has(k) && v === SECRET_MASK) {
      if (stored?.[k] !== undefined) out[k] = stored[k];
    } else out[k] = v;
  }
  return out;
}

/** True when any secret/credential field changed (used to reset auth throttles, R13.8). */
export function credentialsChanged(id: SubtitleProviderId, a: Record<string, unknown> | undefined, b: Record<string, unknown>): boolean {
  const names = PROVIDER_DEFS[id].fields.filter((f) => f.secret || f.name === 'username').map((f) => f.name);
  return names.some((n) => (a?.[n] ?? '') !== (b[n] ?? ''));
}
