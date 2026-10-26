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
    { value: '', label: 'None' },
    { value: LANGUAGE_PROFILE_CUTOFF_ANY, label: 'Any language' },
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

  if (languages.length === 0) return <p className="al-caption">No languages yet. Add one below; the first language is searched first.</p>;

  return (
    <ol className="al-lang-list" aria-label="Profile languages">
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
            <span className="al-lang-row__handle" aria-hidden="true" title="Drag to reorder">
              ⋮⋮
            </span>
            <span className="al-lang-row__name">
              {label} <span className="al-num al-lang-row__code">{l.code}</span>
              {cutoff === l.code ? <Chip tone="accent">Cutoff</Chip> : null}
            </span>
            <label className="al-lang-row__flag">
              <span className="al-lang-row__flag-label">Forced</span>
              <Select aria-label={`Forced for ${l.code}`} value={l.forced} onChange={(e) => setItem(i, { forced: e.currentTarget.value as LanguageProfileFlagMode })} options={FLAG_OPTIONS} />
            </label>
            <label className="al-lang-row__flag">
              <span className="al-lang-row__flag-label">HI</span>
              <Select aria-label={`HI for ${l.code}`} value={l.hi} onChange={(e) => setItem(i, { hi: e.currentTarget.value as LanguageProfileFlagMode })} options={FLAG_OPTIONS} />
            </label>
            <span className="al-lang-row__actions">
              <Button size="sm" variant="ghost" aria-label={`Move ${l.code} up`} disabled={i === 0} onClick={() => onChange(moveLanguage(languages, i, i - 1))}>
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Move ${l.code} down`}
                disabled={i === languages.length - 1}
                onClick={() => onChange(moveLanguage(languages, i, i + 1))}
              >
                ↓
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Remove ${l.code}`} onClick={() => onChange(languages.filter((_, j) => j !== i))}>
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
    if (!draft.name.trim()) return setError('Name is required');
    if (draft.languages.length === 0) return setError('Add at least one language');
    setError(null);
    save.mutate({ id: profile?.id, body: toProfileBody(draft) }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size={640}
        onClose={onClose}
        title={profile ? `Edit ${profile.name}` : 'Add language profile'}
        footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} onDelete={profile ? () => setConfirmDelete(true) : undefined} />}
      >
        <div className="al-editor-stack">
          <Field label="Name">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
          </Field>
          <div className="al-editor-stack__group" role="group" aria-labelledby={`${ids}-langs`}>
            <div className="al-label" id={`${ids}-langs`}>
              Languages · in search order
            </div>
            <LanguageRows languages={draft.languages} cutoff={draft.cutoff} name={name} onChange={(languages) => setDraft((d) => ({ ...d, languages }))} />
            <LanguagePicker
              label="Add language"
              exclude={draft.languages.map((l) => l.code)}
              onPick={(code) => setDraft((d) => ({ ...d, languages: [...d.languages, { code, forced: 'never', hi: 'also' }] }))}
            />
          </div>
          <Field label="Cutoff" hint="Once a subtitle for the cutoff exists nothing else is searched. None wants every language.">
            <Select
              value={draft.cutoff ?? ''}
              onChange={(e) => setDraft({ ...draft, cutoff: e.currentTarget.value || null })}
              options={cutoffOptions(draft.languages, name)}
            />
          </Field>
          <Field label="Must contain" hint="Release info must match one of these (regex or text).">
            <TermList value={draft.mustContain} onChange={(mustContain) => setDraft({ ...draft, mustContain })} />
          </Field>
          <Field label="Must not contain" hint="Release info matching any of these is rejected.">
            <TermList value={draft.mustNotContain} onChange={(mustNotContain) => setDraft({ ...draft, mustNotContain })} />
          </Field>
          <Toggle
            label="Keep original format (do not convert to SubRip)"
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
          title={`Delete ${profile.name}?`}
          confirmLabel="Delete language profile"
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
    <SettingsSection label="Language profiles" {...(list.data ? { count: list.data.length } : {})}>
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : pending ? (
        <PendingApiNotice what="language profiles" />
      ) : list.isError ? (
        <ErrorBlock title="Could not load language profiles" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <CardGrid label="Language profiles">
          {list.data.map((p) => (
            <ItemCard
              key={p.id}
              title={p.name}
              onClick={() => setEditing(p)}
              actions={
                <Button size="sm" variant="secondary" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                  Edit
                </Button>
              }
            >
              {p.languages.map((l, i) => (
                <Chip key={`${l.code}-${i}`} tone={p.cutoff === l.code ? 'accent' : 'neutral'} dot={p.cutoff === l.code ? 'fill' : 'none'}>
                  {name(l.code)}
                  {l.forced !== 'never' ? ` · forced ${l.forced}` : ''}
                  {l.hi !== 'also' ? ` · HI ${l.hi}` : ''}
                </Chip>
              ))}
            </ItemCard>
          ))}
          <AddCard label="Add language profile" onClick={() => setEditing('new')} />
        </CardGrid>
      )}
      {editing ? (
        <LanguageProfileEditor key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsSection>
  );
}
