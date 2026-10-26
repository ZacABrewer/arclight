import { SceneMappingInput, type SceneMapping, type SceneMappingKind } from '@arclight/shared';
import { episodeCode } from '../../../components/media/format.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for the series "Scene mapping" tab: the rule form draft, validation that mirrors
// the SceneMappingInput refinements (with translated messages), and one-line rule summaries.

export const SCENE_MAPPING_KINDS: readonly SceneMappingKind[] = ['season', 'absolute', 'title'];

export const SCENE_MAPPING_KIND_LABELS: Record<SceneMappingKind, string> = {
  get season() {
    return t('library.sceneMapping.kindSeason');
  },
  get absolute() {
    return t('library.sceneMapping.kindAbsolute');
  },
  get title() {
    return t('library.sceneMapping.kindTitle');
  },
};

export type NumberField = 'sceneSeason' | 'sceneEpisode' | 'sceneAbsolute' | 'tvdbSeason' | 'tvdbEpisode' | 'tvdbAbsolute';
export const NUMBER_FIELDS: readonly NumberField[] = ['sceneSeason', 'sceneEpisode', 'sceneAbsolute', 'tvdbSeason', 'tvdbEpisode', 'tvdbAbsolute'];

/** The form state: numbers as typed text so an empty box means null. */
export interface SceneMappingDraft {
  kind: SceneMappingKind;
  sceneSeason: string;
  sceneEpisode: string;
  sceneAbsolute: string;
  tvdbSeason: string;
  tvdbEpisode: string;
  tvdbAbsolute: string;
  sceneTitle: string;
  comment: string;
}

/** Which number fields each kind uses (the rest are sent as null). */
export const KIND_FIELDS: Record<SceneMappingKind, readonly NumberField[]> = {
  season: ['sceneSeason', 'sceneEpisode', 'tvdbSeason', 'tvdbEpisode', 'tvdbAbsolute'],
  absolute: ['sceneAbsolute', 'sceneSeason', 'tvdbSeason', 'tvdbEpisode', 'tvdbAbsolute'],
  title: ['sceneSeason', 'tvdbSeason'],
};

export function emptyDraft(kind: SceneMappingKind = 'season'): SceneMappingDraft {
  return { kind, sceneSeason: '', sceneEpisode: '', sceneAbsolute: '', tvdbSeason: '', tvdbEpisode: '', tvdbAbsolute: '', sceneTitle: '', comment: '' };
}

const str = (n: number | null) => (n === null ? '' : String(n));

export function draftFromMapping(m: SceneMapping): SceneMappingDraft {
  return {
    kind: m.kind,
    sceneSeason: str(m.sceneSeason),
    sceneEpisode: str(m.sceneEpisode),
    sceneAbsolute: str(m.sceneAbsolute),
    tvdbSeason: str(m.tvdbSeason),
    tvdbEpisode: str(m.tvdbEpisode),
    tvdbAbsolute: str(m.tvdbAbsolute),
    sceneTitle: m.sceneTitle ?? '',
    comment: m.comment,
  };
}

export type DraftErrors = Partial<Record<NumberField | 'sceneTitle' | 'comment' | 'form', string>>;

export type DraftResult = { ok: true; value: SceneMappingInput } | { ok: false; errors: DraftErrors };

