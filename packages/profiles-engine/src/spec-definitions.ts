import {
  AudioCodec,
  AudioFileLayout,
  AudiobookFormatType,
  AudioSourceKind,
  VIDEO_QUALITIES,
  PROFILE_LANGUAGES,
  QualityModifier,
  QualitySource,
  ReleaseExtraKind,
  ReleaseIndexerFlag,
  ReleaseKind,
  type EvaluationMediaType,
  type SpecImplementationDefinition,
} from '@arclight/shared';

const ALL: EvaluationMediaType[] = ['series', 'movie', 'music', 'audiobook'];
const AUDIO: EvaluationMediaType[] = ['music', 'audiobook'];

const AUDIO_SOURCE_LABEL: Record<AudioSourceKind, string> = {
  cd: 'CD',
  web: 'WEB',
  vinyl: 'Vinyl',
  sacd: 'SACD',
  cassette: 'Cassette',
  other: 'Other',
};

const resolutions = [...new Set(VIDEO_QUALITIES.map((q) => q.resolution))].sort((a, b) => a - b);

const label = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** What the custom-format editor needs to render each condition type. */
export function specImplementations(): SpecImplementationDefinition[] {
  return [
    {
      implementation: 'releaseTitle',
      label: 'Release Title',
      mediaTypes: ALL,
      fields: [{ name: 'pattern', label: 'Regular Expression', type: 'regex', helpText: 'Matched against the release title, case-insensitive' }],
    },
    {
      implementation: 'releaseGroup',
      label: 'Release Group',
      mediaTypes: ALL,
      fields: [{ name: 'pattern', label: 'Regular Expression', type: 'regex', helpText: 'Matched against the release group, case-insensitive' }],
    },
    {
      implementation: 'edition',
      label: 'Edition',
      mediaTypes: ['movie', 'music'],
      fields: [{ name: 'pattern', label: 'Regular Expression', type: 'regex', helpText: 'Matched against the parsed edition (e.g. Director\'s Cut, Deluxe Edition, 2011 Remaster)' }],
    },
    {
      implementation: 'language',
      label: 'Language',
      mediaTypes: ['series', 'movie'],
      fields: [
        { name: 'language', label: 'Language', type: 'select', options: PROFILE_LANGUAGES.map((l) => ({ value: l.code, label: l.name })) },
        { name: 'exceptLanguage', label: 'Except Language', type: 'checkbox', default: false, helpText: 'Match when the release has any language other than the one selected' },
      ],
    },
    {
      implementation: 'source',
      label: 'Source',
      mediaTypes: ['series', 'movie'],
      fields: [{ name: 'source', label: 'Source', type: 'select', options: QualitySource.options.map((s) => ({ value: s, label: label(s) })) }],
    },
    {
      implementation: 'resolution',
      label: 'Resolution',
      mediaTypes: ['series', 'movie'],
      fields: [{ name: 'resolution', label: 'Resolution', type: 'select', options: resolutions.map((r) => ({ value: r, label: r === 0 ? 'Unknown' : `${r}p` })) }],
    },
    {
      implementation: 'qualityModifier',
      label: 'Quality Modifier',
      mediaTypes: ['series', 'movie'],
      fields: [{ name: 'modifier', label: 'Modifier', type: 'select', options: QualityModifier.options.map((m) => ({ value: m, label: label(m) })) }],
    },
    {
      implementation: 'size',
      label: 'Size',
      mediaTypes: ALL,
      fields: [
        { name: 'minGb', label: 'Minimum Size', type: 'number', unit: 'GB', default: 0, helpText: 'Release must be larger than this' },
        { name: 'maxGb', label: 'Maximum Size', type: 'number', unit: 'GB', default: 100, helpText: 'Release must be this size or smaller' },
      ],
    },
    {
      implementation: 'indexerFlag',
      label: 'Indexer Flag',
      mediaTypes: ALL,
      fields: [{ name: 'flag', label: 'Flag', type: 'select', options: ReleaseIndexerFlag.options.map((f) => ({ value: f, label: label(f) })) }],
    },
    {
      implementation: 'year',
      label: 'Year',
      mediaTypes: ['movie', 'music', 'audiobook'],
      fields: [
        { name: 'min', label: 'Minimum Year', type: 'number' },
        { name: 'max', label: 'Maximum Year', type: 'number' },
      ],
    },
    {
      implementation: 'releaseType',
      label: 'Release Type',
      mediaTypes: ALL,
      fields: [{ name: 'releaseType', label: 'Release Type', type: 'select', options: ReleaseKind.options.map((k) => ({ value: k, label: label(k) })) }],
    },
    {
      implementation: 'releaseExtras',
      label: 'Release Extras',
      mediaTypes: ['series'],
      fields: [{ name: 'kinds', label: 'Extra Kinds', type: 'multiSelect', default: [], options: ReleaseExtraKind.options.map((k) => ({ value: k, label: label(k) })), helpText: 'Leave empty to match any extra material' }],
    },
    // ---- audio
    {
      implementation: 'audioCodec',
      label: 'Audio Codec',
      mediaTypes: AUDIO,
      fields: [{ name: 'codec', label: 'Codec', type: 'select', options: AudioCodec.options.map((c) => ({ value: c, label: c })) }],
    },
    {
      implementation: 'audioBitrate',
      label: 'Audio Bitrate',
      mediaTypes: AUDIO,
      fields: [
        { name: 'minKbps', label: 'Minimum Bitrate', type: 'number', unit: 'kbps', default: 0 },
        { name: 'maxKbps', label: 'Maximum Bitrate', type: 'number', unit: 'kbps', default: 320, helpText: 'Inclusive. A VBR preset without a stated bitrate counts as its nominal rate (V0 245, V2 190)' },
      ],
    },
    {
      implementation: 'bitDepth',
      label: 'Bit Depth',
      mediaTypes: AUDIO,
      fields: [{ name: 'bitDepth', label: 'Bit Depth', type: 'select', options: [16, 24, 32].map((b) => ({ value: b, label: `${b}-bit` })) }],
    },
    {
      implementation: 'sampleRate',
      label: 'Sample Rate',
      mediaTypes: AUDIO,
      fields: [
        { name: 'minKhz', label: 'Minimum Sample Rate', type: 'number', unit: 'kHz', default: 44.1 },
        { name: 'maxKhz', label: 'Maximum Sample Rate', type: 'number', unit: 'kHz', default: 192, helpText: 'Inclusive' },
      ],
    },
    {
      implementation: 'audioSource',
      label: 'Audio Source',
      mediaTypes: ['music'],
      fields: [{ name: 'source', label: 'Source', type: 'select', options: AudioSourceKind.options.map((s) => ({ value: s, label: AUDIO_SOURCE_LABEL[s] })) }],
    },
    {
      implementation: 'ripLog',
      label: 'Rip Log',
      mediaTypes: ['music'],
      fields: [
        { name: 'requireLog', label: 'Require Log', type: 'checkbox', default: false },
        { name: 'minScore', label: 'Minimum Log Score', type: 'number', unit: '%', default: 0, helpText: 'Above 0 also requires a log' },
        { name: 'requireCue', label: 'Require Cue', type: 'checkbox', default: false, helpText: 'With nothing required, matches any release with a log or a cue sheet' },
      ],
    },
    // ---- audiobooks
    {
      implementation: 'fileLayout',
      label: 'File Layout',
      mediaTypes: ['audiobook'],
      fields: [{ name: 'layout', label: 'Layout', type: 'select', options: AudioFileLayout.options.map((l) => ({ value: l, label: l === 'single' ? 'Single file' : 'Multiple files' })), helpText: 'From the file count when known, else the name (m4b is one file; mp3 and flac are one file per part)' }],
    },
    {
      implementation: 'formatType',
      label: 'Format Type',
      mediaTypes: ['audiobook'],
      fields: [{ name: 'formatType', label: 'Format', type: 'select', options: AudiobookFormatType.options.map((f) => ({ value: f, label: label(f) })) }],
    },
    {
      implementation: 'narrator',
      label: 'Narrator',
      mediaTypes: ['audiobook'],
      fields: [{ name: 'pattern', label: 'Regular Expression', type: 'regex', helpText: 'Matched against each narrator name, case-insensitive' }],
    },
  ];
}
