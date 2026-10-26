import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MediaType, OverrideRule, OverrideRuleInput } from '@arclight/shared';
import { usersApi } from '../../../api/auth.js';
import { authKeys } from '../../../auth/guard.js';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, Field, FormRow, Input, Modal, Select, Skeleton, Table, Toggle, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { TagPicker } from '../../../components/forms/tag-picker.js';
import { useQualityProfiles, useRootFolders } from '../../../hooks/library.js';
import { useDeleteOverrideRule, useDiscoverGenres, useOverrideRules, useSaveOverrideRule } from '../../../hooks/requests.js';
import { EditorFooter, SaveError, SettingsSection } from '../shared.js';

/** "12, 34|56" → [12, 34, 56]; junk is dropped. */
export function parseIdList(raw: string): number[] {
  return raw
    .split(/[\s,|]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function parseLanguages(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z]{2,3}$/.test(s));
}

interface RuleDraft {
  name: string;
  mediaType: MediaType;
  is4k: 'any' | 'yes' | 'no';
  enabled: boolean;
  users: number[];
  genres: number[];
  languages: string;
  keywords: string;
  qualityProfileId: string;
  rootFolderPath: string;
  tags: number[];
  autoApprove: boolean;
}

export function toDraft(rule: OverrideRule | null): RuleDraft {
  return {
    name: rule?.name ?? '',
    mediaType: rule?.mediaType ?? 'movie',
    is4k: rule?.is4k === true ? 'yes' : rule?.is4k === false ? 'no' : 'any',
    enabled: rule?.enabled ?? true,
    users: rule?.users ?? [],
    genres: rule?.genres ?? [],
    languages: (rule?.languages ?? []).join(', '),
    keywords: (rule?.keywords ?? []).join(', '),
    qualityProfileId: rule?.qualityProfileId ? String(rule.qualityProfileId) : '',
    rootFolderPath: rule?.rootFolderPath ?? '',
    tags: rule?.tags ?? [],
    autoApprove: rule?.autoApprove ?? false,
  };
}

export function fromDraft(d: RuleDraft): OverrideRuleInput {
  return {
    name: d.name.trim(),
    mediaType: d.mediaType,
    is4k: d.is4k === 'any' ? null : d.is4k === 'yes',
    enabled: d.enabled,
    users: d.users,
    genres: d.genres,
    languages: parseLanguages(d.languages),
    keywords: parseIdList(d.keywords),
    qualityProfileId: d.qualityProfileId ? Number(d.qualityProfileId) : null,
    rootFolderPath: d.rootFolderPath || null,
    tags: d.tags,
    autoApprove: d.autoApprove,
  };
}

