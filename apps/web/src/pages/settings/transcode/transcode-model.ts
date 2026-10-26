import {
  TranscodeRuleInput,
  type TranscodeAction,
  type TranscodeAudioCodec,
  type TranscodeContainer,
  type TranscodeHwaccel,
  type TranscodeMediaType,
  type TranscodeOptionsInput,
  type TranscodeRule,
  type TranscodeRuleInputRaw,
  type TranscodeVideoCodec,
  type TranscodeWhen,
} from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Draft <-> body for the transcode rule editor, and the action/options matrix: which options
// each action uses (docs/API.md "transcode"; contract packages/shared/src/transcode.ts).

export type OptionKey = 'container' | 'videoCodec' | 'crf' | 'preset' | 'hwaccel' | 'audio' | 'channels' | 'keepLanguages' | 'dropSubtitles';

/** Options an action reads. keepLanguages / dropSubtitles apply to every action. */
export const ACTION_OPTIONS: Record<TranscodeAction, readonly OptionKey[]> = {
  remux: ['container', 'keepLanguages', 'dropSubtitles'],
  transcode: ['container', 'videoCodec', 'crf', 'preset', 'hwaccel', 'audio', 'channels', 'keepLanguages', 'dropSubtitles'],
  stripTracks: ['container', 'keepLanguages', 'dropSubtitles'],
  addAudioTrack: ['container', 'audio', 'channels', 'keepLanguages', 'dropSubtitles'],
};

/** Options shown for the current choices: encoder settings only when video is re-encoded, channels only when audio is. */
export function visibleOptions(action: TranscodeAction, videoCodec: TranscodeVideoCodec, audio: TranscodeAudioCodec): OptionKey[] {
  return ACTION_OPTIONS[action].filter((k) => {
    if (action !== 'transcode') return true;
    if (k === 'crf' || k === 'preset' || k === 'hwaccel') return videoCodec !== 'copy';
    if (k === 'channels') return audio !== 'copy';
    return true;
  });
}

/** Audio choices per action: the compatibility track is always encoded (copy = AAC). */
export function audioChoices(action: TranscodeAction): TranscodeAudioCodec[] {
  return action === 'addAudioTrack' ? ['aac', 'eac3'] : ['copy', 'aac', 'eac3'];
}

/** Encoders the api knows per backend (VideoToolbox has no AV1). */
export function hwaccelSupports(hwaccel: TranscodeHwaccel, codec: TranscodeVideoCodec): boolean {
  return codec === 'copy' || !(hwaccel === 'videotoolbox' && codec === 'av1');
}

export type HdrChoice = 'any' | 'hdr' | 'sdr';
export type ScopeKind = 'all' | 'tags' | 'profiles';

export interface RuleDraft {
  name: string;
  enabled: boolean;
  mediaType: TranscodeMediaType;
  scopeKind: ScopeKind;
  tagIds: number[];
  qualityProfileIds: number[];
  container: string;
  whenVideoCodec: string;
  whenAudioCodec: string;
  hdr: HdrChoice;
  resolutionAbove: string;
  bitrateAboveKbps: string;
  sizeAboveGb: string;
  action: TranscodeAction;
  outContainer: TranscodeContainer;
  videoCodec: TranscodeVideoCodec;
  crf: string;
  preset: string;
  audio: TranscodeAudioCodec;
  channels: string;
  /** Comma or space separated ISO 639 codes. */
  keepLanguages: string;
  dropSubtitles: boolean;
  hwaccel: TranscodeHwaccel;
  keepOriginal: boolean;
  runAfterImport: boolean;
  windowEnabled: boolean;
  windowStart: string;
  windowEnd: string;
}

export function newRuleDraft(): RuleDraft {
  return {
    name: '',
    enabled: true,
    mediaType: 'all',
    scopeKind: 'all',
    tagIds: [],
    qualityProfileIds: [],
    container: '',
    whenVideoCodec: '',
    whenAudioCodec: '',
    hdr: 'any',
    resolutionAbove: '',
    bitrateAboveKbps: '',
    sizeAboveGb: '',
    action: 'remux',
    outContainer: 'mkv',
    videoCodec: 'copy',
    crf: '',
    preset: '',
    audio: 'copy',
    channels: '',
    keepLanguages: '',
    dropSubtitles: false,
    hwaccel: 'none',
    keepOriginal: false,
    runAfterImport: false,
    windowEnabled: false,
    windowStart: '22:00',
    windowEnd: '06:00',
  };
}

const str = (n: number | undefined) => (n === undefined ? '' : String(n));

export function toRuleDraft(r: TranscodeRule): RuleDraft {
  const o = r.options;
  return {
    name: r.name,
    enabled: r.enabled,
    mediaType: r.mediaType,
    scopeKind: r.scope.kind,
    tagIds: r.scope.kind === 'tags' ? [...r.scope.tagIds] : [],
    qualityProfileIds: r.scope.kind === 'profiles' ? [...r.scope.qualityProfileIds] : [],
    container: r.when.container ?? '',
    whenVideoCodec: r.when.videoCodec ?? '',
    whenAudioCodec: r.when.audioCodec ?? '',
    hdr: r.when.hdr === undefined ? 'any' : r.when.hdr ? 'hdr' : 'sdr',
    resolutionAbove: str(r.when.resolutionAbove),
    bitrateAboveKbps: str(r.when.bitrateAboveKbps),
    sizeAboveGb: str(r.when.sizeAboveGb),
    action: r.action,
    outContainer: o.container,
    videoCodec: o.videoCodec,
    crf: str(o.crf),
    preset: o.preset ?? '',
    audio: o.audio,
    channels: str(o.channels),
    keepLanguages: o.keepLanguages.join(', '),
    dropSubtitles: o.dropSubtitles,
    hwaccel: o.hwaccel,
    keepOriginal: r.keepOriginal,
    runAfterImport: r.runAfterImport,
    windowEnabled: r.schedule !== null,
    windowStart: r.schedule?.start ?? '22:00',
    windowEnd: r.schedule?.end ?? '06:00',
  };
}

