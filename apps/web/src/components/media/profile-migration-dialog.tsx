import { useEffect, useMemo, useState } from 'react';
import type { MediaType, ProfileMigrationPreview, ProfileMigrationSelection, QualityProfile, RootFolder, Tag } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Banner, Button, Field, Input, KeyValue, Modal, Select, Skeleton, type KeyValueItem } from '../../arclight/index.js';
import { useApplyProfileMigration, useProfileMigrationPreview } from '../../hooks/profile-migration.js';
import { t } from '../../i18n/index.js';
import { formatBytes } from './format.js';
import { fitStatusLabel, mismatchActionLabel } from './profile-fit.js';
import { useToast } from '../toast.js';

export interface ProfileMigrationDialogProps {
  open: boolean;
  onClose: () => void;
  /** What to move: picked items, or everything on a profile. */
  selection: ProfileMigrationSelection;
  profiles: readonly QualityProfile[] | undefined;
  /** Show media type / root folder / tag / version filters (the profile page). */
  filters?: { rootFolders: readonly RootFolder[] | undefined; tags: readonly Tag[] | undefined } | undefined;
  /** Short description of the selection ("12 movies", "everything on HD-1080p"). */
  subject: string;
  /** Preselected target profile. */
  initialToProfileId?: number | null | undefined;
  onApplied?: (() => void) | undefined;
}

/**
 * Move items to another quality profile: pick the target, read the preview (how many files
 * already satisfy it, how many would be replaced, how many it does not allow at all, the
 * estimated download), then apply.
 */
