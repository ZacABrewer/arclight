import { useState } from 'react';
import type { SceneMapping, SceneMappingApplyResult, SceneMappingKind } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, EmptyState, FormRow, Input, KeyValue, Modal, Select, Table, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { QueryError } from '../../../components/media/media-kit.js';
import { useApplySceneMappings, useDeleteSceneMapping, useSaveSceneMapping, useSceneMappings } from '../../../hooks/scene-mapping.js';
import {
  KIND_FIELDS,
  SCENE_MAPPING_KINDS,
  SCENE_MAPPING_KIND_LABELS,
  draftFromMapping,
  draftToInput,
  emptyDraft,
  librarySide,
  orderMappings,
  sceneSide,
  type DraftErrors,
  type NumberField,
  type SceneMappingDraft,
} from './scene-mapping-model.js';
import '../library.css';
import './scene-mapping.css';
import { t } from '../../../i18n/index.js';

function fieldLabel(field: NumberField): string {
  switch (field) {
    case 'sceneSeason':
      return t('library.sceneMapping.sceneSeason');
    case 'sceneEpisode':
      return t('library.sceneMapping.sceneEpisode');
    case 'sceneAbsolute':
      return t('library.sceneMapping.sceneAbsolute');
    case 'tvdbSeason':
      return t('library.sceneMapping.librarySeason');
    case 'tvdbEpisode':
      return t('library.sceneMapping.libraryEpisode');
    case 'tvdbAbsolute':
      return t('library.sceneMapping.libraryAbsolute');
  }
}

function kindHelp(kind: SceneMappingKind): string {
  if (kind === 'season') return t('library.sceneMapping.kindHelpSeason');
  if (kind === 'absolute') return t('library.sceneMapping.kindHelpAbsolute');
  return t('library.sceneMapping.kindHelpTitle');
}

/** Help line for fields whose meaning depends on the kind. */
function fieldCaption(kind: SceneMappingKind, field: NumberField): string | undefined {
  if (kind === 'season' && field === 'sceneEpisode') return t('library.sceneMapping.captionSceneEpisodeAnchor');
  if (kind === 'season' && field === 'tvdbAbsolute') return t('library.sceneMapping.captionOrLibraryAbsolute');
  if (kind === 'absolute' && field === 'sceneSeason') return t('library.sceneMapping.captionAbsoluteWithinSeason');
  if (kind === 'absolute' && field === 'tvdbAbsolute') return t('library.sceneMapping.captionOrLibraryAbsolute');
  if (kind === 'title' && field === 'sceneSeason') return t('library.sceneMapping.captionTitleSceneSeason');
  if (kind === 'title' && field === 'tvdbSeason') return t('library.sceneMapping.captionTitleLibrarySeason');
  return undefined;
}

