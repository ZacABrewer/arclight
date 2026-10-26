import { useState } from 'react';
import {
  LANGUAGE_PROFILE_CUTOFF_ANY,
  LanguageProfileFlagMode,
  type LanguageProfile,
  type LanguageProfileInput,
  type LanguageProfileItem,
} from '@media-tron/shared';
import { ApiError } from '../../../api/client.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../../components/form.js';
import { ConfirmDialog, inUseMessage } from '../../../components/forms/confirm-dialog.js';
import { TermList } from '../../../components/forms/term-list.js';
import { Modal } from '../../../components/modal.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useDeleteLanguageProfile, useLanguageProfiles, useSaveLanguageProfile } from '../../../hooks/subtitles.js';
import { FLAG_MODE_LABELS, LanguagePicker, useLanguageName } from '../../subtitles/subtitle-ui.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, PendingApiNotice, SaveError } from '../shared.js';

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

function profileInput(p: LanguageProfile): LanguageProfileInput {
  const { id: _id, ...rest } = p;
  return structuredClone(rest);
}

export function LanguageProfileEditor({ profile, onClose }: { profile: LanguageProfile | null; onClose: () => void }) {
  const [draft, setDraft] = useState<LanguageProfileInput>(() => (profile ? profileInput(profile) : structuredClone(EMPTY_LANGUAGE_PROFILE)));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveLanguageProfile();
  const remove = useDeleteLanguageProfile();
  const name = useLanguageName();

  const setItem = (index: number, patch: Partial<LanguageProfileItem>) =>
    setDraft((d) => ({ ...d, languages: d.languages.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));

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
        size="lg"
        onClose={onClose}
        title={profile ? `Edit ${profile.name}` : 'Add language profile'}
        footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} onDelete={profile ? () => setConfirmDelete(true) : undefined} />}
      >
        <div className="fields">
          <FormField label="Name">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
          </FormField>
          <div className="field">
            <span className="field-label">Languages</span>
            <div className="field-control">
              {draft.languages.length ? (
                <table className="table" aria-label="Profile languages">
                  <thead>
                    <tr>
                      <th scope="col">Language</th>
                      <th scope="col">Forced</th>
                      <th scope="col">Hearing impaired</th>
                      <th scope="col">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.languages.map((l, i) => (
                      <tr key={`${l.code}-${i}`}>
                        <td>
                          {name(l.code)} <span className="muted">({l.code})</span>
                        </td>
                        <td>
                          <Select
                            aria-label={`Forced for ${l.code}`}
                            value={l.forced}
                            onChange={(e) => setItem(i, { forced: e.currentTarget.value as LanguageProfileFlagMode })}
                            options={LanguageProfileFlagMode.options.map((m) => ({ value: m, label: FLAG_MODE_LABELS[m] }))}
                          />
                        </td>
                        <td>
                          <Select
                            aria-label={`HI for ${l.code}`}
                            value={l.hi}
                            onChange={(e) => setItem(i, { hi: e.currentTarget.value as LanguageProfileFlagMode })}
                            options={LanguageProfileFlagMode.options.map((m) => ({ value: m, label: FLAG_MODE_LABELS[m] }))}
                          />
                        </td>
                        <td className="align-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Remove ${l.code}`}
                            onClick={() => setDraft((d) => ({ ...d, languages: d.languages.filter((_, j) => j !== i) }))}
                          >
                            ×
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">No languages yet.</p>
              )}
              <LanguagePicker
                label="Add language"
                exclude={draft.languages.map((l) => l.code)}
                onPick={(code) => setDraft((d) => ({ ...d, languages: [...d.languages, { code, forced: 'never', hi: 'also' }] }))}
              />
            </div>
          </div>
          <FormField label="Cutoff" hint="Once a subtitle for the cutoff exists nothing else is searched. None wants every language.">
            <Select
              value={draft.cutoff ?? ''}
              onChange={(e) => setDraft({ ...draft, cutoff: e.currentTarget.value || null })}
              options={cutoffOptions(draft.languages, name)}
            />
          </FormField>
          <FormField label="Must contain" hint="Release info must match one of these (regex or text).">
            <TermList value={draft.mustContain} onChange={(mustContain) => setDraft({ ...draft, mustContain })} />
          </FormField>
          <FormField label="Must not contain" hint="Release info matching any of these is rejected.">
            <TermList value={draft.mustNotContain} onChange={(mustNotContain) => setDraft({ ...draft, mustNotContain })} />
          </FormField>
          <Toggle
            label="Keep original format (do not convert to SubRip)"
            checked={draft.originalFormat}
            onChange={(e) => setDraft({ ...draft, originalFormat: e.currentTarget.checked })}
          />
        </div>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <SaveError error={save.error} />
      </Modal>
      {profile ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${profile.name}?`}
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
    <Card title="Language profiles">
      {list.isPending ? (
        <LoadingBlock />
      ) : pending ? (
        <PendingApiNotice what="language profiles" />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <CardGrid>
          {list.data.map((p) => (
            <ItemCard key={p.id} title={p.name} onClick={() => setEditing(p)}>
              <div className="badge-row">
                {p.languages.map((l, i) => (
                  <Badge key={`${l.code}-${i}`} tone={p.cutoff === l.code ? 'info' : 'neutral'}>
                    {name(l.code)}
                    {l.forced !== 'never' ? ` · forced ${l.forced}` : ''}
                    {l.hi !== 'also' ? ` · HI ${l.hi}` : ''}
                  </Badge>
                ))}
              </div>
            </ItemCard>
          ))}
          <AddCard label="Add language profile" onClick={() => setEditing('new')} />
        </CardGrid>
      )}
      {editing ? (
        <LanguageProfileEditor key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </Card>
  );
}
