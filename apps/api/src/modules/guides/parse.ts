import { CustomFormatInput, type CustomFormatSpec, type GuideApp } from '@arclight/shared';
import { mapSpec } from '../migrate/mappers/custom-formats.js';

// Guide JSON → Arclight shapes. A custom-format file is the community export format
// (`trash_id`, `trash_scores`, `name`, `includeCustomFormatWhenRenaming`, `specifications`
// with *arr implementation names and numeric enum values that differ per app). A
// quality-profile file names its formats (`formatItems: { name: trash_id }`) and the score
// set it uses (`trash_score_set`, default `default`). Specifications are translated by the
// same mapper the migrate module uses for *arr databases.

export interface GuideFormat {
  app: GuideApp;
  guideId: string;
  /** Name as published (before any cross-app suffix). */
  name: string;
  input: CustomFormatInput;
  /** `trash_scores`: score set → score. */
  scores: Record<string, number>;
  /** Specifications that could not be translated (dropped). */
  warnings: string[];
  file: string;
}

export interface GuideProfile {
  app: GuideApp;
  trashId: string;
  name: string;
  description: string;
  scoreSet: string;
  formatItems: Array<{ name: string; guideId: string }>;
  file: string;
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parse one custom-format file; returns an error string when it is not usable. */
export function parseGuideFormat(raw: unknown, app: GuideApp, file: string): GuideFormat | string {
  if (!isObj(raw)) return `${file}: not an object`;
  const guideId = typeof raw.trash_id === 'string' ? raw.trash_id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!guideId) return `${file}: missing trash_id`;
  if (!name) return `${file}: missing name`;

  const warnings: string[] = [];
  const specifications: CustomFormatSpec[] = [];
  for (const spec of Array.isArray(raw.specifications) ? raw.specifications : []) {
    const mapped = mapSpec(app, spec);
    if (mapped.spec) specifications.push(mapped.spec);
    else warnings.push(mapped.reason ?? 'unreadable specification');
  }
  if (specifications.length === 0) return `${file}: no specification Arclight can express (${warnings.join('; ') || 'none listed'})`;

  const parsed = CustomFormatInput.safeParse({
    name,
    includeWhenRenaming: raw.includeCustomFormatWhenRenaming === true,
    specifications,
  });
  if (!parsed.success) return `${file}: ${parsed.error.issues[0]?.message ?? 'invalid format'}`;

  const scores: Record<string, number> = {};
  if (isObj(raw.trash_scores)) {
    for (const [set, value] of Object.entries(raw.trash_scores)) {
      if (typeof value === 'number' && Number.isInteger(value)) scores[set] = value;
    }
  }
  return { app, guideId, name, input: parsed.data, scores, warnings, file };
}

function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** Parse one quality-profile file. */
export function parseGuideProfile(raw: unknown, app: GuideApp, file: string): GuideProfile | string {
  if (!isObj(raw)) return `${file}: not an object`;
  const trashId = typeof raw.trash_id === 'string' ? raw.trash_id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!trashId || !name) return `${file}: missing trash_id or name`;
  const formatItems: GuideProfile['formatItems'] = [];
  if (isObj(raw.formatItems)) {
    for (const [formatName, id] of Object.entries(raw.formatItems)) {
      if (typeof id === 'string' && id.trim()) formatItems.push({ name: formatName, guideId: id.trim() });
    }
  }
  return {
    app,
    trashId,
    name,
    description: typeof raw.trash_description === 'string' ? plainText(raw.trash_description) : '',
    scoreSet: typeof raw.trash_score_set === 'string' && raw.trash_score_set.trim() ? raw.trash_score_set.trim() : 'default',
    formatItems,
    file,
  };
}

/** The score a format gets under a score set: the set's value, else `default`, else undefined. */
export function scoreFor(format: Pick<GuideFormat, 'scores'>, scoreSet: string): number | undefined {
  return format.scores[scoreSet] ?? format.scores['default'];
}
