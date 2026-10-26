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
import { t } from '../../../i18n/index.js';

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
  return (
    [
      r.users.length ? t('settings.requests.overrideRulesCard.users', { count: r.users.length }) : null,
      r.genres.length ? t('settings.requests.overrideRulesCard.genres', { count: r.genres.length }) : null,
      r.languages.length ? r.languages.join(', ') : null,
      r.keywords.length ? t('settings.requests.overrideRulesCard.keywords', { count: r.keywords.length }) : null,
    ]
      .filter(Boolean)
      .join(' · ') || t('settings.requests.overrideRulesCard.always')
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
      header: t('common.name'),
      sortValue: (r) => r.name,
      cell: (r) => (
        <>
          {r.name}{' '}
          {r.enabled ? null : (
            <Chip tone="muted" dot="ring">
              {t('common.disabled')}
            </Chip>
          )}
        </>
      ),
    },
    {
      key: 'applies',
      header: t('settings.requests.overrideRulesCard.appliesTo'),
      cell: (r) => t('settings.requests.overrideRulesCard.mediaTarget', { type: r.mediaType, quality: r.is4k === null ? 'any' : r.is4k ? 'uhd' : 'standard' }),
    },
    { key: 'conditions', header: t('common.conditions'), cell: ruleConditions, muted: true },
    { key: 'result', header: t('settings.requests.overrideRulesCard.result'), cell: ruleResult, muted: true },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (r) => (
        <span className="al-row-actions">
          <Button size="sm" variant="ghost" onClick={() => setEditing(r)} aria-label={t('settings.requests.overrideRulesCard.editName', { name: r.name })}>
            {t('common.edit')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(r)} aria-label={t('settings.requests.overrideRulesCard.deleteName', { name: r.name })}>
            {t('common.delete')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <SettingsSection
      label={t('settings.requests.overrideRulesCard.overrideRules')}
      {...(rules.data ? { count: rules.data.length } : {})}
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
          {t('common.addRule')}
        </Button>
      }
    >
      {rules.isPending ? (
        <Skeleton lines={3} />
      ) : rules.isError ? (
        <ErrorBlock title={t('settings.requests.overrideRulesCard.couldNotLoadOverrideRules')} onRetry={() => void rules.refetch()}>
          {errorMessage(rules.error)}
        </ErrorBlock>
      ) : rules.data.length === 0 ? (
        <EmptyState title={t('settings.requests.overrideRulesCard.noOverrideRules')}>
          {t('settings.requests.overrideRulesCard.rulesRouteMatchingRequestsBy')}
        </EmptyState>
      ) : (
        <Table caption={t('settings.requests.overrideRulesCard.overrideRules')} density="dense" columns={columns} rows={rules.data} rowKey={(r) => r.id} sortable />
      )}
      {editing ? <RuleEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t('settings.requests.overrideRulesCard.deleteValue', { value: deleting?.name ?? 'rule' })}
        confirmLabel={t('settings.requests.overrideRulesCard.deleteRule')}
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
      setError(t('settings.requests.overrideRulesCard.giveTheRuleAName'));
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
    <Modal open size={640} onClose={onClose} title={rule ? t('settings.requests.overrideRulesCard.editName', { name: rule.name }) : t('settings.requests.overrideRulesCard.addOverrideRule')} footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} />}>
      <div className="al-editor-stack">
        <div className="al-field-grid">
          <Field label={t('common.name')}>
            <Input value={d.name} onChange={(e) => set('name', e.currentTarget.value)} />
          </Field>
          <Field label={t('common.mediaType')}>
            <Select
              value={d.mediaType}
              onChange={(e) => setD({ ...d, mediaType: e.currentTarget.value as MediaType, genres: [] })}
              options={[
                { value: 'movie', label: t('common.movies') },
                { value: 'series', label: t('common.series') },
              ]}
            />
          </Field>
          <Field label={t('common.track')}>
            <Select
              value={d.is4k}
              onChange={(e) => set('is4k', e.currentTarget.value as RuleDraft['is4k'])}
              options={[
                { value: 'any', label: t('settings.requests.overrideRulesCard.standardAnd4k') },
                { value: 'no', label: t('settings.requests.overrideRulesCard.standardOnly') },
                { value: 'yes', label: t('settings.requests.overrideRulesCard.n4kOnly') },
              ]}
            />
          </Field>
        </div>
        <Toggle label={t('common.enabled')} checked={d.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />

        <div className="al-label">{t('settings.requests.overrideRulesCard.conditionsAllMustMatchEmpty')}</div>
        <FormRow label={t('common.users')}>
          <div className="al-tag-toggles" role="group" aria-label={t('common.users')}>
            {(users.data ?? []).map((u) => pill(d.users.includes(u.id), u.displayName ?? u.username, () => toggleIn('users', u.id), u.id))}
          </div>
        </FormRow>
        <FormRow label={t('settings.requests.overrideRulesCard.genres')} caption={genres.isError ? t('settings.requests.overrideRulesCard.genresUnavailableIsTmdbConfigured') : undefined}>
          <div className="al-tag-toggles" role="group" aria-label={t('settings.requests.overrideRulesCard.genres')}>
            {(genres.data ?? []).map((g) => pill(d.genres.includes(g.id), g.name, () => toggleIn('genres', g.id), g.id))}
          </div>
        </FormRow>
        <div className="al-field-grid al-field-grid--2">
          <Field label={t('settings.requests.overrideRulesCard.originalLanguages')} hint={t('settings.requests.overrideRulesCard.iso6391CodesComma')}>
            <Input mono value={d.languages} onChange={(e) => set('languages', e.currentTarget.value)} />
          </Field>
          <Field label={t('settings.requests.overrideRulesCard.tmdbKeywordIds')} hint={t('settings.requests.overrideRulesCard.commaSeparated')}>
            <Input mono value={d.keywords} onChange={(e) => set('keywords', e.currentTarget.value)} />
          </Field>
        </div>

        <div className="al-label">{t('settings.requests.overrideRulesCard.then')}</div>
        <div className="al-field-grid al-field-grid--2">
          <Field label={t('common.qualityProfile')}>
            <Select value={d.qualityProfileId} onChange={(e) => set('qualityProfileId', e.currentTarget.value)}>
              <option value="">{t('settings.requests.overrideRulesCard.leaveAsIs')}</option>
              {(profiles.data ?? []).map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('common.rootFolder')}>
            <Select value={d.rootFolderPath} onChange={(e) => set('rootFolderPath', e.currentTarget.value)}>
              <option value="">{t('settings.requests.overrideRulesCard.leaveAsIs')}</option>
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
        <FormRow label={t('settings.requests.overrideRulesCard.addTags')}>
          <TagPicker value={d.tags} onChange={(v) => set('tags', v)} />
        </FormRow>
        <Toggle label={t('settings.requests.overrideRulesCard.approveAutomatically')} checked={d.autoApprove} onChange={(e) => set('autoApprove', e.currentTarget.checked)} />
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