/** Validate the draft and build the request body (fields the kind does not use are null). */
export function draftToInput(draft: SceneMappingDraft): DraftResult {
  const errors: DraftErrors = {};
  const used = KIND_FIELDS[draft.kind];
  const nums = {} as Record<NumberField, number | null>;
  for (const field of NUMBER_FIELDS) {
    const raw = draft[field].trim();
    if (!used.includes(field) || raw === '') {
      nums[field] = null;
      continue;
    }
    if (!/^\d+$/.test(raw)) {
      errors[field] = t('library.sceneMapping.wholeNumber');
      nums[field] = null;
      continue;
    }
    nums[field] = Number(raw);
  }
  const title = draft.kind === 'title' ? draft.sceneTitle.trim() : '';
  if (draft.kind === 'season') {
    if (nums.sceneSeason === null && !errors.sceneSeason) errors.sceneSeason = t('library.sceneMapping.needSceneSeason');
    if (nums.tvdbSeason === null && nums.tvdbAbsolute === null && !errors.tvdbSeason) errors.tvdbSeason = t('library.sceneMapping.needLibrarySeasonOrAbsolute');
  } else if (draft.kind === 'absolute') {
    if (nums.sceneAbsolute === null && !errors.sceneAbsolute) errors.sceneAbsolute = t('library.sceneMapping.needSceneAbsolute');
    if (nums.tvdbAbsolute === null && (nums.tvdbSeason === null || nums.tvdbEpisode === null) && !errors.tvdbAbsolute) {
      errors.tvdbAbsolute = t('library.sceneMapping.needLibraryEpisodeOrAbsolute');
    }
  } else {
    if (title === '') errors.sceneTitle = t('library.sceneMapping.needSceneTitle');
    else if (title.length > 300) errors.sceneTitle = t('library.sceneMapping.titleTooLong');
  }
  if (draft.comment.length > 500) errors.comment = t('library.sceneMapping.commentTooLong');
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const value: SceneMappingInput = { kind: draft.kind, ...nums, sceneTitle: title === '' ? null : title, comment: draft.comment.trim() };
  // Belt and braces: the contract is the judge of what the api accepts.
  const parsed = SceneMappingInput.safeParse(value);
  if (!parsed.success) return { ok: false, errors: { form: parsed.error.issues.map((i) => i.message).join('; ') } };
  return { ok: true, value };
}

type Side = Pick<SceneMapping, 'kind' | 'sceneSeason' | 'sceneEpisode' | 'sceneAbsolute' | 'tvdbSeason' | 'tvdbEpisode' | 'tvdbAbsolute' | 'sceneTitle'>;

/** Release-name side: "S02E01", "S02", "#27", "#27 in S03", "“Show Kai”". */
export function sceneSide(m: Side): string {
  if (m.kind === 'title') {
    const alias = `“${m.sceneTitle ?? ''}”`;
    return m.sceneSeason !== null ? `${alias} S${String(m.sceneSeason).padStart(2, '0')}` : alias;
  }
  if (m.kind === 'absolute') {
    const abs = `#${m.sceneAbsolute ?? '?'}`;
    return m.sceneSeason !== null ? t('library.sceneMapping.absoluteInSeason', { absolute: abs, season: m.sceneSeason }) : abs;
  }
  if (m.sceneSeason === null) return '—';
  return m.sceneEpisode !== null ? episodeCode(m.sceneSeason, m.sceneEpisode) : `S${String(m.sceneSeason).padStart(2, '0')}`;
}

/** Library side: "S01E13", "S03", "#40", "—". */
export function librarySide(m: Side): string {
  if (m.tvdbSeason !== null && m.tvdbEpisode !== null) return episodeCode(m.tvdbSeason, m.tvdbEpisode);
  if (m.tvdbAbsolute !== null) return `#${m.tvdbAbsolute}`;
  if (m.tvdbSeason !== null) return `S${String(m.tvdbSeason).padStart(2, '0')}`;
  return '—';
}

/** Manual rules first (the api already sends them so), then by kind and scene numbers. */
export function orderMappings(rows: readonly SceneMapping[]): SceneMapping[] {
  const kindRank: Record<SceneMappingKind, number> = { title: 0, season: 1, absolute: 2 };
  const n = (v: number | null) => v ?? -1;
  return [...rows].sort(
    (a, b) =>
      (a.source === b.source ? 0 : a.source === 'manual' ? -1 : 1) ||
      kindRank[a.kind] - kindRank[b.kind] ||
      n(a.sceneSeason) - n(b.sceneSeason) ||
      n(a.sceneEpisode) - n(b.sceneEpisode) ||
      n(a.sceneAbsolute) - n(b.sceneAbsolute) ||
      a.id - b.id,
  );
}
