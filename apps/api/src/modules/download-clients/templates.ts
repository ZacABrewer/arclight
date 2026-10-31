import {
  downloadClientProtocols,
  downloadClientSettingsSchemas as packageSchemas,
  type DownloadClientKind,
  type DownloadClientSettingsInput,
} from '@arclight/download-clients';
import {
  DOWNLOAD_CLIENT_PROTOCOLS,
  DOWNLOAD_CLIENT_SECRET_FIELDS,
  DownloadClientImplementation,
  downloadClientSettingsSchemas,
  type DownloadClientField,
  type DownloadClientImplementationSchema,
  type DownloadClientInput,
  type DownloadClientSettingsFor,
} from '@arclight/shared';
import { z } from 'zod';

// Field definitions the UI renders for each implementation, derived from the shared settings
// schemas: types, defaults, bounds and options from the Zod shape, help texts from `.describe()`.
// Common fields come first, then the implementation's settings (named `settings.<key>` so the
// form can write them back).

// ---------------------------------------------------------------------------------------
// Contract sync: shared mirrors the package's kinds and settings (shared cannot depend on the
// package). Fail typechecking, then startup, if they ever drift apart.
// ---------------------------------------------------------------------------------------

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsInSync: Same<DownloadClientKind, DownloadClientImplementation> = true;
void kindsInSync;

/** Stored (shared, parsed) settings of each kind must be accepted by the package factory. */
type SettingsAccepted = {
  [K in DownloadClientKind]: DownloadClientSettingsFor<K> extends DownloadClientSettingsInput<K> ? true : false;
};
const settingsInSync: SettingsAccepted = {
  qbittorrent: true,
  transmission: true,
  deluge: true,
  rtorrent: true,
  sabnzbd: true,
  nzbget: true,
  builtin: true,
  remoteEngine: true,
};
void settingsInSync;

/** Runtime half of the check: same kinds, same protocols, shared settings keys cover the package's. */
export function assertContractInSync(): void {
  for (const kind of DownloadClientImplementation.options) {
    if (!(kind in packageSchemas)) throw new Error(`Download client kind "${kind}" is not known to @arclight/download-clients`);
    if (downloadClientProtocols[kind] !== DOWNLOAD_CLIENT_PROTOCOLS[kind]) {
      throw new Error(`Download client "${kind}" protocol differs between shared and @arclight/download-clients`);
    }
    const sharedKeys = new Set(Object.keys(downloadClientSettingsSchemas[kind].shape));
    const missing = Object.keys(packageSchemas[kind].shape).filter((k) => !sharedKeys.has(k));
    if (missing.length > 0) throw new Error(`Shared ${kind} settings lack ${missing.join(', ')}`);
  }
  if (Object.keys(packageSchemas).length !== DownloadClientImplementation.options.length) {
    throw new Error('DownloadClientImplementation is out of sync with DownloadClientKind');
  }
}
assertContractInSync();

// ---------------------------------------------------------------------------------------
// Common fields
// ---------------------------------------------------------------------------------------

const commonFields: DownloadClientField[] = [
  { name: 'name', label: 'Name', type: 'text', helpText: 'A name for this download client.', required: true, advanced: false },
  { name: 'enable', label: 'Enable', type: 'checkbox', helpText: 'Use this client for grabs and queue tracking.', required: false, advanced: false, default: true },
  {
    name: 'priority',
    label: 'Client Priority',
    type: 'number',
    helpText: 'Priority when several clients handle the same protocol: 1 is the highest, 50 the lowest. Clients of equal priority are used in rotation.',
    required: true,
    advanced: true,
    default: 1,
    min: 1,
    max: 50,
  },
  {
    name: 'removeCompletedDownloads',
    label: 'Remove Completed',
    type: 'checkbox',
    helpText: 'Remove downloads Arclight grabbed from the client, with their files, once imported and allowed to be removed (seeding goals met). Torrents Arclight did not grab are never removed.',
    required: false,
    advanced: true,
    default: true,
  },
  {
    name: 'removeFailedDownloads',
    label: 'Remove Failed',
    type: 'checkbox',
    helpText: 'Remove failed downloads from the client.',
    required: false,
    advanced: true,
    default: true,
  },
  {
    name: 'tags',
    label: 'Tags',
    type: 'text',
    helpText: 'Only use this client for series/movies with at least one matching tag. Leave empty to use it for everything.',
    required: false,
    advanced: true,
  },
];

// ---------------------------------------------------------------------------------------
// Per-kind metadata the schemas cannot express: names, descriptions, labels, advanced flags
// ---------------------------------------------------------------------------------------

interface KindMeta {
  name: string;
  description: string;
  infoLink: string;
  /** Settings keys hidden behind "Show advanced". */
  advanced: readonly string[];
  /** Label overrides for this kind's settings keys. */
  labels?: Readonly<Record<string, string>>;
}

