import { useMemo, useState } from 'react';
import type { MediaFileVersion, MediaVersion, QualityProfile } from '@arclight/shared';
import { Button, FormRow, Input, Select, Tag, Toggle, type Column } from '../../../arclight/index.js';
import { formatBytes } from '../../../components/media/format.js';
import { qualityName } from '../../../components/media/media-kit.js';
import { useT } from '../../../i18n/index.js';
import {
  MAX_VERSIONS,
  hasVersionTags,
  newVersionDraft,
  toVersionDrafts,
  validateVersions,
  versionsPatch,
  type VersionDraft,
  type VersionErrors,
} from './versions-model.js';
import './versions.css';

// Multi-version library UI pieces, imported by the details pages, wanted lists, interactive
// search and manual import.

export interface VersionsDraftState {
  drafts: VersionDraft[];
  setDrafts: (next: VersionDraft[]) => void;
  errors: VersionErrors;
  valid: boolean;
  /** Spread into the update body: `{}` when unchanged. */
  patch: ReturnType<typeof versionsPatch>;
  /** True when the item had versions and the user removed them all. */
  clearing: boolean;
}

export function useVersionsDraft(original: readonly MediaVersion[] | null | undefined): VersionsDraftState {
  const [drafts, setDrafts] = useState(() => toVersionDrafts(original));
  const errors = useMemo(() => validateVersions(drafts), [drafts]);
  return {
    drafts,
    setDrafts,
    errors,
    valid: errors.size === 0,
    patch: versionsPatch(original, drafts),
    clearing: (original?.length ?? 0) > 0 && drafts.length === 0,
  };
}

/** Versions editor for the series/movie edit dialogs: tag, quality profile, enabled; add/remove. */
export function VersionsEditor({
  state,
  profiles,
  defaultProfileId,
  idPrefix,
}: {
  state: VersionsDraftState;
  profiles: readonly Pick<QualityProfile, 'id' | 'name'>[];
  /** Profile a new row starts with (usually the item's own profile). */
  defaultProfileId: number | null;
  idPrefix: string;
}) {
  const t = useT();
  const { drafts, setDrafts, errors } = state;
  const patch = (key: number, p: Partial<VersionDraft>) => setDrafts(drafts.map((d) => (d.key === key ? { ...d, ...p } : d)));
  const caption = state.clearing
    ? t('library.versions.clearingHint')
    : drafts.length === 0
      ? t('library.versions.unversionedHint')
      : t('library.versions.firstVersionHint');
  return (
    <FormRow label={t('library.versions.versions')} caption={caption}>
      <div className="lib-versions" role="group" aria-label={t('library.versions.versions')}>
        {drafts.map((d, i) => {
          const e = errors.get(d.key);
          const n = i + 1;
          return (
            <div className="lib-versions__row" key={d.key} data-testid="version-row">
              <Input
                id={`${idPrefix}-version-tag-${d.key}`}
                mono
                className="lib-versions__tag"
                aria-label={t('library.versions.tagForVersion', { n })}
                value={d.tag}
                invalid={Boolean(e?.tag)}
                maxLength={64}
                onChange={(ev) => patch(d.key, { tag: ev.currentTarget.value })}
              />
              <Select
                aria-label={t('library.versions.profileForVersion', { n })}
                value={d.qualityProfileId === null ? '' : String(d.qualityProfileId)}
                invalid={Boolean(e?.profile)}
                placeholder={t('library.versions.chooseProfile')}
                onChange={(ev) => patch(d.key, { qualityProfileId: ev.currentTarget.value === '' ? null : Number(ev.currentTarget.value) })}
                options={profiles.map((p) => ({ value: String(p.id), label: p.name }))}
              />
              <Toggle
                size="sm"
                aria-label={t('library.versions.enabledForVersion', { n })}
                checked={d.enabled}
                onChange={(ev) => patch(d.key, { enabled: ev.currentTarget.checked })}
                label={d.enabled ? t('library.versions.wanted') : t('library.versions.notWanted')}
              />
              <Button size="sm" variant="ghost" aria-label={t('library.versions.removeVersion', { n })} onClick={() => setDrafts(drafts.filter((x) => x.key !== d.key))}>
                {t('common.remove')}
              </Button>
              {e?.tag || e?.profile ? (
                <span className="al-form-row__error lib-versions__error" role="alert">
                  {[e.tag, e.profile].filter(Boolean).join(' · ')}
                </span>
              ) : null}
            </div>
          );
        })}
        <div>
          <Button size="sm" variant="secondary" disabled={drafts.length >= MAX_VERSIONS} onClick={() => setDrafts([...drafts, newVersionDraft(drafts, defaultProfileId)])}>
            {t('library.versions.addVersion')}
          </Button>
          {drafts.length >= MAX_VERSIONS ? <span className="al-caption lib-versions__max">{t('library.versions.maxReached', { max: MAX_VERSIONS })}</span> : null}
        </div>
      </div>
    </FormRow>
  );
}

