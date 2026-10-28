import {
  VIDEO_QUALITIES,
  PROFILE_LANGUAGES,
  QualityModifier,
  QualitySource,
  ReleaseExtraKind,
  ReleaseIndexerFlag,
  ReleaseKind,
  type SpecImplementationDefinition,
} from '@arclight/shared';

const resolutions = [...new Set(VIDEO_QUALITIES.map((q) => q.resolution))].sort((a, b) => a - b);

const label = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** What the custom-format editor needs to render each condition type. */
export function specImplementations(): SpecImplementationDefinition[] {
  return [
    {
      implementation: 'releaseTitle',
      label: 'Release Title',
      mediaTypes: ['series', 'movie'],
      fields: [{ name: 'pattern', label: 'Regular Expression', type: 'regex', helpText: 'Matched against the release title, case-insensitive' }],
    },
    {
      implementation: 'releaseGroup',
      label: 'Release Group',
      mediaTypes: ['series', 'movie'],
      fields: [{ name: 'pattern', label: 'Regular Expression', type: 'regex', helpText: 'Matched against the release group, case-insensitive' }],
    },
    {
      implementation: 'edition',
      label: 'Edition',
      mediaTypes: ['movie'],
      fields: [{ name: 'pattern', label: 'Regular Expression', type: 'regex', helpText: 'Matched against the parsed edition (e.g. Director\'s Cut)' }],
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
      mediaTypes: ['series', 'movie'],
      fields: [
        { name: 'minGb', label: 'Minimum Size', type: 'number', unit: 'GB', default: 0, helpText: 'Release must be larger than this' },
        { name: 'maxGb', label: 'Maximum Size', type: 'number', unit: 'GB', default: 100, helpText: 'Release must be this size or smaller' },
      ],
    },
    {
      implementation: 'indexerFlag',
      label: 'Indexer Flag',
      mediaTypes: ['series', 'movie'],
      fields: [{ name: 'flag', label: 'Flag', type: 'select', options: ReleaseIndexerFlag.options.map((f) => ({ value: f, label: label(f) })) }],
    },
    {
      implementation: 'year',
      label: 'Year',
      mediaTypes: ['movie'],
      fields: [
        { name: 'min', label: 'Minimum Year', type: 'number' },
        { name: 'max', label: 'Maximum Year', type: 'number' },
      ],
    },
    {
      implementation: 'releaseType',
      label: 'Release Type',
      mediaTypes: ['series', 'movie'],
      fields: [{ name: 'releaseType', label: 'Release Type', type: 'select', options: ReleaseKind.options.map((k) => ({ value: k, label: label(k) })) }],
    },
    {
      implementation: 'releaseExtras',
      label: 'Release Extras',
      mediaTypes: ['series'],
      fields: [{ name: 'kinds', label: 'Extra Kinds', type: 'multiSelect', default: [], options: ReleaseExtraKind.options.map((k) => ({ value: k, label: label(k) })), helpText: 'Leave empty to match any extra material' }],
    },
  ];
}