const KIND_META: Record<DownloadClientImplementation, KindMeta> = {
  qbittorrent: {
    name: 'qBittorrent',
    description: 'Free, open-source BitTorrent client with a WebUI (API v2, qBittorrent 4.1 or newer).',
    infoLink: 'https://www.qbittorrent.org/',
    advanced: ['urlBase', 'postImportCategory', 'sequentialOrder', 'firstAndLast', 'contentLayout'],
  },
  transmission: {
    name: 'Transmission',
    description: 'Lightweight BitTorrent daemon, driven through its JSON RPC interface (Transmission 2.80 or newer).',
    infoLink: 'https://transmissionbt.com/',
    advanced: ['urlBase', 'postImportCategory', 'directory'],
    labels: { category: 'Label', postImportCategory: 'Post-Import Label' },
  },
  deluge: {
    name: 'Deluge',
    description: 'BitTorrent client driven through the Deluge Web UI (1.3 or 2.x); categories use the Label plugin.',
    infoLink: 'https://deluge-torrent.org/',
    advanced: ['urlBase', 'postImportCategory'],
    labels: { category: 'Label', postImportCategory: 'Post-Import Label' },
  },
  rtorrent: {
    name: 'rTorrent',
    description: 'rTorrent (0.9.6 or newer) over XML-RPC through a web server or ruTorrent; labels are ruTorrent compatible.',
    infoLink: 'https://github.com/rakshasa/rtorrent',
    advanced: ['urlBase', 'postImportCategory', 'directory'],
    labels: { category: 'Label', postImportCategory: 'Post-Import Label', urlBase: 'URL Path' },
  },
  sabnzbd: {
    name: 'SABnzbd',
    description: 'Usenet (NZB) downloader with a web API (SABnzbd 1.0 or newer, 3.0+ recommended).',
    infoLink: 'https://sabnzbd.org/',
    advanced: ['urlBase', 'postImportCategory', 'username', 'password'],
  },
  nzbget: {
    name: 'NZBGet',
    description: 'Efficient Usenet (NZB) downloader driven through its JSON-RPC API (NZBGet 16 or newer).',
    infoLink: 'https://nzbget.com/',
    advanced: ['urlBase', 'postImportCategory'],
  },
  builtin: {
    name: 'Built-in',
    description:
      "Arclight's own BitTorrent engine, running inside Arclight. Engine-wide options (port, limits, VPN binding) are under Settings > Torrent Engine.",
    infoLink: '/settings/torrent',
    advanced: ['postImportCategory', 'categories', 'seedRatioLimit', 'seedTimeLimitMinutes'],
    labels: { savePath: 'Download Folder', categories: 'Category Folders', seedTimeLimitMinutes: 'Seed Time Limit (minutes)' },
  },
  remoteEngine: {
    name: 'Remote Engine',
    description:
      "Arclight's BitTorrent engine running on another machine: the engine agent on a seedbox or VPS, or another Arclight. Finished downloads are imported from shared storage or copied over (pull mode).",
    infoLink: '/docs/remote-engine',
    advanced: ['postImportCategory', 'bandwidthLimitKbps', 'followVpnPort'],
    labels: {
      url: 'Agent URL',
      token: 'Token',
      pullMode: 'Pull Mode',
      localDownloadPath: 'Local Download Folder',
      bandwidthLimitKbps: 'Copy Limit (KiB/s)',
      followVpnPort: 'Follow VPN Port',
    },
  },
};

const LABELS: Record<string, string> = {
  host: 'Host',
  port: 'Port',
  useSsl: 'Use SSL',
  urlBase: 'URL Base',
  apiKey: 'API Key',
  username: 'Username',
  password: 'Password',
  category: 'Category',
  postImportCategory: 'Post-Import Category',
  directory: 'Directory',
  recentPriority: 'Recent Priority',
  olderPriority: 'Older Priority',
  initialState: 'Initial State',
  addPaused: 'Add Paused',
  sequentialOrder: 'Sequential Order',
  firstAndLast: 'First and Last First',
  contentLayout: 'Content Layout',
};

const OPTION_LABELS: Record<string, string> = {
  start: 'Started',
  pause: 'Paused',
  forceStart: 'Force Started',
  subfolder: 'Create Subfolder',
  noSubfolder: "Don't Create Subfolder",
  veryLow: 'Very Low',
  veryHigh: 'Very High',
};

/** Prefilled host for a fresh client (the schemas deliberately have no default host). */
const TEMPLATE_HOST = 'localhost';
/** Prefilled agent address for a fresh remote engine (the standalone agent's default port). */
const REMOTE_ENGINE_TEMPLATE_URL = 'http://localhost:7879';

