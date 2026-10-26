import type {
  AdditionalAudioMode,
  AdditionalLanguageOutcome,
  AdditionalLanguageRequestInput,
  AdditionalLanguageTarget,
  AdditionalSubtitleLanguage,
} from '@arclight/shared';
import type { ChipTone } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

// Pure pieces of the "Add additional…" dialog: drafts → request bodies, outcome wording.

export type AdditionalTab = 'audio' | 'subtitle';

export interface AudioDraft {
  language: string | null;
  mode: AdditionalAudioMode;
  /** Version mode: '' = the language's name (server default). */
  versionTag: string;
  /** Version mode: '' = the item's own profile. */
  qualityProfileId: string;
}

export interface SubtitleDraft {
  languages: AdditionalSubtitleLanguage[];
  searchNow: boolean;
  useWhisper: boolean;
}

export const EMPTY_AUDIO: AudioDraft = { language: null, mode: 'replace', versionTag: '', qualityProfileId: '' };
export const EMPTY_SUBTITLE: SubtitleDraft = { languages: [], searchNow: true, useWhisper: false };

/** The request for the current tab; null while nothing is picked yet. */
export function buildRequest(
  tab: AdditionalTab,
  targets: readonly AdditionalLanguageTarget[],
  audio: AudioDraft,
  subtitle: SubtitleDraft,
): AdditionalLanguageRequestInput | null {
  if (targets.length === 0) return null;
  if (tab === 'audio') {
    if (!audio.language) return null;
    const tag = audio.versionTag.trim();
    return {
      kind: 'audio',
      targets: [...targets],
      language: audio.language,
      mode: audio.mode,
      ...(audio.mode === 'version' && tag ? { versionTag: tag } : {}),
      ...(audio.mode === 'version' && audio.qualityProfileId ? { qualityProfileId: Number(audio.qualityProfileId) } : {}),
    };
  }
  if (subtitle.languages.length === 0) return null;
  return {
    kind: 'subtitle',
    targets: [...targets],
    languages: subtitle.languages.map((l) => ({ ...l })),
    searchNow: subtitle.searchNow,
    useWhisper: subtitle.useWhisper,
  };
}

/** Version names may not hold path characters (same rule as the versions editor). */
export function versionTagError(tag: string): string | null {
  return /[\\/<>:?*|"]/.test(tag) ? t('features.additionalLanguages.versionNameInvalid') : null;
}

export const OUTCOME_LABELS: Record<AdditionalLanguageOutcome, string> = {
  get alreadyPresent() {
    return t('features.additionalLanguages.outcome.alreadyPresent');
  },
  get noFile() {
    return t('features.additionalLanguages.outcome.noFile');
  },
  get willSearch() {
    return t('features.additionalLanguages.outcome.willSearch');
  },
  get willAddVersion() {
    return t('features.additionalLanguages.outcome.willAddVersion');
  },
  get saved() {
    return t('features.additionalLanguages.outcome.saved');
  },
  get found() {
    return t('features.additionalLanguages.outcome.found');
  },
  get grabbed() {
    return t('features.additionalLanguages.outcome.grabbed');
  },
  get notFound() {
    return t('features.additionalLanguages.outcome.notFound');
  },
  get searching() {
    return t('features.additionalLanguages.outcome.searching');
  },
  get versionAdded() {
    return t('features.additionalLanguages.outcome.versionAdded');
  },
  get failed() {
    return t('features.additionalLanguages.outcome.failed');
  },
};

export const OUTCOME_TONE: Record<AdditionalLanguageOutcome, ChipTone> = {
  alreadyPresent: 'muted',
  noFile: 'neutral',
  willSearch: 'default',
  willAddVersion: 'default',
  saved: 'neutral',
  found: 'accent',
  grabbed: 'accent',
  notFound: 'warn',
  searching: 'default',
  versionAdded: 'accent',
  failed: 'danger',
};

/** One-line explanation under the outcome chip. */
export function outcomeHint(outcome: AdditionalLanguageOutcome): string | null {
  switch (outcome) {
    case 'notFound':
      return t('features.additionalLanguages.hint.notFound');
    case 'noFile':
      return t('features.additionalLanguages.hint.noFile');
    case 'grabbed':
      return t('features.additionalLanguages.hint.grabbed');
    case 'searching':
      return t('features.additionalLanguages.hint.searching');
    default:
      return null;
  }
}

/** "English (forced)"-style label for a subtitle key `en`, `en:forced`, `en:hi`. */
export function subtitleKeyLabel(key: string, name: (code: string) => string): string {
  const [code = key, flag] = key.split(':');
  if (flag === 'forced') return t('features.additionalLanguages.forcedLabel', { name: name(code) });
  if (flag === 'hi') return t('features.additionalLanguages.hiLabel', { name: name(code) });
  return name(code);
}
