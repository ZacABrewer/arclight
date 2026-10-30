import { useMemo, useState } from 'react';
import type { CreateLanguageRequest, LanguageRequestKind, LanguageRequestOptions, MediaType, SubtitleLanguageOption } from '@arclight/shared';
import { LANGUAGE_REQUEST_NOTE_MAX } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Checkbox, Chip, Field, FormRow, Input, Modal, Segmented, Select, Skeleton, Textarea } from '../../arclight/index.js';
import { QueryError } from '../../components/media/media-kit.js';
import { useToast } from '../../components/toast.js';
import { useCreateLanguageRequest, useLanguageRequestOptions, useRequestableLanguages } from '../../hooks/language-requests.js';
import { t } from '../../i18n/index.js';
import './language-requests.css';

// "Request subtitles or audio" on a title page: a portal user asks for subtitles in a language
// (forced only / hearing impaired as simple checkboxes) or for an additional audio language, for
// the whole title or one season. The dialog shows what the title already has and what is
// already asked for, and refuses those languages up front (the api checks again: 409).

export interface LanguageDraft {
  kind: LanguageRequestKind;
  language: string | null;
  forcedOnly: boolean;
  hearingImpaired: boolean;
  /** '' = the whole series. */
  season: string;
  note: string;
}

export const EMPTY_LANGUAGE_DRAFT: LanguageDraft = { kind: 'subtitle', language: null, forcedOnly: false, hearingImpaired: false, season: '', note: '' };

/** Base tag of a language ("pt-BR" → "pt"); audio is compared by it. */
const baseOf = (code: string) => code.split('-')[0]!.toLowerCase();

/** The subtitle chip key the draft would add: `en`, `en:forced` or `en:hi`. */
export function subtitleKeyOf(code: string, forcedOnly: boolean, hearingImpaired: boolean): string {
  return forcedOnly ? `${code}:forced` : hearingImpaired ? `${code}:hi` : code;
}

/**
 * Why a language cannot be requested with the current draft, or null. Present languages come
 * from the whole-title chips; open requests count at the same scope (or a whole-series one).
 */
export function unavailableReason(options: LanguageRequestOptions, draft: LanguageDraft, code: string): string | null {
  const season = draft.season === '' ? null : Number(draft.season);
  if (draft.kind === 'audio') {
    if (options.audio.some((c) => c.present && baseOf(c.language) === baseOf(code))) return t('discover.languageRequest.alreadyHas');
  } else {
    const key = subtitleKeyOf(code, draft.forcedOnly, draft.hearingImpaired);
    if (options.subtitles.some((c) => c.present && c.language === key)) return t('discover.languageRequest.alreadyHas');
  }
  const open = options.openRequests.some(
    (r) => r.kind === draft.kind && (draft.kind === 'audio' ? baseOf(r.language) === baseOf(code) : r.language === code) && (r.seasonNumber === null || r.seasonNumber === season),
  );
  return open ? t('discover.languageRequest.alreadyRequested') : null;
}

/** The POST body for a draft; null while no language is picked. */
export function buildLanguageRequest(mediaType: MediaType, tmdbId: number, draft: LanguageDraft): CreateLanguageRequest | null {
  if (!draft.language) return null;
  const note = draft.note.trim();
  return {
    kind: draft.kind,
    mediaType,
    tmdbId,
    language: draft.language,
    ...(mediaType === 'series' && draft.season !== '' ? { seasonNumber: Number(draft.season) } : {}),
    ...(draft.kind === 'subtitle' ? { forced: draft.forcedOnly ? ('only' as const) : ('never' as const), hi: draft.hearingImpaired ? ('only' as const) : ('also' as const) } : {}),
    ...(note ? { note } : {}),
  };
}

/** "English", "English (forced)", "English (HI)" for a chip key. */
function chipLabel(key: string, name: (code: string) => string): string {
  const [code = key, flag] = key.split(':');
  if (flag === 'forced') return t('discover.languageRequest.forcedLabel', { name: name(code) });
  if (flag === 'hi') return t('discover.languageRequest.hiLabel', { name: name(code) });
  return name(code);
}