function humanize(value: string): string {
  const spaced = value.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---------------------------------------------------------------------------------------
// Zod shape -> field definition
// ---------------------------------------------------------------------------------------

interface Unwrapped {
  inner: z.ZodType;
  description: string | undefined;
  optional: boolean;
  defaultValue: unknown;
}

/** Peels optional/default wrappers, keeping the first description and default found. */
function unwrap(schema: z.ZodType): Unwrapped {
  let current: z.ZodType = schema;
  let description: string | undefined;
  let optional = false;
  let defaultValue: unknown;
  for (;;) {
    description ??= current.description;
    const def = current._zod.def as { type: string; innerType?: z.ZodType; defaultValue?: unknown };
    if (def.type === 'optional' && def.innerType) {
      optional = true;
      current = def.innerType;
    } else if (def.type === 'default' && def.innerType) {
      optional = true;
      defaultValue ??= def.defaultValue;
      current = def.innerType;
    } else {
      return { inner: current, description, optional, defaultValue };
    }
  }
}

function settingsField(kind: DownloadClientImplementation, key: string, schema: z.ZodType): DownloadClientField {
  const meta = KIND_META[kind];
  const { inner, description, optional, defaultValue } = unwrap(schema);
  const field: DownloadClientField = {
    name: `settings.${key}`,
    label: meta.labels?.[key] ?? LABELS[key] ?? humanize(key),
    type: 'text',
    helpText: description ?? '',
    required: !optional,
    advanced: meta.advanced.includes(key),
  };
  if (inner instanceof z.ZodBoolean) {
    field.type = 'checkbox';
    field.required = false;
  } else if (inner instanceof z.ZodNumber) {
    field.type = 'number';
    if (inner.minValue !== null && Number.isFinite(inner.minValue)) field.min = inner.minValue;
    if (inner.maxValue !== null && Number.isFinite(inner.maxValue)) field.max = inner.maxValue;
  } else if (inner instanceof z.ZodEnum) {
    field.type = 'select';
    field.options = inner.options.map((v) => ({ value: String(v), label: OPTION_LABELS[String(v)] ?? humanize(String(v)) }));
  } else if ((DOWNLOAD_CLIENT_SECRET_FIELDS as readonly string[]).includes(key)) {
    field.type = 'password';
  }
  if (key === 'host') field.default = TEMPLATE_HOST;
  else if (kind === 'remoteEngine' && key === 'url') field.default = REMOTE_ENGINE_TEMPLATE_URL;
  else if (typeof defaultValue === 'string' || typeof defaultValue === 'number' || typeof defaultValue === 'boolean') {
    field.default = defaultValue;
  }
  return field;
}

/** The settings-form fields of one implementation (without the common fields). */
export function settingsFields(kind: DownloadClientImplementation): DownloadClientField[] {
  const shape = downloadClientSettingsSchemas[kind].shape as Record<string, z.ZodType>;
  return Object.entries(shape).map(([key, schema]) => settingsField(kind, key, schema));
}

function template(kind: DownloadClientImplementation): DownloadClientInput {
  const meta = KIND_META[kind];
  const common = {
    name: meta.name,
    enable: true,
    protocol: DOWNLOAD_CLIENT_PROTOCOLS[kind],
    priority: 1,
    removeCompletedDownloads: true,
    removeFailedDownloads: true,
    tags: [],
  };
  // Parsing `{ host }` fills every default the schema declares (`builtin` has no host).
  const raw = { host: TEMPLATE_HOST };
  switch (kind) {
    case 'qbittorrent':
      return { ...common, implementation: kind, settings: downloadClientSettingsSchemas[kind].parse(raw) };
    case 'transmission':
      return { ...common, implementation: kind, settings: downloadClientSettingsSchemas[kind].parse(raw) };
    case 'deluge':
      return { ...common, implementation: kind, settings: downloadClientSettingsSchemas[kind].parse(raw) };
    case 'rtorrent':
      return { ...common, implementation: kind, settings: downloadClientSettingsSchemas[kind].parse(raw) };
    case 'sabnzbd':
      return { ...common, implementation: kind, settings: downloadClientSettingsSchemas[kind].parse(raw) };
    case 'nzbget':
      return { ...common, implementation: kind, settings: downloadClientSettingsSchemas[kind].parse(raw) };
    case 'builtin':
      return { ...common, implementation: kind, settings: downloadClientSettingsSchemas[kind].parse({}) };
    case 'remoteEngine':
      return { ...common, implementation: kind, settings: downloadClientSettingsSchemas[kind].parse({ url: REMOTE_ENGINE_TEMPLATE_URL }) };
  }
}

export function implementationSchemas(): DownloadClientImplementationSchema[] {
  return DownloadClientImplementation.options.map((kind) => {
    const meta = KIND_META[kind];
    return {
      implementation: kind,
      implementationName: meta.name,
      protocol: DOWNLOAD_CLIENT_PROTOCOLS[kind],
      description: meta.description,
      infoLink: meta.infoLink,
      fields: [...commonFields, ...settingsFields(kind)],
      template: template(kind),
    };
  });
}