export function ProfileMigrationDialog({ open, onClose, selection, profiles, filters, subject, initialToProfileId = null, onApplied }: ProfileMigrationDialogProps) {
  const [toProfileId, setToProfileId] = useState<number | null>(initialToProfileId);
  useEffect(() => {
    if (open) setToProfileId(initialToProfileId);
  }, [open, initialToProfileId]);
  const [mediaType, setMediaType] = useState<MediaType | ''>('');
  const [rootFolderPath, setRootFolderPath] = useState('');
  const [tagId, setTagId] = useState('');
  const [versionTag, setVersionTag] = useState('');
  const preview = useProfileMigrationPreview();
  const apply = useApplyProfileMigration();
  const toast = useToast();

  // Keyed by value: callers may pass a fresh selection object on every render.
  const selectionKey = JSON.stringify(selection);
  const fullSelection = useMemo<ProfileMigrationSelection>(
    () => ({
      ...(JSON.parse(selectionKey) as ProfileMigrationSelection),
      ...(mediaType ? { mediaType } : {}),
      ...(rootFolderPath ? { rootFolderPath } : {}),
      ...(tagId ? { tagIds: [Number(tagId)] } : {}),
      ...(versionTag.trim() ? { versionTag: versionTag.trim() } : {}),
    }),
    [selectionKey, mediaType, rootFolderPath, tagId, versionTag],
  );

  const { mutate: runPreview, reset: resetPreview } = preview;
  useEffect(() => {
    if (!open || toProfileId === null) {
      resetPreview();
      return;
    }
    runPreview({ selection: fullSelection, toProfileId });
  }, [open, toProfileId, fullSelection, runPreview, resetPreview]);

  const close = () => {
    setToProfileId(null);
    apply.reset();
    onClose();
  };

  const targets = (profiles ?? []).filter((p) => p.id !== selection.fromProfileId);
  const result = preview.data;

  return (
    <Modal
      open={open}
      onClose={close}
      size={560}
      title={t('profileMigration.dialog.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!result || result.items === 0 || preview.isPending}
            loading={apply.isPending}
            onClick={() => {
              if (toProfileId === null) return;
              apply.mutate(
                { selection: fullSelection, toProfileId },
                {
                  onSuccess: (r) => {
                    toast.push({
                      tone: 'ok',
                      title: t('profileMigration.dialog.applied', { count: r.changedSeries.length + r.changedMovies.length }),
                      message: r.preview.toProfileName,
                    });
                    onApplied?.();
                    close();
                  },
                },
              );
            }}
          >
            {result ? t('profileMigration.dialog.applyCount', { count: result.items }) : t('profileMigration.dialog.apply')}
          </Button>
        </>
      }
    >
      <div className="mk-stack-sm">
        <p className="al-caption">{t('profileMigration.dialog.subject', { subject })}</p>
        <Field label={t('profileMigration.dialog.newProfile')}>
          <Select
            value={toProfileId === null ? '' : String(toProfileId)}
            onChange={(e) => setToProfileId(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
            placeholder={t('profileMigration.dialog.chooseProfile')}
            options={targets.map((p) => ({ value: String(p.id), label: p.name }))}
          />
        </Field>
        {filters ? (
          <div className="mk-row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Field label={t('common.mediaType')}>
              <Select
                value={mediaType}
                onChange={(e) => setMediaType(e.currentTarget.value as MediaType | '')}
                options={[
                  { value: '', label: t('profileMigration.dialog.seriesAndMovies') },
                  { value: 'series', label: t('common.series') },
                  { value: 'movie', label: t('common.movies') },
                ]}
              />
            </Field>
            <Field label={t('common.rootFolder')}>
              <Select
                value={rootFolderPath}
                onChange={(e) => setRootFolderPath(e.currentTarget.value)}
                options={[{ value: '', label: t('profileMigration.dialog.anyRootFolder') }, ...(filters.rootFolders ?? []).map((r) => ({ value: r.path, label: r.path }))]}
              />
            </Field>
            <Field label={t('common.tags')}>
              <Select
                value={tagId}
                onChange={(e) => setTagId(e.currentTarget.value)}
                options={[{ value: '', label: t('profileMigration.dialog.anyTag') }, ...(filters.tags ?? []).map((tag) => ({ value: String(tag.id), label: tag.label }))]}
              />
            </Field>
            <Field label={t('profileMigration.dialog.versionSlot')} hint={t('profileMigration.dialog.versionSlotHint')}>
              <Input value={versionTag} onChange={(e) => setVersionTag(e.currentTarget.value)} placeholder="4K" />
            </Field>
          </div>
        ) : null}
        {toProfileId === null ? null : preview.isPending ? (
          <Skeleton lines={4} />
        ) : preview.isError ? (
          <Banner tone="danger">{errorMessage(preview.error)}</Banner>
        ) : result ? (
          <MigrationPreview preview={result} />
        ) : null}
        {apply.isError ? <Banner tone="danger">{errorMessage(apply.error)}</Banner> : null}
      </div>
    </Modal>
  );
}

export function MigrationPreview({ preview }: { preview: ProfileMigrationPreview }) {
  if (preview.items === 0) {
    return <Banner>{preview.unchanged > 0 ? t('profileMigration.dialog.alreadyOnProfile', { count: preview.unchanged }) : t('profileMigration.dialog.nothingSelected')}</Banner>;
  }
  const items: KeyValueItem[] = [
    { label: t('profileMigration.dialog.items'), value: t('profileMigration.dialog.itemsValue', { series: preview.series, movies: preview.movies }) },
    { label: t('profileMigration.dialog.filesMeet'), value: preview.files.meets },
    { label: t('profileMigration.dialog.filesBelowCutoff'), value: preview.files.upgradeAllowed },
    { label: t('profileMigration.dialog.filesNotAllowed'), value: preview.files.notAllowed },
    { label: t('profileMigration.dialog.withoutFiles'), value: preview.itemsWithoutFiles },
    {
      label: t('profileMigration.dialog.estimatedDownload'),
      value: preview.estimatedDownloadBytes === null ? t('profileMigration.dialog.unknownSize') : formatBytes(preview.estimatedDownloadBytes),
    },
    { label: t('profileMigration.dialog.rule'), value: mismatchActionLabel(preview.mismatchAction), mono: false },
  ];
  const worst = preview.sample.filter((s) => s.status === 'notAllowed').slice(0, 5);
  return (
    <div className="mk-stack-sm" data-testid="migration-preview">
      <KeyValue items={items} />
      {preview.needReplacing > 0 ? (
        <Banner tone={preview.mismatchAction === 'none' ? 'warn' : 'info'}>
          {preview.mismatchAction === 'none'
            ? t('profileMigration.dialog.noRuleWarning', { count: preview.needReplacing })
            : t('profileMigration.dialog.ruleInfo', { count: preview.needReplacing })}
        </Banner>
      ) : null}
      {worst.length > 0 ? (
        <p className="al-caption">
          {fitStatusLabel('notAllowed')}: {worst.map((s) => s.title).join(', ')}
          {preview.files.notAllowed > worst.length ? '…' : ''}
        </p>
      ) : null}
    </div>
  );
}