export function LanguageRequestModal({ open, onClose, mediaType, tmdbId, title }: { open: boolean; onClose: () => void; mediaType: MediaType; tmdbId: number; title: string }) {
  return (
    <Modal open={open} onClose={onClose} title={t('discover.languageRequest.dialogTitle', { title })} size={560}>
      {open ? <LanguageRequestBody onClose={onClose} mediaType={mediaType} tmdbId={tmdbId} title={title} /> : null}
    </Modal>
  );
}

function LanguageRequestBody({ onClose, mediaType, tmdbId, title }: { onClose: () => void; mediaType: MediaType; tmdbId: number; title: string }) {
  const options = useLanguageRequestOptions({ mediaType, tmdbId });
  const languages = useRequestableLanguages();
  if (options.isPending || languages.isPending) return <Skeleton lines={4} />;
  if (options.isError) return <QueryError error={options.error} title={t('discover.languageRequest.couldNotLoad')} onRetry={() => void options.refetch()} />;
  if (languages.isError) return <QueryError error={languages.error} title={t('discover.languageRequest.couldNotLoad')} onRetry={() => void languages.refetch()} />;
  return <LanguageRequestForm options={options.data} languages={languages.data} onClose={onClose} mediaType={mediaType} tmdbId={tmdbId} title={title} />;
}

