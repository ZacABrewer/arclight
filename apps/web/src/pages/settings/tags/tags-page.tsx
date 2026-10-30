import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Tag as TagModel, TagRule, TagRuleRunResult, TagUsage } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Banner, Button, Checkbox, Chip, EmptyState, ErrorBlock, Field, Input, Modal, Pane, Select, Table, Toggle, type Column, type RowKey } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { useToast } from '../../../components/toast.js';
import { useTags } from '../../../hooks/library.js';
import {
  useBulkDeleteTags,
  useDeleteTag,
  useDeleteTagRule,
  useMergeTag,
  useOrderTagRules,
  useRenameTag,
  useRunTagRules,
  useTagRuleOptions,
  useTagRules,
  useTagUsage,
  useToggleTagRule,
} from '../../../hooks/tag-rules.js';
import { SettingsPage } from '../settings-layout.js';
import { TagRuleEditor } from './rule-editor.js';
import { RunSummary } from './run-summary.js';
import { conditionSummary, entityLabel, moveId, ruleToInput, showItemsLinks, usageKindLabel, usageLines } from './tags-model.js';
import './tags.css';
import { t } from '../../../i18n/index.js';

// Settings → Tags (/settings/tags): the tag list with usage, rename / merge / delete, and the
// tag rules that add tags automatically. One page, two stacked sections (no second tab bar).

function UsageCell({ u }: { u: TagUsage }) {
  const lines = usageLines(u);
  if (lines.length === 0) return <span className="al-caption">{t('settings.tags.unused')}</span>;
  return (
    <span className="tg-usage">
      {lines.map((l) => (
        <span key={l.kind} className="tg-usage__item" data-behaviour={l.behaviour || undefined}>
          <span className="al-num">{l.count}</span> {usageKindLabel(l.kind)}
        </span>
      ))}
    </span>
  );
}

function RenameModal({ tag, onClose }: { tag: TagUsage | null; onClose: () => void }) {
  const id = useId();
  const rename = useRenameTag();
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (tag) {
      setLabel(tag.label);
      rename.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag]);
  return (
    <Modal
      open={tag !== null}
      onClose={onClose}
      size={440}
      title={t('settings.tags.renameTitle', { label: tag?.label ?? '' })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={rename.isPending}
            disabled={label.trim() === ''}
            onClick={() => tag && rename.mutate({ id: tag.id, label: label.trim() }, { onSuccess: onClose })}
          >
            {t('settings.tags.rename')}
          </Button>
        </>
      }
    >
      <Field label={t('settings.tags.label')} htmlFor={id} hint={t('settings.tags.renameHint')}>
        <Input id={id} mono value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
      </Field>
      {rename.isError ? <ErrorBlock title={t('settings.tags.couldNotRename')}>{errorMessage(rename.error)}</ErrorBlock> : null}
    </Modal>
  );
}

function MergeModal({ tag, all, onClose }: { tag: TagUsage | null; all: readonly TagModel[]; onClose: () => void }) {
  const id = useId();
  const merge = useMergeTag();
  const [into, setInto] = useState('');
  const others = all.filter((x) => x.id !== tag?.id);
  return (
    <Modal
      open={tag !== null}
      onClose={() => {
        setInto('');
        merge.reset();
        onClose();
      }}
      size={440}
      title={t('settings.tags.mergeTitle', { label: tag?.label ?? '' })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={merge.isPending}
            disabled={into === ''}
            onClick={() =>
              tag &&
              merge.mutate(
                { id: tag.id, intoId: Number(into) },
                {
                  onSuccess: () => {
                    setInto('');
                    onClose();
                  },
                },
              )
            }
          >
            {t('settings.tags.merge')}
          </Button>
        </>
      }
    >
      <p>{t('settings.tags.mergeBody', { label: tag?.label ?? '' })}</p>
      <Field label={t('settings.tags.mergeInto')} htmlFor={id}>
        <Select
          id={id}
          value={into}
          onChange={(e) => setInto(e.currentTarget.value)}
          options={[{ value: '', label: t('settings.tags.pickTag') }, ...others.map((x) => ({ value: String(x.id), label: x.label }))]}
        />
      </Field>
      {merge.isError ? <ErrorBlock title={t('settings.tags.couldNotMerge')}>{errorMessage(merge.error)}</ErrorBlock> : null}
    </Modal>
  );
}

