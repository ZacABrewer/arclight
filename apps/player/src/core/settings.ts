import type { StreamFormat } from '@arclight/shared';
import { preferencesStore, readJson, writeJson, type KeyValueStore } from './kv';

// The app's own settings (this device only). Server-side player settings (what the admin allows)
// come from GET /playback/me and cap these.

/** 'original' plays the file as stored; the others ask the server for an AAC transcode. */
export type StreamQuality = 'original' | 'aac-320' | 'aac-256' | 'aac-192' | 'aac-128' | 'aac-96' | 'aac-64';

export const STREAM_QUALITIES: StreamQuality[] = ['original', 'aac-320', 'aac-256', 'aac-192', 'aac-128', 'aac-96', 'aac-64'];

export interface AppSettings {
  /** Streaming on Wi-Fi / Ethernet. */
  wifiQuality: StreamQuality;
  /** Streaming on a cellular (metered) network. */
  cellularQuality: StreamQuality;
  /** Quality of offline copies. */
  downloadQuality: StreamQuality;
  /** Downloads wait for Wi-Fi. */
  downloadsWifiOnly: boolean;
  /** Most the downloads may use, in GB (0: no limit beyond free space). */
  storageLimitGb: number;
  /** Keep this much free on the device, in GB. */
  keepFreeGb: number;
  /** Locale code, or 'system'. */
  language: string;
  /** Send play progress from this device (resume elsewhere, history). */
  reportProgress: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  wifiQuality: 'original',
  cellularQuality: 'aac-128',
  downloadQuality: 'original',
  downloadsWifiOnly: true,
  storageLimitGb: 0,
  keepFreeGb: 1,
  language: 'system',
  reportProgress: true,
};

const KEY = 'arclight.settings';

/** A quality as a stream request: format and bitrate, capped by the server's limit. */
export function qualityRequest(q: StreamQuality, maxBitrateKbps?: number | null): { format: StreamFormat; bitrateKbps?: number } {
  if (q === 'original') {
    // The server transcodes on its own when a remote request is over its cap.
    return { format: 'original' };
  }
  const kbps = Number(q.split('-')[1]);
  return { format: 'aac', bitrateKbps: maxBitrateKbps && maxBitrateKbps > 0 ? Math.min(kbps, maxBitrateKbps) : kbps };
}

export function qualityLabel(q: StreamQuality): string {
  return q === 'original' ? 'Original' : `AAC ${q.split('-')[1]} kbps`;
}

type Listener = (s: AppSettings) => void;

export class SettingsStore {
  private value: AppSettings = { ...DEFAULT_SETTINGS };
  private readonly listeners = new Set<Listener>();

  constructor(private readonly kv: KeyValueStore = preferencesStore) {}

  async load(): Promise<AppSettings> {
    const stored = await readJson<Partial<AppSettings>>(this.kv, KEY);
    this.value = sanitise({ ...DEFAULT_SETTINGS, ...(stored ?? {}) });
    return this.value;
  }

  get(): AppSettings {
    return this.value;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.value = sanitise({ ...this.value, ...patch });
    await writeJson(this.kv, KEY, this.value);
    for (const l of [...this.listeners]) l(this.value);
    return this.value;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function sanitise(s: AppSettings): AppSettings {
  const q = (v: unknown, d: StreamQuality): StreamQuality => (STREAM_QUALITIES.includes(v as StreamQuality) ? (v as StreamQuality) : d);
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    wifiQuality: q(s.wifiQuality, DEFAULT_SETTINGS.wifiQuality),
    cellularQuality: q(s.cellularQuality, DEFAULT_SETTINGS.cellularQuality),
    downloadQuality: q(s.downloadQuality, DEFAULT_SETTINGS.downloadQuality),
    downloadsWifiOnly: typeof s.downloadsWifiOnly === 'boolean' ? s.downloadsWifiOnly : DEFAULT_SETTINGS.downloadsWifiOnly,
    storageLimitGb: n(s.storageLimitGb, 0),
    keepFreeGb: n(s.keepFreeGb, 1),
    language: typeof s.language === 'string' && s.language ? s.language : 'system',
    reportProgress: typeof s.reportProgress === 'boolean' ? s.reportProgress : true,
  };
}
