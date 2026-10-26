import { useId, useState, type DragEvent } from 'react';
import {
  LANGUAGE_PROFILE_CUTOFF_ANY,
  LanguageProfileFlagMode,
  type LanguageProfile,
  type LanguageProfileInput,
  type LanguageProfileItem,
} from '@arclight/shared';
import { ApiError, errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Field, Input, Modal, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { ConfirmDialog, inUseMessage } from '../../../components/forms/confirm-dialog.js';
import { TermList } from '../../../components/forms/term-list.js';
import { useDeleteLanguageProfile, useLanguageProfiles, useSaveLanguageProfile } from '../../../hooks/subtitles.js';
import { FLAG_MODE_LABELS, LanguagePicker, useLanguageName } from '../../subtitles/subtitle-ui.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, PendingApiNotice, SaveError, SettingsSection } from '../shared.js';
import './subtitle-settings.css';
import { t } from '../../../i18n/index.js';

export const EMPTY_LANGUAGE_PROFILE: LanguageProfileInput = {
  name: '',
  languages: [],
  cutoff: null,
  mustContain: [],
  mustNotContain: [],
  originalFormat: false,
};

export interface CutoffOption {
  value: string;
  label: string;
}

/** Cutoff choices: None (every language wanted), Any, or one of the profile's languages. */
export function cutoffOptions(languages: readonly LanguageProfileItem[], name: (code: string) => string = (c) => c): CutoffOption[] {
  const codes = [...new Set(languages.map((l) => l.code))];
  return [
    { value: '', label: t('common.none') },
    { value: LANGUAGE_PROFILE_CUTOFF_ANY, label: t('settings.subtitles.languageProfilesCard.anyLanguage') },
    ...codes.map((c) => ({ value: c, label: name(c) })),
  ];
}

/** Body for POST/PUT: trims the name and drops a cutoff that no longer names a profile language. */
export function toProfileBody(draft: LanguageProfileInput): LanguageProfileInput {
  const valid = draft.cutoff === null || draft.cutoff === LANGUAGE_PROFILE_CUTOFF_ANY || draft.languages.some((l) => l.code === draft.cutoff);
  return { ...draft, name: draft.name.trim(), cutoff: valid ? draft.cutoff : null };
}

/** Move the item at `from` to position `to` (drag and drop, or ±1 from the keyboard buttons). */
export function moveLanguage<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

function profileInput(p: LanguageProfile): LanguageProfileInput {
  const { id: _id, ...rest } = p;
  return structuredClone(rest);
}

const FLAG_OPTIONS = LanguageProfileFlagMode.options.map((m) => ({ value: m, label: FLAG_MODE_LABELS[m] }));

/** Ordered language rows: ⋮⋮ drag handle, name + mono code, forced / HI modes, move and remove. */
function LanguageRows({
  languages,
  cutoff,
  name,
  onChange,
}: {
  languages: readonly LanguageProfileItem[];
  cutoff: string | null;
  name: (code: string) => string;
  onChange: (next: LanguageProfileItem[]) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const setItem = (index: number, patch: Partial<LanguageProfileItem>) => onChange(languages.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const onDragStart = (index: number) => (e: DragEvent) => {
    setDragging(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };
  const onDragOver = (index: number) => (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOver(index);
  };
  const onDrop = (index: number) => (e: DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    const from = dragging ?? (raw === '' ? NaN : Number(raw));
    if (Number.isInteger(from)) onChange(moveLanguage(languages, from, index));
    setDragging(null);
    setOver(null);
  };
  const end = () => {
    setDragging(null);
    setOver(null);
  };

  if (languages.length === 0) return <p className="al-caption">{t('settings.subtitles.languageProfilesCard.noLanguagesYetAddOne')}</p>;

  return (
    <ol className="al-lang-list" aria-label={t('settings.subtitles.languageProfilesCard.profileLanguages')}>
      {languages.map((l, i) => {
        const label = name(l.code);
        return (
          <li
            key={`${l.code}-${i}`}
            className="al-lang-row"
            data-dragging={dragging === i || undefined}
            data-over={over === i && dragging !== i ? true : undefined}
            draggable
            onDragStart={onDragStart(i)}
            onDragOver={onDragOver(i)}
            onDrop={onDrop(i)}
            onDragEnd={end}
          >
            <span className="al-lang-row__handle" aria-hidden="true" title={t('settings.subtitles.languageProfilesCard.dragToReorder')}>
              ⋮⋮
            </span>
            <span className="al-lang-row__name">
              {label} <span className="al-num al-lang-row__code">{l.code}</span>
              {cutoff === l.code ? <Chip tone="accent">{t('settings.subtitles.languageProfilesCard.cutoff')}</Chip> : null}
            </span>
            <label className="al-lang-row__flag">
              <span className="al-lang-row__flag-label">{t('common.forced')}</span>
              <Select aria-label={t('settings.subtitles.languageProfilesCard.forcedForCode', { code: l.code })} value={l.forced} onChange={(e) => setItem(i, { forced: e.currentTarget.value as LanguageProfileFlagMode })} options={FLAG_OPTIONS} />
            </label>
            <label className="al-lang-row__flag">
              <span className="al-lang-row__flag-label">{t('common.hi')}</span>
              <Select aria-label={t('settings.subtitles.languageProfilesCard.hiForCode', { code: l.code })} value={l.hi} onChange={(e) => setItem(i, { hi: e.currentTarget.value as LanguageProfileFlagMode })} options={FLAG_OPTIONS} />
            </label>
            <span className="al-lang-row__actions">
              <Button size="sm" variant="ghost" aria-label={t('settings.subtitles.languageProfilesCard.moveCodeUp', { code: l.code })} disabled={i === 0} onClick={() => onChange(moveLanguage(languages, i, i - 1))}>
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('settings.subtitles.languageProfilesCard.moveCodeDown', { code: l.code })}
                disabled={i === languages.length - 1}
                onClick={() => onChange(moveLanguage(languages, i, i + 1))}
              >
                ↓
              </Button>
              <Button size="sm" variant="ghost" aria-label={t('settings.subtitles.languageProfilesCard.removeCode', { code: l.code })} onClick={() => onChange(languages.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function LanguageProfileEditor({ profile, onClose }: { profile: LanguageProfile | null; onClose: () => void }) {
  const [draft, setDraft] = useState<LanguageProfileInput>(() => (profile ? profileInput(profile) : structuredClone(EMPTY_LANGUAGE_PROFILE)));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveLanguageProfile();
  const remove = useDeleteLanguageProfile();
  const name = useLanguageName();
  const ids = useId();

  const submit = () => {
    if (!draft.name.trim()) return setError(t('common.nameIsRequired'));
    if (draft.languages.length === 0) return setError(t('settings.subtitles.languageProfilesCard.addAtLeastOneLanguage'));
    setError(null);
    save.mutate({ id: profile?.id, body: toProfileBody(draft) }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size={640}
        onClose={onClose}
        title={profile ? t('settings.subtitles.languageProfilesCard.editName', { name: profile.name }) : t('settings.subtitles.languageProfilesCard.addLanguageProfile')}
        footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} onDelete={profile ? () => setConfirmDelete(true) : undefined} />}
      >
        <div className="al-editor-stack">
          <Field label={t('common.name')}>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
          </Field>
          <div className="al-editor-stack__group" role="group" aria-labelledby={`${ids}-langs`}>
            <div className="al-label" id={`${ids}-langs`}>
              {t('settings.subtitles.languageProfilesCard.languagesInSearchOrder')}
            </div>
            <LanguageRows languages={draft.languages} cutoff={draft.cutoff} name={name} onChange={(languages) => setDraft((d) => ({ ...d, languages }))} />
            <LanguagePicker
              label={t('settings.subtitles.languageProfilesCard.addLanguage')}
              exclude={draft.languages.map((l) => l.code)}
              onPick={(code) => setDraft((d) => ({ ...d, languages: [...d.languages, { code, forced: 'never', hi: 'also' }] }))}
            />
          </div>
          <Field label={t('settings.subtitles.languageProfilesCard.cutoff')} hint={t('settings.subtitles.languageProfilesCard.onceASubtitleForThe')}>
            <Select
              value={draft.cutoff ?? ''}
              onChange={(e) => setDraft({ ...draft, cutoff: e.currentTarget.value || null })}
              options={cutoffOptions(draft.languages, name)}
            />
          </Field>
          <Field label={t('settings.subtitles.languageProfilesCard.mustContain')} hint={t('settings.subtitles.languageProfilesCard.releaseInfoMustMatchOne')}>
            <TermList value={draft.mustContain} onChange={(mustContain) => setDraft({ ...draft, mustContain })} />
          </Field>
          <Field label={t('settings.subtitles.languageProfilesCard.mustNotContain')} hint={t('settings.subtitles.languageProfilesCard.releaseInfoMatchingAnyOf')}>
            <TermList value={draft.mustNotContain} onChange={(mustNotContain) => setDraft({ ...draft, mustNotContain })} />
          </Field>
          <Toggle
            label={t('settings.subtitles.languageProfilesCard.keepOriginalFormatDoNot')}
            checked={draft.originalFormat}
            onChange={(e) => setDraft({ ...draft, originalFormat: e.currentTarget.checked })}
          />
          {error ? (
            <p className="al-inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <SaveError error={save.error} />
        </div>
      </Modal>
      {profile ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.subtitles.languageProfilesCard.deleteName', { name: profile.name })}
          confirmLabel={t('settings.subtitles.languageProfilesCard.deleteLanguageProfile')}
          describeError={(err) => inUseMessage(err, 'language profile')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(profile.id);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}

export function LanguageProfilesCard() {
  const list = useLanguageProfiles();
  const name = useLanguageName();
  const [editing, setEditing] = useState<LanguageProfile | 'new' | null>(null);
  const pending = list.error instanceof ApiError && list.error.status === 404;

  return (
    <SettingsSection label={t('settings.subtitles.languageProfilesCard.languageProfiles')} {...(list.data ? { count: list.data.length } : {})}>
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : pending ? (
        <PendingApiNotice what={t('settings.subtitles.languageProfilesCard.languageProfiles2')} />
      ) : list.isError ? (
        <ErrorBlock title={t('settings.subtitles.languageProfilesCard.couldNotLoadLanguageProfiles')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <CardGrid label={t('settings.subtitles.languageProfilesCard.languageProfiles')}>
          {list.data.map((p) => (
            <ItemCard
              key={p.id}
              title={p.name}
              onClick={() => setEditing(p)}
              actions={
                <Button size="sm" variant="secondary" onClick={() => setEditing(p)} aria-label={t('settings.subtitles.languageProfilesCard.editName', { name: p.name })}>
                  {t('common.edit')}
                </Button>
              }
            >
              {p.languages.map((l, i) => (
                <Chip key={`${l.code}-${i}`} tone={p.cutoff === l.code ? 'accent' : 'neutral'} dot={p.cutoff === l.code ? 'fill' : 'none'}>
                  {name(l.code)}
                  {l.forced !== 'never' ? t('settings.subtitles.languageProfilesCard.forcedForced', { forced: l.forced }) : ''}
                  {l.hi !== 'also' ? t('settings.subtitles.languageProfilesCard.hiHi', { hi: l.hi }) : ''}
                </Chip>
              ))}
            </ItemCard>
          ))}
          <AddCard label={t('settings.subtitles.languageProfilesCard.addLanguageProfile')} onClick={() => setEditing('new')} />
        </CardGrid>
      )}
      {editing ? (
        <LanguageProfileEditor key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsSection>
  );
}