function LanguageRequestForm({
  options,
  languages,
  onClose,
  mediaType,
  tmdbId,
  title,
}: {
  options: LanguageRequestOptions;
  languages: readonly SubtitleLanguageOption[];
  onClose: () => void;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
}) {
  const toast = useToast();
  const create = useCreateLanguageRequest();
  const [draft, setDraft] = useState<LanguageDraft>(EMPTY_LANGUAGE_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const names = useMemo(() => new Map(languages.map((l) => [l.code, l.name])), [languages]);
  const name = (code: string) => names.get(code) ?? names.get(baseOf(code)) ?? code;
  const set = (patch: Partial<LanguageDraft>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  if (!options.inLibrary) return <p className="mk-muted">{t('discover.languageRequest.notInLibrary')}</p>;
  if (!options.canRequest) return <p className="mk-muted">{t('discover.languageRequest.notAllowed')}</p>;

  const picked = draft.language;
  const pickedReason = picked ? unavailableReason(options, draft, picked) : null;
  const chips = (draft.kind === 'audio' ? options.audio : options.subtitles).filter((c) => c.present || c.added);
  const open = options.openRequests.filter((r) => r.kind === draft.kind);

  const submit = () => {
    const body = buildLanguageRequest(mediaType, tmdbId, draft);
    if (!body) {
      setError(t('discover.languageRequest.pickALanguage'));
      return;
    }
    if (pickedReason) {
      setError(pickedReason);
      return;
    }
    create.mutate(body, {
      onSuccess: (r) => {
        if (r.status === 'failed') toast.push({ tone: 'warning', title: t('discover.languageRequest.failed'), message: r.failureReason ?? title });
        else toast.push({ tone: 'ok', title: r.status === 'pending' ? t('discover.languageRequest.requested') : t('discover.languageRequest.approvedAndSearching'), message: title });
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <form
      className="mk-stack-sm"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Segmented
        aria-label={t('discover.languageRequest.kind')}
        value={draft.kind}
        onChange={(kind) => set({ kind })}
        options={[
          { value: 'subtitle', label: t('discover.languageRequest.subtitles') },
          { value: 'audio', label: t('discover.languageRequest.audioLanguage') },
        ]}
      />
      <p className="al-caption" style={{ margin: 0 }}>
        {draft.kind === 'subtitle' ? t('discover.languageRequest.subtitleIntro') : t('discover.languageRequest.audioIntro')}
      </p>

      <div className="lr-have" aria-label={t('discover.languageRequest.alreadyOnTitle')}>
        <span className="al-label">{t('discover.languageRequest.alreadyOnTitle')}</span>
        {chips.length > 0 ? (
          chips.map((c) => (
            <Chip key={c.language} tone={c.present ? 'accent' : 'neutral'}>
              {draft.kind === 'audio' ? name(c.language) : chipLabel(c.language, name)}
            </Chip>
          ))
        ) : (
          <span className="mk-muted">{t('discover.languageRequest.none')}</span>
        )}
      </div>
      {open.length > 0 ? (
        <div className="lr-have" aria-label={t('discover.languageRequest.openRequests')}>
          <span className="al-label">{t('discover.languageRequest.openRequests')}</span>
          {open.map((r) => (
            <Chip key={r.id} tone="default">
              {name(r.language)}
              {r.seasonNumber !== null ? ` · ${t('discover.languageRequest.seasonN', { season: r.seasonNumber })}` : ''}
            </Chip>
          ))}
        </div>
      ) : null}

      {mediaType === 'series' ? (
        <FormRow label={t('discover.languageRequest.scope')} htmlFor="lr-scope">
          <Select
            id="lr-scope"
            value={draft.season}
            onChange={(e) => set({ season: e.currentTarget.value })}
            options={[
              { value: '', label: t('discover.languageRequest.allSeasons') },
              ...options.seasons.map((s) => ({
                value: String(s.seasonNumber),
                label: s.seasonNumber === 0 ? t('common.specials') : t('discover.languageRequest.seasonN', { season: s.seasonNumber }),
              })),
            ]}
          />
        </FormRow>
      ) : null}

      <FormRow label={t('discover.languageRequest.language')}>
        {picked ? (
          <div className="mk-row" style={{ gap: 8 }}>
            <Chip tone="accent">{name(picked)}</Chip>
            <Button size="sm" variant="ghost" onClick={() => set({ language: null })}>
              {t('discover.languageRequest.change')}
            </Button>
          </div>
        ) : (
          <LanguageSearch languages={languages} reason={(code) => unavailableReason(options, draft, code)} onPick={(code) => set({ language: code })} />
        )}
      </FormRow>

      {draft.kind === 'subtitle' ? (
        <div className="mk-row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <Checkbox
            label={t('discover.languageRequest.forcedOnly')}
            aria-label={t('discover.languageRequest.forcedOnly')}
            hint={t('discover.languageRequest.forcedOnlyHint')}
            checked={draft.forcedOnly}
            onChange={(e) => set({ forcedOnly: e.currentTarget.checked, ...(e.currentTarget.checked ? { hearingImpaired: false } : {}) })}
          />
          <Checkbox
            label={t('discover.languageRequest.hearingImpaired')}
            aria-label={t('discover.languageRequest.hearingImpaired')}
            hint={t('discover.languageRequest.hearingImpairedHint')}
            checked={draft.hearingImpaired}
            disabled={draft.forcedOnly}
            onChange={(e) => set({ hearingImpaired: e.currentTarget.checked })}
          />
        </div>
      ) : null}

      <Field label={t('discover.languageRequest.note')} hint={t('discover.languageRequest.noteHint', { max: LANGUAGE_REQUEST_NOTE_MAX })}>
        <Textarea rows={3} maxLength={LANGUAGE_REQUEST_NOTE_MAX} value={draft.note} onChange={(e) => set({ note: e.currentTarget.value })} />
      </Field>

      {error || pickedReason ? (
        <p className="al-field__error" role="alert" style={{ margin: 0 }}>
          {error ?? pickedReason}
        </p>
      ) : null}
      <div className="mk-row mk-row--end">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!picked || pickedReason !== null}>
          {t('common.request')}
        </Button>
      </div>
    </form>
  );
}

/** Searchable language list; languages that cannot be requested are shown disabled with why. */
function LanguageSearch({
  languages,
  reason,
  onPick,
}: {
  languages: readonly SubtitleLanguageOption[];
  reason: (code: string) => string | null;
  onPick: (code: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = q ? languages.filter((l) => l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)).slice(0, 50) : [];
  return (
    <div className="lr-picker">
      <Input aria-label={t('discover.languageRequest.searchLanguages')} placeholder={t('discover.languageRequest.typeToSearch')} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      {q ? (
        <ul role="listbox" aria-label={t('common.languages')}>
          {matches.map((l) => {
            const why = reason(l.code);
            return (
              <li key={l.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-disabled={why !== null}
                  disabled={why !== null}
                  onClick={() => {
                    onPick(l.code);
                    setQuery('');
                  }}
                >
                  {l.name} <span className="lr-code">{l.code}</span>
                  {why ? <span className="lr-why">{why}</span> : null}
                </button>
              </li>
            );
          })}
          {matches.length === 0 ? <li className="lr-none">{t('discover.languageRequest.noMatch')}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