/** Add or edit one manual rule (SceneMappingInput). */
export function SceneMappingDialog({ seriesId, mapping, onClose }: { seriesId: number; mapping: SceneMapping | null; onClose: () => void }) {
  const save = useSaveSceneMapping(seriesId);
  const [draft, setDraft] = useState<SceneMappingDraft>(() => (mapping ? draftFromMapping(mapping) : emptyDraft()));
  const [errors, setErrors] = useState<DraftErrors>({});
  const set = (patch: Partial<SceneMappingDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const submit = () => {
    const result = draftToInput(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate({ mappingId: mapping?.id, body: result.value }, { onSuccess: onClose });
  };
  const id = (f: string) => `scene-map-${f}`;
  return (
    <Modal
      open
      onClose={onClose}
      title={mapping ? t('library.sceneMapping.editRule') : t('library.sceneMapping.addRule')}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="scene-mapping-form" variant="primary" loading={save.isPending}>
            {mapping ? t('common.saveChanges') : t('library.sceneMapping.addRule')}
          </Button>
        </>
      }
    >
      <form
        id="scene-mapping-form"
        className="mk-stack-sm"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormRow label={t('common.type')} htmlFor={id('kind')} caption={kindHelp(draft.kind)}>
          <Select id={id('kind')} value={draft.kind} onChange={(e) => set({ kind: e.currentTarget.value as SceneMappingKind })}>
            {SCENE_MAPPING_KINDS.map((k) => (
              <option key={k} value={k}>
                {SCENE_MAPPING_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </FormRow>
        {draft.kind === 'title' ? (
          <FormRow label={t('library.sceneMapping.sceneTitle')} htmlFor={id('sceneTitle')} error={errors.sceneTitle}>
            <Input id={id('sceneTitle')} value={draft.sceneTitle} invalid={!!errors.sceneTitle} onChange={(e) => set({ sceneTitle: e.currentTarget.value })} />
          </FormRow>
        ) : null}
        {KIND_FIELDS[draft.kind].map((field) => (
          <FormRow key={field} label={fieldLabel(field)} htmlFor={id(field)} caption={fieldCaption(draft.kind, field)} error={errors[field]}>
            <Input
              id={id(field)}
              mono
              inputMode="numeric"
              value={draft[field]}
              invalid={!!errors[field]}
              onChange={(e) => set({ [field]: e.currentTarget.value } as Partial<SceneMappingDraft>)}
            />
          </FormRow>
        ))}
        <FormRow label={t('library.sceneMapping.comment')} htmlFor={id('comment')} error={errors.comment}>
          <Input id={id('comment')} value={draft.comment} onChange={(e) => set({ comment: e.currentTarget.value })} />
        </FormRow>
        {errors.form ? (
          <p className="al-form-row__error" role="alert">
            {errors.form}
          </p>
        ) : null}
        {save.isError ? (
          <p className="al-form-row__error" role="alert">
            {errorMessage(save.error)}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/** What "Apply to existing files" did. */
export function ApplyResultView({ result }: { result: SceneMappingApplyResult }) {
  return (
    <div className="mk-stack-sm">
      <KeyValue
        layout="grid"
        columns={2}
        items={[
          { label: t('library.sceneMapping.filesChecked'), value: String(result.checked) },
          { label: t('library.sceneMapping.filesRemapped'), value: String(result.remapped.length) },
          { label: t('library.sceneMapping.filesUnchanged'), value: String(result.unchanged) },
          { label: t('library.sceneMapping.filesSkipped'), value: String(result.skipped.length) },
          ...(result.rescan
            ? [{ label: t('library.sceneMapping.rescan'), value: t('library.sceneMapping.rescanSummary', { scanned: result.rescan.scanned, added: result.rescan.added, unmapped: result.rescan.unmapped }) }]
            : []),
        ]}
      />
      {result.remapped.length > 0 ? (
        <section aria-label={t('library.sceneMapping.filesRemapped')}>
          <div className="al-label">{t('library.sceneMapping.filesRemapped')}</div>
          <ul className="scm-files">
            {result.remapped.map((r) => (
              <li key={r.mediaFileId}>
                <span className="scm-path">{r.path}</span>
                <span className="mk-muted">{t('library.sceneMapping.episodeIdsChange', { from: r.fromEpisodeIds.join(', ') || '—', to: r.toEpisodeIds.join(', ') || '—' })}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result.skipped.length > 0 ? (
        <section aria-label={t('library.sceneMapping.filesSkipped')}>
          <div className="al-label">{t('library.sceneMapping.filesSkipped')}</div>
          <ul className="scm-files">
            {result.skipped.map((s) => (
              <li key={s.mediaFileId}>
                <span className="scm-path">{s.path}</span>
                <span className="mk-muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Series details "Scene mapping" tab: the rules (feed rows read-only), add/edit/delete, apply to files. */
export function SceneMappingPanel({ seriesId }: { seriesId: number }) {
  const mappings = useSceneMappings(seriesId);
  const del = useDeleteSceneMapping(seriesId);
  const apply = useApplySceneMappings(seriesId);
  const [editing, setEditing] = useState<SceneMapping | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SceneMapping | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [result, setResult] = useState<SceneMappingApplyResult | null>(null);

  const columns: Column<SceneMapping>[] = [
    { key: 'kind', header: t('common.type'), width: '120px', cell: (m) => SCENE_MAPPING_KIND_LABELS[m.kind] },
    { key: 'scene', header: t('library.sceneMapping.releaseNames'), mono: true, cell: (m) => sceneSide(m) },
    { key: 'library', header: t('common.library'), mono: true, cell: (m) => librarySide(m) },
    { key: 'comment', header: t('library.sceneMapping.comment'), muted: true, cell: (m) => m.comment || '—' },
    {
      key: 'source',
      header: t('common.source'),
      width: '100px',
      cell: (m) =>
        m.source === 'feed' ? (
          <Chip tone="neutral" dot="ring">
            {t('common.feed')}
          </Chip>
        ) : (
          <Chip tone="default">{t('library.sceneMapping.manual')}</Chip>
        ),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (m) =>
        m.source === 'feed' ? (
          <span className="mk-muted">{t('library.sceneMapping.readOnly')}</span>
        ) : (
          <span className="scm-actions">
            <Button size="sm" variant="ghost" aria-label={t('library.sceneMapping.editRuleLabel', { rule: sceneSide(m) })} onClick={() => setEditing(m)}>
              {t('common.edit')}
            </Button>
            <Button size="sm" variant="ghost" aria-label={t('library.sceneMapping.deleteRuleLabel', { rule: sceneSide(m) })} onClick={() => setDeleting(m)}>
              {t('common.delete')}
            </Button>
          </span>
        ),
    },
  ];

  if (mappings.isError) return <QueryError error={mappings.error} title={t('library.sceneMapping.couldNotLoadRules')} onRetry={() => void mappings.refetch()} />;
  return (
    <div className="mk-stack-sm">
      <div className="scm-toolbar">
        <p className="mk-muted scm-intro">{t('library.sceneMapping.intro')}</p>
        <Button onClick={() => setConfirmApply(true)} loading={apply.isPending}>
          {t('library.sceneMapping.applyToExistingFiles')}
        </Button>
        <Button variant="primary" onClick={() => setEditing('new')}>
          {t('library.sceneMapping.addRule')}
        </Button>
      </div>
      <Table
        caption={t('library.sceneMapping.rules')}
        columns={columns}
        rows={mappings.data ? orderMappings(mappings.data) : undefined}
        rowKey={(m) => m.id}
        loading={mappings.isPending}
        sortable={false}
        empty={<EmptyState title={t('library.sceneMapping.noRulesYet')}>{t('library.sceneMapping.noRulesHint')}</EmptyState>}
      />
      {editing !== null ? <SceneMappingDialog seriesId={seriesId} mapping={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t('library.sceneMapping.deleteRuleTitle', { rule: deleting ? sceneSide(deleting) : '' })}
        confirmLabel={t('library.sceneMapping.deleteRule')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
      <ConfirmDialog
        open={confirmApply}
        danger={false}
        title={t('library.sceneMapping.applyTitle')}
        confirmLabel={t('library.sceneMapping.applyToFiles')}
        onCancel={() => setConfirmApply(false)}
        onConfirm={async () => {
          const res = await apply.mutateAsync(undefined);
          setConfirmApply(false);
          setResult(res);
        }}
      >
        <p>{t('library.sceneMapping.applyBody')}</p>
      </ConfirmDialog>
      <Modal
        open={result !== null}
        onClose={() => setResult(null)}
        title={t('library.sceneMapping.applyResultTitle')}
        size={640}
        footer={<Button onClick={() => setResult(null)}>{t('common.close')}</Button>}
      >
        {result ? <ApplyResultView result={result} /> : null}
      </Modal>
    </div>
  );
}