function TagsSection() {
  const usage = useTagUsage();
  const tags = useTags();
  const del = useDeleteTag();
  const bulk = useBulkDeleteTags();
  const toast = useToast();
  const [renaming, setRenaming] = useState<TagUsage | null>(null);
  const [merging, setMerging] = useState<TagUsage | null>(null);
  const [deleting, setDeleting] = useState<TagUsage | null>(null);
  const [deletingUnused, setDeletingUnused] = useState(false);
  const unused = (usage.data ?? []).filter((u) => u.total === 0);

  const columns: Column<TagUsage>[] = [
    {
      key: 'label',
      header: t('settings.tags.label'),
      sortValue: (u) => u.label,
      cell: (u) => (
        <span className="tg-label">
          <span className="al-tag">{u.label}</span>
          {u.behaviourUses > 0 ? (
            <Chip tone="warn" dot="none">
              {t('settings.tags.drivesBehaviour')}
            </Chip>
          ) : null}
        </span>
      ),
    },
    { key: 'usage', header: t('settings.tags.usedBy'), sortValue: (u) => u.total, cell: (u) => <UsageCell u={u} /> },
    {
      key: 'rules',
      header: t('settings.tags.createdBy'),
      cell: (u) =>
        u.rules.length ? (
          <span className="tg-usage">
            {u.rules.map((r) => (
              <span key={r.id}>{r.name}</span>
            ))}
            {u.autoApplied > 0 ? <span className="al-caption">{t('settings.tags.autoApplied', { count: u.autoApplied })}</span> : null}
          </span>
        ) : (
          <span className="al-caption">{t('settings.tags.byHand')}</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (u) => (
        <div className="tg-actions">
          {showItemsLinks(u).map((l) => (
            <Link key={l.to} to={l.to} search={{ tag: u.id } as never} className="mk-action-link">
              {l.label}
            </Link>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setRenaming(u)} aria-label={t('settings.tags.renameLabel', { label: u.label })}>
            {t('settings.tags.rename')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setMerging(u)} aria-label={t('settings.tags.mergeLabel', { label: u.label })}>
            {t('settings.tags.merge')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(u)} aria-label={t('settings.tags.deleteLabel', { label: u.label })}>
            {t('common.delete')}
          </Button>
        </div>
      ),
    },
  ];

  const deletingLines = deleting ? usageLines(deleting) : [];
  return (
    <>
      <div className="tg-toolbar">
        <p className="al-caption">{t('settings.tags.tagsIntro')}</p>
        <Button variant="secondary" size="sm" disabled={unused.length === 0} onClick={() => setDeletingUnused(true)}>
          {t('settings.tags.deleteUnused', { count: unused.length })}
        </Button>
      </div>
      {usage.isError ? (
        <ErrorBlock title={t('settings.tags.couldNotLoadTags')} onRetry={() => void usage.refetch()} />
      ) : (
        <div className="tg-scroll">
          <Table
            caption={t('common.tags')}
            columns={columns}
            rows={usage.data}
            rowKey={(u) => u.id}
            loading={usage.isPending}
            density="dense"
            selectable
            rowLabel={(u) => u.label}
            bulkPosition="inline"
            bulkActions={(keys: Set<RowKey>, clear) => (
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  bulk.mutate(
                    { ids: [...keys].map(Number), force: false },
                    {
                      onSuccess: (r) => {
                        toast.push({ tone: 'ok', title: t('settings.tags.deletedTags', { count: r.deleted }) });
                        clear();
                      },
                      onError: (err) => toast.error(t('settings.tags.couldNotDelete'), errorMessage(err)),
                    },
                  )
                }
              >
                {t('settings.tags.deleteSelected')}
              </Button>
            )}
            empty={<EmptyState title={t('settings.tags.noTags')}>{t('settings.tags.noTagsBody')}</EmptyState>}
          />
        </div>
      )}
      <RenameModal tag={renaming} onClose={() => setRenaming(null)} />
      <MergeModal tag={merging} all={tags.data ?? []} onClose={() => setMerging(null)} />
      <ConfirmDialog
        open={deleting !== null}
        title={t('settings.tags.deleteTitle', { label: deleting?.label ?? '' })}
        confirmLabel={t('settings.tags.deleteTag')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      >
        {deletingLines.length ? (
          <div className="tg-warning" role="note">
            <p>{t('settings.tags.inUseWarning')}</p>
            <ul aria-label={t('settings.tags.usedBy')}>
              {deletingLines.map((l) => (
                <li key={l.kind}>
                  {l.count} × {usageKindLabel(l.kind)}
                  {l.behaviour ? ` (${t('settings.tags.drivesBehaviour')})` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>{t('settings.tags.notInUse')}</p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={deletingUnused}
        title={t('settings.tags.deleteUnusedTitle', { count: unused.length })}
        confirmLabel={t('settings.tags.deleteUnusedConfirm')}
        onCancel={() => setDeletingUnused(false)}
        onConfirm={async () => {
          const r = await bulk.mutateAsync({ ids: unused.map((u) => u.id), force: false });
          toast.push({ tone: 'ok', title: t('settings.tags.deletedTags', { count: r.deleted }) });
          setDeletingUnused(false);
        }}
      >
        <p>{unused.map((u) => u.label).join(', ')}</p>
      </ConfirmDialog>
    </>
  );
}

/** Dry-run first, then confirm: "would add genre:horror to 212 items". */
function RunConfirm({ target, onClose }: { target: { ruleIds?: number[]; title: string } | null; onClose: () => void }) {
  const run = useRunTagRules();
  const toast = useToast();
  const [result, setResult] = useState<TagRuleRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setResult(null);
    setError(null);
    if (target) {
      run.mutate(
        { ...(target.ruleIds ? { ruleIds: target.ruleIds } : {}), dryRun: true },
        { onSuccess: setResult, onError: (err) => setError(errorMessage(err)) },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const apply = () => {
    if (!target) return;
    run.mutate(
      { ...(target.ruleIds ? { ruleIds: target.ruleIds } : {}), dryRun: false },
      {
        onSuccess: (r) => {
          toast.push({ tone: 'ok', title: t('settings.tags.runDone', { count: r.itemsChanged }) });
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      size={640}
      title={target?.title ?? ''}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={run.isPending} disabled={result === null || result.itemsChanged === 0} onClick={apply}>
            {t('settings.tags.applyChanges')}
          </Button>
        </>
      }
    >
      <p className="al-caption">{t('settings.tags.dryRunNote')}</p>
      {error ? <ErrorBlock title={t('settings.tags.couldNotRun')}>{error}</ErrorBlock> : null}
      {result ? <RunSummary result={result} /> : !error ? <p className="al-caption">{t('settings.tags.editor.previewLoading')}</p> : null}
    </Modal>
  );
}

function RulesSection({ onEdit }: { onEdit: (rule: TagRule | null) => void }) {
  const rules = useTagRules();
  const tags = useTags();
  const options = useTagRuleOptions();
  const order = useOrderTagRules();
  const toggle = useToggleTagRule();
  const del = useDeleteTagRule();
  const [deleting, setDeleting] = useState<TagRule | null>(null);
  const [removeTags, setRemoveTags] = useState(true);
  const [running, setRunning] = useState<{ ruleIds?: number[]; title: string } | null>(null);
  const list = rules.data ?? [];
  const ids = list.map((r) => r.id);
  const names = useMemo(
    () => ({
      users: new Map((options.data?.users ?? []).map((u) => [u.id, u.name])),
      profiles: new Map((options.data?.qualityProfiles ?? []).map((p) => [p.id, p.name])),
    }),
    [options.data],
  );

  return (
    <Pane
      title={t('settings.tags.rules')}
      aria-label={t('settings.tags.rules')}
      actions={
        <div className="tg-actions">
          <Button size="sm" variant="secondary" disabled={!list.some((r) => r.enabled)} onClick={() => setRunning({ title: t('settings.tags.runAllTitle') })}>
            {t('settings.tags.runAll')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => onEdit(null)}>
            {t('common.addRule')}
          </Button>
        </div>
      }
    >
      <p className="al-caption">{t('settings.tags.orderNote')}</p>
      <Banner tone="warn">{t('settings.tags.behaviourNote')}</Banner>
      {rules.isError ? (
        <ErrorBlock title={t('settings.tags.couldNotLoadRules')} onRetry={() => void rules.refetch()} />
      ) : list.length === 0 && !rules.isPending ? (
        <EmptyState title={t('settings.tags.noRules')} action={<Button variant="primary" onClick={() => onEdit(null)}>{t('common.addRule')}</Button>}>
          {t('settings.tags.noRulesBody')}
        </EmptyState>
      ) : (
        <ol className="tg-rules" aria-label={t('settings.tags.rulesList')}>
          {list.map((r, i) => (
            <li key={r.id} className="tg-rule" aria-label={r.name}>
              <div className="tg-rule__order">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={i === 0 || order.isPending}
                  aria-label={t('settings.tags.moveUp', { name: r.name })}
                  onClick={() => {
                    const next = moveId(ids, i, -1);
                    if (next) order.mutate(next);
                  }}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={i === list.length - 1 || order.isPending}
                  aria-label={t('settings.tags.moveDown', { name: r.name })}
                  onClick={() => {
                    const next = moveId(ids, i, 1);
                    if (next) order.mutate(next);
                  }}
                >
                  ↓
                </Button>
              </div>
              <div className="tg-rule__body">
                <div className="tg-rule__title">
                  <span className="tg-strong">{r.name}</span>
                  <span className="al-caption">{r.appliesTo.map(entityLabel).join(', ')}</span>
                  {r.starterKey ? (
                    <Chip tone="muted" dot="none">
                      {t('settings.tags.starter')}
                    </Chip>
                  ) : null}
                </div>
                <div className="tg-chips">
                  {r.conditions.length === 0 ? <span className="al-caption">{t('settings.tags.everyItem')}</span> : null}
                  {r.conditions.map((c, j) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <Chip key={j} tone="neutral" dot="none">
                      {conditionSummary(c, tags.data, names)}
                    </Chip>
                  ))}
                  {r.conditions.length > 1 ? <span className="al-caption">{r.match === 'all' ? t('settings.tags.editor.matchAll') : t('settings.tags.editor.matchAny')}</span> : null}
                </div>
                <div className="tg-chips">
                  {r.addTags.map((a) => (
                    <span key={a} className="al-tag">
                      +{a}
                    </span>
                  ))}
                  {r.removeTagIds.map((id) => (
                    <span key={id} className="al-tag">
                      −{tags.data?.find((x) => x.id === id)?.label ?? `#${id}`}
                    </span>
                  ))}
                </div>
                <div className="al-caption">
                  {t('settings.tags.appliedCount', { count: r.appliedCount })}
                  {r.lastRun ? ` · ${t('settings.tags.lastRun', { added: r.lastRun.tagsAdded, removed: r.lastRun.tagsRemoved })}` : ''}
                </div>
              </div>
              <div className="tg-rule__side">
                <Toggle
                  label={t('common.enabled')}
                  checked={r.enabled}
                  aria-label={t('settings.tags.enableRule', { name: r.name })}
                  onChange={(e) => toggle.mutate({ id: r.id, body: { ...ruleToInput(r), enabled: e.currentTarget.checked } })}
                />
                <div className="tg-actions">
                  <Button size="sm" variant="secondary" onClick={() => setRunning({ ruleIds: [r.id], title: t('settings.tags.runRuleTitle', { name: r.name }) })} aria-label={t('settings.tags.runRule', { name: r.name })}>
                    {t('settings.tags.runNow')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => onEdit(r)} aria-label={t('settings.tags.editRule', { name: r.name })}>
                    {t('common.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setRemoveTags(true);
                      setDeleting(r);
                    }}
                    aria-label={t('settings.tags.deleteRule', { name: r.name })}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      <RunConfirm target={running} onClose={() => setRunning(null)} />
      <ConfirmDialog
        open={deleting !== null}
        title={t('settings.tags.deleteRuleTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('settings.tags.deleteRuleConfirm')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync({ id: deleting.id, removeTags });
          setDeleting(null);
        }}
      >
        <Checkbox
          label={t('settings.tags.alsoRemoveTags', { count: deleting?.appliedCount ?? 0 })}
          checked={removeTags}
          onChange={(e) => setRemoveTags(e.currentTarget.checked)}
        />
      </ConfirmDialog>
    </Pane>
  );
}

/** Settings → Tags (admin). */
export function TagsSettingsPage() {
  const [editing, setEditing] = useState<{ rule: TagRule | null } | null>(null);
  return (
    <SettingsPage title={t('common.tags')} description={t('settings.tags.description')} after={<RulesSection onEdit={(rule) => setEditing({ rule })} />}>
      <TagsSection />
      <TagRuleEditor open={editing !== null} rule={editing?.rule ?? null} onClose={() => setEditing(null)} />
    </SettingsPage>
  );
}
