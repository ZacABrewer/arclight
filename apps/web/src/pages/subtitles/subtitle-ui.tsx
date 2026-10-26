import { useMemo, useState } from 'react';
import type { LanguageProfileFlagMode, SubtitleHistoryAction, SubtitleLanguageOption, SubtitleLanguageRef, SubtitleState } from '@media-tron/shared';
import { Input } from '../../components/form.js';
import { useSubtitleLanguages } from '../../hooks/subtitles.js';
import { cx } from '../../lib/cx.js';
import './subtitles.css';

// Small pieces shared by the subtitles pages, settings and the per-item Subtitles tab.

export const FLAG_MODE_LABELS: Record<LanguageProfileFlagMode, string> = { never: 'Never', also: 'Also', only: 'Only' };

export const HISTORY_ACTION_LABELS: Record<SubtitleHistoryAction, string> = {
  deleted: 'Deleted',
  downloaded: 'Downloaded',
  manualDownload: 'Manual download',
  upgraded: 'Upgraded',
  uploaded: 'Uploaded',
  synced: 'Synced',
  translated: 'Translated',
  extracted: 'Extracted',
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
      {forced ? <span className="sub-chip-marker" title="Forced">F</span> : null}
      {hi ? <span className="sub-chip-marker" title="Hearing impaired">HI</span> : null}
    </>
  );
}

/** A wanted-but-missing language: red outline. */
export function MissingChip({ refItem }: { refItem: SubtitleLanguageRef }) {
  const name = useLanguageName();
  return (
    <span className="sub-chip sub-chip-missing" data-testid="missing-chip" title={`Missing: ${refLabel(refItem, name)}`}>
      {refItem.language}
      <Markers forced={refItem.forced} hi={refItem.hi} />
    </span>
  );
}

export function MissingChips({ missing }: { missing: readonly SubtitleLanguageRef[] }) {
  if (missing.length === 0) return <span className="muted">—</span>;
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
      <span className="sub-chip-marker">{subtitle.embedded ? 'emb' : 'ext'}</span>
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
  label = 'Search languages',
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
      <Input aria-label={label} placeholder="Type to search languages" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      {query.trim() ? (
        <ul role="listbox" aria-label="Languages">
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
                {l.name} <span className="muted">({l.code})</span>
              </button>
            </li>
          ))}
          {matches.length === 0 ? <li className="muted">No match</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
