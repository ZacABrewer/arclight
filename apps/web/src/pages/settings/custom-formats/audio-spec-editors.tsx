import { useId } from 'react';
import { AudioCodec, AudioFileLayout, AudiobookFormatType, AudioSourceKind, type SpecImplementationDefinition } from '@arclight/shared';
import { Field, Input, Segmented, Select, Toggle } from '../../../arclight/index.js';
import type { FieldErrors } from '../../../components/forms/types.js';
import { AUDIO_SPECS, AUDIOBOOK_SPECS } from '../../../lib/custom-format-domain.js';
import { t } from '../../../i18n/index.js';

// Editors for the audio custom-format conditions (music and audiobooks). Typed controls in
// place of the generic schema form: codec and source pickers, kbps and kHz bands, bit depth,
// the rip-log options, and the audiobook layout / format / narrator conditions.

type Fields = Record<string, unknown>;

export const AUDIO_SOURCE_LABELS: Record<AudioSourceKind, string> = {
  cd: 'CD',
  web: 'WEB',
  vinyl: 'Vinyl',
  sacd: 'SACD',
  cassette: 'Cassette',
  get other() {
    return t('settings.customFormats.audio.otherSource');
  },
};

const FORMAT_TYPE_LABELS: Record<AudiobookFormatType, string> = {
  get unabridged() {
    return t('settings.customFormats.audio.unabridged');
  },
  get abridged() {
    return t('settings.customFormats.audio.abridged');
  },
  get dramatized() {
    return t('settings.customFormats.audio.dramatized');
  },
};

/**
 * The audio condition kinds as editor definitions, used when the server's
 * /customformat/schema does not list them (yet). Labels are localized; defaults fill a new spec.
 */
export function audioSpecDefinitions(): SpecImplementationDefinition[] {
  const audio: SpecImplementationDefinition['mediaTypes'] = ['music', 'audiobook'];
  return [
    { implementation: 'audioCodec', label: t('settings.customFormats.audio.codecKind'), mediaTypes: audio, fields: [{ name: 'codec', label: 'codec', type: 'select', default: 'FLAC' }] },
    {
      implementation: 'audioBitrate',
      label: t('settings.customFormats.audio.bitrateKind'),
      mediaTypes: audio,
      fields: [
        { name: 'minKbps', label: 'minKbps', type: 'number', default: 0 },
        { name: 'maxKbps', label: 'maxKbps', type: 'number', default: 320 },
      ],
    },
    { implementation: 'bitDepth', label: t('settings.customFormats.audio.bitDepthKind'), mediaTypes: audio, fields: [{ name: 'bitDepth', label: 'bitDepth', type: 'select', default: 24 }] },
    {
      implementation: 'sampleRate',
      label: t('settings.customFormats.audio.sampleRateKind'),
      mediaTypes: audio,
      fields: [
        { name: 'minKhz', label: 'minKhz', type: 'number', default: 44.1 },
        { name: 'maxKhz', label: 'maxKhz', type: 'number', default: 192 },
      ],
    },
    { implementation: 'audioSource', label: t('settings.customFormats.audio.sourceKind'), mediaTypes: ['music'], fields: [{ name: 'source', label: 'source', type: 'select', default: 'cd' }] },
    {
      implementation: 'ripLog',
      label: t('settings.customFormats.audio.ripLogKind'),
      mediaTypes: ['music'],
      fields: [
        { name: 'requireLog', label: 'requireLog', type: 'checkbox', default: false },
        { name: 'minScore', label: 'minScore', type: 'number', default: 0 },
        { name: 'requireCue', label: 'requireCue', type: 'checkbox', default: false },
      ],
    },
    { implementation: 'fileLayout', label: t('settings.customFormats.audio.layoutKind'), mediaTypes: ['audiobook'], fields: [{ name: 'layout', label: 'layout', type: 'select', default: 'single' }] },
    { implementation: 'formatType', label: t('settings.customFormats.audio.formatTypeKind'), mediaTypes: ['audiobook'], fields: [{ name: 'formatType', label: 'formatType', type: 'select', default: 'unabridged' }] },
    { implementation: 'narrator', label: t('settings.customFormats.audio.narratorKind'), mediaTypes: ['audiobook'], fields: [{ name: 'pattern', label: 'pattern', type: 'regex', default: '' }] },
  ];
}

