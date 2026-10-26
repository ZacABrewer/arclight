import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MediaType, OverrideRule, OverrideRuleInput } from '@arclight/shared';
import { usersApi } from '../../../api/auth.js';
import { authKeys } from '../../../auth/guard.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { EmptyState } from '../../../components/empty-state.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../../components/form.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { TagPicker } from '../../../components/forms/tag-picker.js';
import { Modal } from '../../../components/modal.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useQualityProfiles, useRootFolders } from '../../../hooks/library.js';
import { useDeleteOverrideRule, useDiscoverGenres, useOverrideRules, useSaveOverrideRule } from '../../../hooks/requests.js';
import { EditorFooter, SaveError } from '../shared.js';

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

export function OverrideRulesCard() {
  const rules = useOverrideRules();
  const del = useDeleteOverrideRule();
  const [editing, setEditing] = useState<OverrideRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<OverrideRule | null>(null);

  return (
    <Card title="Override rules" flush actions={<Button onClick={() => setEditing('new')}>Add rule</Button>}>
      {rules.isPending ? (
        <LoadingBlock />
      ) : rules.isError ? (
        <ErrorView error={rules.error} onRetry={() => void rules.refetch()} />
      ) : rules.data.length === 0 ? (
        <EmptyState title="No override rules">
          <p className="muted">Rules route matching requests (by user, genre, language or keyword) to another profile, root folder or tags, or approve them automatically.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Applies to</th>
                <th>Conditions</th>
                <th>Result</th>
                <th className="align-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name} {r.enabled ? null : <Badge>disabled</Badge>}
                  </td>
                  <td>
                    {r.mediaType === 'movie' ? 'Movies' : 'Series'}
                    {r.is4k === null ? '' : r.is4k ? ' (4K)' : ' (standard)'}
                  </td>
                  <td className="muted small">
                    {[
                      r.users.length ? `${r.users.length} user(s)` : null,
                      r.genres.length ? `${r.genres.length} genre(s)` : null,
                      r.languages.length ? r.languages.join(', ') : null,
                      r.keywords.length ? `${r.keywords.length} keyword(s)` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Always'}
                  </td>
                  <td className="muted small">
                    {[r.qualityProfileId ? 'profile' : null, r.rootFolderPath ? 'root folder' : null, r.tags.length ? 'tags' : null, r.autoApprove ? 'auto-approve' : null]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </td>
                  <td className="align-right">
                    <div className="row row-end">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <RuleEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? 'rule'}?`}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </Card>
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

  return (
    <Modal open size="lg" onClose={onClose} title={rule ? `Edit ${rule.name}` : 'Add override rule'} footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} />}>
      <div className="stack-sm">
        <div className="fields-row">
          <FormField label="Name">
            <Input value={d.name} onChange={(e) => set('name', e.currentTarget.value)} />
          </FormField>
          <FormField label="Media type">
            <Select
              value={d.mediaType}
              onChange={(e) => setD({ ...d, mediaType: e.currentTarget.value as MediaType, genres: [] })}
              options={[
                { value: 'movie', label: 'Movies' },
                { value: 'series', label: 'Series' },
              ]}
            />
          </FormField>
          <FormField label="Track">
            <Select
              value={d.is4k}
              onChange={(e) => set('is4k', e.currentTarget.value as RuleDraft['is4k'])}
              options={[
                { value: 'any', label: 'Standard and 4K' },
                { value: 'no', label: 'Standard only' },
                { value: 'yes', label: '4K only' },
              ]}
            />
          </FormField>
        </div>
        <FormField label="Enabled" inline>
          <Toggle checked={d.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
        </FormField>

        <h3 className="section-title">Conditions (all must match; empty = any)</h3>
        <FormField label="Users">
          <div className="chip-group" role="group" aria-label="Users">
            {(users.data ?? []).map((u) => (
              <button key={u.id} type="button" className={`chip ${d.users.includes(u.id) ? 'chip-on' : ''}`} aria-pressed={d.users.includes(u.id)} onClick={() => toggleIn('users', u.id)}>
                {u.displayName ?? u.username}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label="Genres">
          <div className="chip-group" role="group" aria-label="Genres">
            {(genres.data ?? []).map((g) => (
              <button key={g.id} type="button" className={`chip ${d.genres.includes(g.id) ? 'chip-on' : ''}`} aria-pressed={d.genres.includes(g.id)} onClick={() => toggleIn('genres', g.id)}>
                {g.name}
              </button>
            ))}
            {genres.isError ? <span className="muted">Genres unavailable (TMDB not configured?)</span> : null}
          </div>
        </FormField>
        <div className="fields-row">
          <FormField label="Original languages" hint="ISO 639-1 codes, comma separated (e.g. ja, ko)">
            <Input value={d.languages} onChange={(e) => set('languages', e.currentTarget.value)} />
          </FormField>
          <FormField label="TMDB keyword ids" hint="Comma separated">
            <Input value={d.keywords} onChange={(e) => set('keywords', e.currentTarget.value)} />
          </FormField>
        </div>

        <h3 className="section-title">Then</h3>
        <div className="fields-row">
          <FormField label="Quality profile">
            <Select value={d.qualityProfileId} onChange={(e) => set('qualityProfileId', e.currentTarget.value)}>
              <option value="">Leave as is</option>
              {(profiles.data ?? []).map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Root folder">
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
          </FormField>
        </div>
        <FormField label="Add tags">
          <TagPicker value={d.tags} onChange={(v) => set('tags', v)} />
        </FormField>
        <FormField label="Approve automatically" inline>
          <Toggle checked={d.autoApprove} onChange={(e) => set('autoApprove', e.currentTarget.checked)} />
        </FormField>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <SaveError error={save.error} />
      </div>
    </Modal>
  );
}