/** Mono tag naming the version slot a file fills; nothing for an unversioned file. */
export function VersionBadge({ tag }: { tag: string | null | undefined }) {
  const t = useT();
  if (!tag) return null;
  return (
    <Tag className="al-num lib-version-badge" data-testid="version-badge" title={t('library.versions.versionTag', { tag })}>
      {tag}
    </Tag>
  );
}

/** Wanted lists: the version slots still missing / below cutoff. */
export function WantedVersions({ tags }: { tags: readonly string[] | undefined }) {
  const t = useT();
  if (!tags || tags.length === 0) return <span className="mk-muted">—</span>;
  return (
    <span className="lib-version-tags" role="group" aria-label={t('library.versions.wantedVersionsList', { list: tags.join(', ') })}>
      {tags.map((tag) => (
        <VersionBadge key={tag} tag={tag} />
      ))}
    </span>
  );
}

/**
 * A "Version" table column, or nothing when no row has a version tag (unversioned libraries
 * look exactly as before).
 */
export function versionColumn<T>(rows: readonly T[] | undefined, get: (r: T) => string | null | undefined, header: string): Column<T>[] {
  if (!hasVersionTags(rows, get)) return [];
  return [{ key: 'version', header, sortValue: (r) => get(r) ?? '', cell: (r) => <VersionBadge tag={get(r)} />, width: '110px' }];
}

/** Wanted lists: a "Versions" column when any row reports wanted versions. */
export function wantedVersionsColumn<T extends { wantedVersions?: string[] | undefined }>(rows: readonly T[] | undefined, header: string): Column<T>[] {
  if (!(rows ?? []).some((r) => (r.wantedVersions?.length ?? 0) > 0)) return [];
  return [{ key: 'versions', header, cell: (r) => <WantedVersions tags={r.wantedVersions} /> }];
}

/**
 * Manual import: which version slot a file fills. '' = "Best fit" (the server picks); shown as a
 * dash when the chosen item is unversioned.
 */
export function VersionPicker({ tags, value, onChange, label }: { tags: readonly string[]; value: string; onChange: (tag: string) => void; label: string }) {
  const t = useT();
  if (tags.length === 0) return <span className="al-activity-muted">—</span>;
  return (
    <Select
      aria-label={label}
      value={tags.includes(value) ? value : ''}
      onChange={(e) => onChange(e.currentTarget.value)}
      options={[{ value: '', label: t('library.versions.bestFit') }, ...tags.map((tag) => ({ value: tag, label: tag }))]}
    />
  );
}

/** Episode drawer: every kept version of the episode (only when the series is versioned). */
export function EpisodeVersionFiles({ files }: { files: readonly MediaFileVersion[] | undefined }) {
  const t = useT();
  if (!hasVersionTags(files, (f) => f.versionTag)) return null;
  return (
    <section className="mk-drawer-section" aria-label={t('library.versions.versions')}>
      <div className="al-label">{t('library.versions.versions')}</div>
      <ul className="lib-version-files">
        {(files ?? []).map((f) => (
          <li key={f.id}>
            <VersionBadge tag={f.versionTag} />
            <span className="al-num lib-version-files__path" title={f.relativePath}>
              {f.relativePath}
            </span>
            <span className="al-num mk-muted">
              {qualityName(f.quality) ?? '—'} · {formatBytes(f.sizeBytes)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