/** "2 users · 1 genre · ja" — what a rule matches. */
export function ruleConditions(r: OverrideRule): string {
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
  return (
    [
      r.users.length ? n(r.users.length, 'user') : null,
      r.genres.length ? n(r.genres.length, 'genre') : null,
      r.languages.length ? r.languages.join(', ') : null,
      r.keywords.length ? n(r.keywords.length, 'keyword') : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Always'
  );
}

/** "Profile, root folder, auto-approve" — what a rule changes. */
export function ruleResult(r: OverrideRule): string {
  const parts = [r.qualityProfileId ? 'profile' : null, r.rootFolderPath ? 'root folder' : null, r.tags.length ? 'tags' : null, r.autoApprove ? 'auto-approve' : null].filter(
    (p): p is string => p !== null,
  );
  if (!parts.length) return '—';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function OverrideRulesCard() {
  const rules = useOverrideRules();
  const del = useDeleteOverrideRule();
  const [editing, setEditing] = useState<OverrideRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<OverrideRule | null>(null);

  const columns: Array<Column<OverrideRule>> = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (r) => r.name,
      cell: (r) => (
        <>
          {r.name}{' '}
          {r.enabled ? null : (
            <Chip tone="muted" dot="ring">
              Disabled
            </Chip>
          )}
        </>
      ),
    },
    {
      key: 'applies',
      header: 'Applies to',
      cell: (r) => `${r.mediaType === 'movie' ? 'Movies' : 'Series'}${r.is4k === null ? '' : r.is4k ? ' (4K)' : ' (standard)'}`,
    },
    { key: 'conditions', header: 'Conditions', cell: ruleConditions, muted: true },
    { key: 'result', header: 'Result', cell: ruleResult, muted: true },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <span className="al-row-actions">
          <Button size="sm" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <SettingsSection
      label="Override rules"
      {...(rules.data ? { count: rules.data.length } : {})}
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
          Add rule
        </Button>
      }
    >
      {rules.isPending ? (
        <Skeleton lines={3} />
      ) : rules.isError ? (
        <ErrorBlock title="Could not load override rules" onRetry={() => void rules.refetch()}>
          {errorMessage(rules.error)}
        </ErrorBlock>
      ) : rules.data.length === 0 ? (
        <EmptyState title="No override rules">
          Rules route matching requests (by user, genre, language or keyword) to another profile, root folder or tags, or approve them automatically.
        </EmptyState>
      ) : (
        <Table caption="Override rules" density="dense" columns={columns} rows={rules.data} rowKey={(r) => r.id} sortable />
      )}
      {editing ? <RuleEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? 'rule'}?`}
        confirmLabel="Delete rule"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </SettingsSection>
  );
}

function RuleEditor({ rule, onClose }: { rule: OverrideRule | null; onClose: () => void }) {
  const [d, setD] = useState<RuleDraft>(() => toDraft(rule));
  const [error, setError] = useState<string | null>(null);
  const save = useSaveOverrideRule();
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list, retry: false });
  const genres = useDiscoverGenres(d.mediaType === 'movie' ? 'movie' : 'tv');
  const profiles = useQualityProfiles();
  const folders = useRootFolders();
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => setD({ ...d, [k]: v });
  const toggleIn = (k: 'users' | 'genres', id: number) => set(k, d[k].includes(id) ? d[k].filter((x) => x !== id) : [...d[k], id]);

  const submit = () => {
    if (!d.name.trim()) {
      setError('Give the rule a name.');
      return;
    }
    setError(null);
    save.mutate({ id: rule?.id ?? null, body: fromDraft(d) }, { onSuccess: onClose });
  };

  const pill = (on: boolean, label: string, onClick: () => void, key: number) => (
    <button key={key} type="button" className="al-tag al-tag-toggle" aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <Modal open size={640} onClose={onClose} title={rule ? `Edit ${rule.name}` : 'Add override rule'} footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} />}>
      <div className="al-editor-stack">
        <div className="al-field-grid">
          <Field label="Name">
            <Input value={d.name} onChange={(e) => set('name', e.currentTarget.value)} />
          </Field>
          <Field label="Media type">
            <Select
              value={d.mediaType}
              onChange={(e) => setD({ ...d, mediaType: e.currentTarget.value as MediaType, genres: [] })}
              options={[
                { value: 'movie', label: 'Movies' },
                { value: 'series', label: 'Series' },
              ]}
            />
          </Field>
          <Field label="Track">
            <Select
              value={d.is4k}
              onChange={(e) => set('is4k', e.currentTarget.value as RuleDraft['is4k'])}
              options={[
                { value: 'any', label: 'Standard and 4K' },
                { value: 'no', label: 'Standard only' },
                { value: 'yes', label: '4K only' },
              ]}
            />
          </Field>
        </div>
        <Toggle label="Enabled" checked={d.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />

        <div className="al-label">Conditions · all must match, empty = any</div>
        <FormRow label="Users">
          <div className="al-tag-toggles" role="group" aria-label="Users">
            {(users.data ?? []).map((u) => pill(d.users.includes(u.id), u.displayName ?? u.username, () => toggleIn('users', u.id), u.id))}
          </div>
        </FormRow>
        <FormRow label="Genres" caption={genres.isError ? 'Genres unavailable. Is TMDB configured?' : undefined}>
          <div className="al-tag-toggles" role="group" aria-label="Genres">
            {(genres.data ?? []).map((g) => pill(d.genres.includes(g.id), g.name, () => toggleIn('genres', g.id), g.id))}
          </div>
        </FormRow>
        <div className="al-field-grid al-field-grid--2">
          <Field label="Original languages" hint="ISO 639-1 codes, comma separated (e.g. ja, ko)">
            <Input mono value={d.languages} onChange={(e) => set('languages', e.currentTarget.value)} />
          </Field>
          <Field label="TMDB keyword ids" hint="Comma separated">
            <Input mono value={d.keywords} onChange={(e) => set('keywords', e.currentTarget.value)} />
          </Field>
        </div>

        <div className="al-label">Then</div>
        <div className="al-field-grid al-field-grid--2">
          <Field label="Quality profile">
            <Select value={d.qualityProfileId} onChange={(e) => set('qualityProfileId', e.currentTarget.value)}>
              <option value="">Leave as is</option>
              {(profiles.data ?? []).map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Root folder">
            <Select value={d.rootFolderPath} onChange={(e) => set('rootFolderPath', e.currentTarget.value)}>
              <option value="">Leave as is</option>
              {(folders.data ?? [])
                .filter((f) => f.mediaType === d.mediaType)
                .map((f) => (
                  <option key={f.id} value={f.path}>
                    {f.path}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <FormRow label="Add tags">
          <TagPicker value={d.tags} onChange={(v) => set('tags', v)} />
        </FormRow>
        <Toggle label="Approve automatically" checked={d.autoApprove} onChange={(e) => set('autoApprove', e.currentTarget.checked)} />
        {error ? (
          <p className="al-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <SaveError error={save.error} />
      </div>
    </Modal>
  );
}