/**
 * The condition kinds the editor offers: the server's schema plus any audio kind it lacks;
 * audio kinds only while music (or audiobooks) is on, audiobook kinds only with audiobooks on.
 * Kinds already used by the format stay listed so an existing condition keeps its type.
 */
export function editorSchema(
  server: readonly SpecImplementationDefinition[],
  features: { music: boolean; audiobooks: boolean },
  used: readonly string[] = [],
): SpecImplementationDefinition[] {
  const have = new Set(server.map((d) => d.implementation));
  const merged = [...server, ...audioSpecDefinitions().filter((d) => !have.has(d.implementation))];
  const keep = new Set(used);
  return merged.filter((d) => {
    if (keep.has(d.implementation)) return true;
    if (AUDIOBOOK_SPECS.has(d.implementation)) return features.audiobooks;
    if (AUDIO_SPECS.has(d.implementation)) return features.music || features.audiobooks;
    return true;
  });
}

export const isAudioSpec = (implementation: string) => AUDIO_SPECS.has(implementation);

const numOr = (v: string, fallback: number) => {
  const n = Number(v);
  return v.trim() === '' || Number.isNaN(n) ? fallback : n;
};

/** Field errors for the audio bands (max at or above min, scores 0-100); empty when valid. */
export function audioSpecErrors(implementation: string, f: Fields): FieldErrors {
  const e: FieldErrors = {};
  const n = (k: string) => (typeof f[k] === 'number' ? (f[k] as number) : Number.NaN);
  if (implementation === 'audioBitrate') {
    if (!(n('minKbps') >= 0)) e.minKbps = t('settings.customFormats.audio.enterZeroOrMore');
    if (!(n('maxKbps') > 0)) e.maxKbps = t('settings.customFormats.audio.enterMoreThanZero');
    else if (n('maxKbps') < n('minKbps')) e.maxKbps = t('settings.customFormats.audio.maxBelowMin');
  }
  if (implementation === 'sampleRate') {
    if (!(n('minKhz') >= 0)) e.minKhz = t('settings.customFormats.audio.enterZeroOrMore');
    if (!(n('maxKhz') > 0)) e.maxKhz = t('settings.customFormats.audio.enterMoreThanZero');
    else if (n('maxKhz') < n('minKhz')) e.maxKhz = t('settings.customFormats.audio.maxBelowMin');
  }
  if (implementation === 'ripLog' && !(n('minScore') >= 0 && n('minScore') <= 100)) e.minScore = t('settings.customFormats.audio.scoreRange');
  if (implementation === 'narrator' && !(typeof f.pattern === 'string' && f.pattern.trim() !== '')) e.pattern = t('settings.customFormats.audio.enterAPattern');
  return e;
}

function NumberField({ label, unit, value, error, step, onChange }: { label: string; unit: string; value: unknown; error?: string | undefined; step?: number; onChange: (n: number) => void }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} error={error}>
      <Input
        id={id}
        type="number"
        mono
        min={0}
        step={step}
        end={unit}
        invalid={error ? true : undefined}
        value={typeof value === 'number' && Number.isFinite(value) ? String(value) : ''}
        onChange={(e) => onChange(numOr(e.currentTarget.value, Number.NaN))}
      />
    </Field>
  );
}