const optNum = (text: string) => (text.trim() === '' ? undefined : Number(text));

export function parseLanguages(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export type RuleBodyResult = { ok: true; body: TranscodeRuleInputRaw } | { ok: false; error: string };

/** Draft -> POST/PUT body (only the options the action uses), validated with the shared schema. */
export function toRuleBody(d: RuleDraft): RuleBodyResult {
  if (!d.name.trim()) return { ok: false, error: t('common.nameIsRequired') };
  const when: TranscodeWhen = {};
  if (d.container.trim()) when.container = d.container.trim();
  if (d.whenVideoCodec.trim()) when.videoCodec = d.whenVideoCodec.trim();
  if (d.whenAudioCodec.trim()) when.audioCodec = d.whenAudioCodec.trim();
  if (d.hdr !== 'any') when.hdr = d.hdr === 'hdr';
  const res = optNum(d.resolutionAbove);
  if (res !== undefined) when.resolutionAbove = res;
  const kbps = optNum(d.bitrateAboveKbps);
  if (kbps !== undefined) when.bitrateAboveKbps = kbps;
  const gb = optNum(d.sizeAboveGb);
  if (gb !== undefined) when.sizeAboveGb = gb;

  const shown = new Set(visibleOptions(d.action, d.videoCodec, d.audio));
  const options: TranscodeOptionsInput = { container: d.outContainer };
  if (shown.has('videoCodec')) options.videoCodec = d.videoCodec;
  if (shown.has('audio')) options.audio = d.action === 'addAudioTrack' && d.audio === 'copy' ? 'aac' : d.audio;
  const crf = optNum(d.crf);
  if (shown.has('crf') && crf !== undefined) options.crf = crf;
  if (shown.has('preset') && d.preset.trim()) options.preset = d.preset.trim();
  const channels = optNum(d.channels);
  if (shown.has('channels') && channels !== undefined) options.channels = channels;
  if (shown.has('hwaccel')) options.hwaccel = d.hwaccel;
  options.keepLanguages = parseLanguages(d.keepLanguages);
  options.dropSubtitles = d.dropSubtitles;

  if (shown.has('hwaccel') && !hwaccelSupports(d.hwaccel, d.videoCodec)) {
    return { ok: false, error: t('settings.transcode.noAv1OnVideotoolbox') };
  }

  const raw: TranscodeRuleInputRaw = {
    name: d.name.trim(),
    enabled: d.enabled,
    mediaType: d.mediaType,
    scope:
      d.scopeKind === 'tags'
        ? { kind: 'tags', tagIds: d.tagIds }
        : d.scopeKind === 'profiles'
          ? { kind: 'profiles', qualityProfileIds: d.qualityProfileIds }
          : { kind: 'all' },
    when,
    action: d.action,
    options,
    keepOriginal: d.keepOriginal,
    runAfterImport: d.runAfterImport,
    schedule: d.windowEnabled ? { start: d.windowStart, end: d.windowEnd } : null,
  };
  const parsed = TranscodeRuleInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: t('settings.transcode.invalidRule', { field: issue ? issue.path.join('.') : '', message: issue?.message ?? '' }) };
  }
  return { ok: true, body: raw };
}

export function actionLabel(action: TranscodeAction): string {
  switch (action) {
    case 'remux':
      return t('settings.transcode.actionRemux');
    case 'transcode':
      return t('settings.transcode.actionTranscode');
    case 'stripTracks':
      return t('settings.transcode.actionStripTracks');
    case 'addAudioTrack':
      return t('settings.transcode.actionAddAudioTrack');
  }
}

export function hwaccelLabel(h: TranscodeHwaccel): string {
  switch (h) {
    case 'none':
      return t('settings.transcode.hwNone');
    case 'vaapi':
      return 'VAAPI';
    case 'qsv':
      return 'Intel Quick Sync (QSV)';
    case 'nvenc':
      return 'NVIDIA NVENC';
    case 'videotoolbox':
      return 'VideoToolbox';
  }
}

/** "mkv · h264 · HDR · >1080p · >8000 kbps · >10 GiB", or "Every file". */
export function whenSummary(when: TranscodeWhen): string {
  const parts: string[] = [];
  if (when.container) parts.push(when.container);
  if (when.videoCodec) parts.push(when.videoCodec);
  if (when.audioCodec) parts.push(when.audioCodec);
  if (when.hdr !== undefined) parts.push(when.hdr ? 'HDR' : 'SDR');
  if (when.resolutionAbove !== undefined) parts.push(`>${when.resolutionAbove}p`);
  if (when.bitrateAboveKbps !== undefined) parts.push(`>${when.bitrateAboveKbps} kbps`);
  if (when.sizeAboveGb !== undefined) parts.push(`>${when.sizeAboveGb} GiB`);
  return parts.length ? parts.join(' · ') : t('settings.transcode.everyFile');
}
