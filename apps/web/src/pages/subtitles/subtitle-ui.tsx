import { useMemo, useState } from 'react';
import type { LanguageProfileFlagMode, SubtitleHistoryAction, SubtitleLanguageOption, SubtitleLanguageRef, SubtitleState } from '@arclight/shared';
import { Input } from '../../arclight/index.js';
import { useSubtitleLanguages } from '../../hooks/subtitles.js';
import { cx } from '../../lib/cx.js';
import './subtitles.css';
import { t } from '../../i18n/index.js';

// Small pieces shared by the subtitles pages, settings and the per-item Subtitles tab.

export const FLAG_MODE_LABELS: Record<LanguageProfileFlagMode, string> = { get never() { return t('common.never'); }, get also() { return t('subtitles.subtitleUi.also'); }, get only() { return t('subtitles.subtitleUi.only'); } };

export const HISTORY_ACTION_LABELS: Record<SubtitleHistoryAction, string> = {
  get deleted() {
    return t('common.deleted');
  },
  get downloaded() {
    return t('status.downloaded');
  },
  get manualDownload() {
    return t('subtitles.subtitleUi.manualDownload');
  },
  get upgraded() {
    return t('subtitles.subtitleUi.upgraded');
  },
  get uploaded() {
    return t('subtitles.subtitleUi.uploaded');
  },
  get synced() {
    return t('subtitles.subtitleUi.synced');
  },
  get translated() {
    return t('subtitles.subtitleUi.translated');
  },
  get extracted() {
    return t('subtitles.subtitleUi.extracted');
  },
};

/** code -> display name, falling back to the code until the language list loads. */
export function useLanguageName(): (code: string) => string {
  const languages = useSubtitleLanguages();
  const map = useMemo(() => new Map((languages.data ?? []).map((l) => [l.code, l.name])), [languages.data]);
  return (code) => map.get(code) ?? code;
}

/** "English (forced)" style label for a language triple. */
export function refLabel(ref: Pick<SubtitleLanguageRef, 'language' | 'forced' | 'hi'>, name: (c: string) => string = (c) => c): string {
  const flags = [ref.forced ? 'forced' : null, ref.hi ? 'HI' : null].filter(Boolean);
  return `${name(ref.language)}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

export function formatPercent(score: number | null, outOf: number | null): string {
  if (score === null || !outOf) return '—';
  return `${Math.round((score / outOf) * 100)}%`;
}

function Markers({ forced, hi }: { forced: boolean; hi: boolean }) {
  return (
    <>
      {forced ? <span className="sub-chip-marker" title={t('common.forced')}>{t('subtitles.subtitleUi.f')}</span> : null}
      {hi ? <span className="sub-chip-marker" title={t('subtitles.subtitleUi.hearingImpaired')}>{t('common.hi')}</span> : null}
    </>
  );
}

/** A wanted-but-missing language: red outline. */
export function MissingChip({ refItem }: { refItem: SubtitleLanguageRef }) {
  const name = useLanguageName();
  return (
    <span className="sub-chip sub-chip-missing" data-testid="missing-chip" title={t('subtitles.subtitleUi.missingReflabel', { refLabel: refLabel(refItem, name) })}>
      {refItem.language}
      <Markers forced={refItem.forced} hi={refItem.hi} />
    </span>
  );
}

export function MissingChips({ missing }: { missing: readonly SubtitleLanguageRef[] }) {
  if (missing.length === 0) return <span className="sub-none">—</span>;
  return (
    <span className="sub-chips">
      {missing.map((m) => (
        <MissingChip key={`${m.language}-${m.forced}-${m.hi}`} refItem={m} />
      ))}
    </span>
  );
}

/** A present subtitle: solid for external files, dashed for embedded tracks. */
export function SubtitleChip({ subtitle, children }: { subtitle: SubtitleState; children?: React.ReactNode }) {
  const name = useLanguageName();
  const kind = subtitle.embedded ? 'embedded' : 'external';
  return (
    <span
      className={cx('sub-chip', `sub-chip-${kind}`)}
      data-testid="subtitle-chip"
      data-kind={kind}
      title={`${refLabel(subtitle, name)} · ${kind}${subtitle.codec ? ` · ${subtitle.codec}` : ''}${subtitle.provider ? ` · ${subtitle.provider}` : ''}`}
    >
      {subtitle.language}
      <span className="sub-chip-marker">{subtitle.embedded ? t('subtitles.subtitleUi.emb') : t('subtitles.subtitleUi.ext')}</span>
      <Markers forced={subtitle.forced} hi={subtitle.hi} />
      {children}
    </span>
  );
}

export function filterLanguages(all: readonly SubtitleLanguageOption[], query: string, exclude: readonly string[] = []): SubtitleLanguageOption[] {
  const q = query.trim().toLowerCase();
  return all.filter((l) => !exclude.includes(l.code) && (!q || l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)));
}

/** Searchable language list; picking one calls onPick (the input clears). */
export function LanguagePicker({
  onPick,
  exclude = [],
  label = t('subtitles.subtitleUi.searchLanguages'),
}: {
  onPick: (code: string) => void;
  exclude?: readonly string[];
  label?: string;
}) {
  const languages = useSubtitleLanguages();
  const [query, setQuery] = useState('');
  const matches = filterLanguages(languages.data ?? [], query, exclude).slice(0, 50);
  return (
    <div className="sub-language-picker">
      <Input aria-label={label} placeholder={t('subtitles.subtitleUi.typeToSearchLanguages')} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      {query.trim() ? (
        <ul role="listbox" aria-label={t('common.languages')}>
          {matches.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onPick(l.code);
                  setQuery('');
                }}
              >
                {l.name} <span className="sub-code">{l.code}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 ? <li className="sub-none">{t('subtitles.subtitleUi.noMatch')}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
