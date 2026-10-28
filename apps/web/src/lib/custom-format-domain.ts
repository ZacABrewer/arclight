import type { CustomFormat, CustomFormatSpec, MediaDomain, ReleaseKind } from '@arclight/shared';

// Which media domain a custom format belongs to, from its specifications. A mirror of
// `customFormatDomains` / `customFormatDomain` / `customFormatFitsDomain` in
// @arclight/profiles-engine (custom-format.ts): the web does not depend on the engine package,
// and both must agree, so keep the tables in step with it.

export type CustomFormatDomain = MediaDomain | 'any';

const ALL_DOMAINS: ReadonlyArray<MediaDomain> = ['video', 'music', 'audiobook'];

const RELEASE_KIND_DOMAINS: Record<ReleaseKind, ReadonlyArray<MediaDomain>> = {
  single: ALL_DOMAINS,
  multi: ['video'],
  seasonPack: ['video'],
  discography: ['music'],
  multiAlbum: ['music'],
  bookPack: ['audiobook'],
};

/** Spec implementations only audiobooks evaluate (shown while the audiobooks flag is on). */
export const AUDIOBOOK_SPECS: ReadonlySet<string> = new Set(['fileLayout', 'formatType', 'narrator']);

/** Spec implementations of the audio editors (music and audiobooks). */
export const AUDIO_SPECS: ReadonlySet<string> = new Set(['audioCodec', 'audioBitrate', 'bitDepth', 'sampleRate', 'audioSource', 'ripLog', ...AUDIOBOOK_SPECS]);

/** Domains in which one specification can ever match (unknown implementations: every domain). */
export function specDomains(spec: Pick<CustomFormatSpec, 'implementation'> & { fields?: unknown }): ReadonlyArray<MediaDomain> {
  switch (spec.implementation) {
    case 'releaseType': {
      const kind = (spec.fields as { releaseType?: ReleaseKind } | undefined)?.releaseType;
      return kind ? (RELEASE_KIND_DOMAINS[kind] ?? ALL_DOMAINS) : ALL_DOMAINS;
    }
    case 'language':
    case 'source':
    case 'resolution':
    case 'qualityModifier':
    case 'releaseExtras':
      return ['video'];
    case 'audioCodec':
    case 'audioBitrate':
    case 'bitDepth':
    case 'sampleRate':
      return ['music', 'audiobook'];
    case 'audioSource':
    case 'ripLog':
      return ['music'];
    case 'fileLayout':
    case 'formatType':
    case 'narrator':
      return ['audiobook'];
    default:
      return ALL_DOMAINS;
  }
}

/** Every domain the format can match in (the intersection over its specifications). */
export function customFormatDomains(format: Pick<CustomFormat, 'specifications'>): MediaDomain[] {
  let domains: MediaDomain[] = [...ALL_DOMAINS];
  for (const spec of format.specifications) {
    const allowed = specDomains(spec);
    domains = domains.filter((d) => allowed.includes(d));
  }
  return domains;
}

/** One label: `any` when it fits every domain, else the first domain it fits. */
export function customFormatDomain(format: Pick<CustomFormat, 'specifications'>): CustomFormatDomain {
  const domains = customFormatDomains(format);
  if (domains.length === ALL_DOMAINS.length) return 'any';
  if (domains[0] !== undefined) return domains[0];
  for (const spec of format.specifications) {
    const d = specDomains(spec);
    if (d.length < ALL_DOMAINS.length && d[0] !== undefined) return d[0];
  }
  return 'any';
}

/** Should a profile of `domain` list this format? */
export function customFormatFitsDomain(format: Pick<CustomFormat, 'specifications'>, domain: MediaDomain): boolean {
  return customFormatDomains(format).includes(domain);
}