/** The typed editor for one audio condition. */
export function AudioSpecEditor({
  implementation,
  fields,
  errors,
  onChange,
}: {
  implementation: string;
  fields: Fields;
  errors: FieldErrors;
  onChange: (fields: Fields) => void;
}) {
  const set = (key: string, value: unknown) => onChange({ ...fields, [key]: value });
  const selectId = useId();
  switch (implementation) {
    case 'audioCodec':
      return (
        <Field label={t('settings.customFormats.audio.codec')} htmlFor={selectId}>
          <Select id={selectId} value={String(fields.codec ?? '')} onChange={(e) => set('codec', e.currentTarget.value)} options={AudioCodec.options.map((c) => ({ value: c, label: c }))} />
        </Field>
      );
    case 'audioBitrate':
      return (
        <div className="al-cf-audio-band">
          <NumberField label={t('settings.customFormats.audio.minBitrate')} unit="kbps" value={fields.minKbps} error={errors.minKbps} onChange={(n) => set('minKbps', n)} />
          <NumberField label={t('settings.customFormats.audio.maxBitrate')} unit="kbps" value={fields.maxKbps} error={errors.maxKbps} onChange={(n) => set('maxKbps', n)} />
          <p className="al-caption">{t('settings.customFormats.audio.bitrateHint')}</p>
        </div>
      );
    case 'bitDepth':
      return (
        <Field label={t('settings.customFormats.audio.bitDepth')}>
          <Segmented
            aria-label={t('settings.customFormats.audio.bitDepth')}
            value={String(fields.bitDepth ?? 24)}
            onChange={(v) => set('bitDepth', Number(v))}
            options={['16', '24', '32'].map((b) => ({ value: b, label: t('music.search.bitDepthValue', { bits: Number(b) }) }))}
          />
        </Field>
      );
    case 'sampleRate':
      return (
        <div className="al-cf-audio-band">
          <NumberField label={t('settings.customFormats.audio.minSampleRate')} unit="kHz" step={0.1} value={fields.minKhz} error={errors.minKhz} onChange={(n) => set('minKhz', n)} />
          <NumberField label={t('settings.customFormats.audio.maxSampleRate')} unit="kHz" step={0.1} value={fields.maxKhz} error={errors.maxKhz} onChange={(n) => set('maxKhz', n)} />
          <p className="al-caption">{t('settings.customFormats.audio.sampleRateHint')}</p>
        </div>
      );
    case 'audioSource':
      return (
        <Field label={t('settings.customFormats.audio.source')} htmlFor={selectId}>
          <Select
            id={selectId}
            value={String(fields.source ?? '')}
            onChange={(e) => set('source', e.currentTarget.value)}
            options={AudioSourceKind.options.map((s) => ({ value: s, label: AUDIO_SOURCE_LABELS[s] }))}
          />
        </Field>
      );
    case 'ripLog':
      return (
        <div className="al-cf-audio-band">
          <Toggle size="sm" label={t('settings.customFormats.audio.requireLog')} checked={fields.requireLog === true} onChange={(e) => set('requireLog', e.currentTarget.checked)} />
          <NumberField label={t('settings.customFormats.audio.minLogScore')} unit="%" value={fields.minScore} error={errors.minScore} onChange={(n) => set('minScore', n)} />
          <Toggle size="sm" label={t('settings.customFormats.audio.requireCue')} checked={fields.requireCue === true} onChange={(e) => set('requireCue', e.currentTarget.checked)} />
          <p className="al-caption">{t('settings.customFormats.audio.ripLogHint')}</p>
        </div>
      );
    case 'fileLayout':
      return (
        <Field label={t('settings.customFormats.audio.layout')}>
          <Segmented
            aria-label={t('settings.customFormats.audio.layout')}
            value={String(fields.layout ?? 'single')}
            onChange={(v) => set('layout', v)}
            options={AudioFileLayout.options.map((l) => ({ value: l, label: l === 'single' ? t('settings.customFormats.audio.singleFile') : t('settings.customFormats.audio.multipleFiles') }))}
          />
        </Field>
      );
    case 'formatType':
      return (
        <Field label={t('settings.customFormats.audio.formatType')} htmlFor={selectId}>
          <Select
            id={selectId}
            value={String(fields.formatType ?? '')}
            onChange={(e) => set('formatType', e.currentTarget.value)}
            options={AudiobookFormatType.options.map((f) => ({ value: f, label: FORMAT_TYPE_LABELS[f] }))}
          />
        </Field>
      );
    case 'narrator':
      return (
        <Field label={t('settings.customFormats.audio.narratorPattern')} htmlFor={selectId} hint={t('settings.customFormats.audio.narratorHint')} error={errors.pattern}>
          <Input id={selectId} mono value={String(fields.pattern ?? '')} invalid={errors.pattern ? true : undefined} onChange={(e) => set('pattern', e.currentTarget.value)} />
        </Field>
      );
    default:
      return null;
  }
}
