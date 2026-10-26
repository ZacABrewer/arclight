import { useEffect, useId, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { MetadataSearchResult, MinimumAvailability, MonitorOption, QualityProfile, RootFolder, SeriesType } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Chip, FormRow, Modal, Poster, Select, Toggle } from '../../arclight/index.js';
import { FolderPickerModal } from '../../components/media/folder-picker-modal.js';
import { localIsoDate } from '../../components/media/episode-status.js';
import { destinationPath } from '../../components/media/path-preview.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import { useToast } from '../../components/toast.js';
import { useAddRootFolder } from '../../hooks/settings.js';
import { useAddMovie, useAddSeries } from '../../hooks/library.js';
import { LanguageProfileSelect } from '../subtitles/language-profile-select.js';
import {
  MINIMUM_AVAILABILITY_LABELS,
  MONITOR_OPTION_LABELS,
  SERIES_TYPE_LABELS,
  initialAddForm,
  isValid,
  toAddMovieRequest,
  toAddSeriesRequest,
  validateAddForm,
  type AddDefaults,
  type AddFormState,
  resultMeta,
} from './add-form.js';
import './library.css';
import { t } from '../../i18n/index.js';

const REMEMBER_KEY = 'library.add.defaults';

export function loadDefaults(mediaType: string): AddDefaults {
  try {
    const raw = localStorage.getItem(`${REMEMBER_KEY}.${mediaType}`);
    return raw ? (JSON.parse(raw) as AddDefaults) : {};
  } catch {
    return {};
  }
}

export function saveDefaults(mediaType: string, d: AddDefaults) {
  try {
    localStorage.setItem(`${REMEMBER_KEY}.${mediaType}`, JSON.stringify(d));
  } catch {
    // ignore: remembering is a convenience
  }
}

/** Movie release state for the add dialog: released (available) or upcoming. */
export function releaseChip(releaseDate: string | undefined, today: string = localIsoDate(new Date())): { label: string; tone: 'accent' | 'neutral' } {
  if (!releaseDate) return { label: t('library.addDialog.releaseDateUnknown'), tone: 'neutral' };
  return releaseDate <= today ? { label: t('common.available'), tone: 'accent' } : { label: t('library.addDialog.notReleasedYet'), tone: 'neutral' };
}

export interface AddDialogProps {
  result: MetadataSearchResult | null;
  onClose: () => void;
  rootFolders: readonly RootFolder[];
  profiles: readonly QualityProfile[];
}

/** Add dialog: Modal 560 with form rows and the mono destination preview. */
export function AddDialog({ result, onClose, rootFolders, profiles }: AddDialogProps) {
  return (
    <Modal open={result !== null} onClose={onClose} title={result ? t('library.addDialog.addTitle', { title: result.title }) : t('common.add')} size={560}>
      {result ? <AddForm key={`${result.mediaType}-${result.tmdbId}`} result={result} onClose={onClose} rootFolders={rootFolders} profiles={profiles} /> : null}
    </Modal>
  );
}

export function AddForm({ result, onClose, rootFolders, profiles }: { result: MetadataSearchResult } & Omit<AddDialogProps, 'result'>) {
  const mediaType = result.mediaType;
  const [form, setForm] = useState<AddFormState>(() => initialAddForm(mediaType, rootFolders, profiles, loadDefaults(mediaType)));
  const [touched, setTouched] = useState(false);
  const addSeries = useAddSeries();
  const addMovie = useAddMovie();
  const mutation = mediaType === 'series' ? addSeries : addMovie;
  const navigate = useNavigate();
  const toast = useToast();
  const addRoot = useAddRootFolder();
  const [browsing, setBrowsing] = useState(false);
  const ids = useId();
  const fid = (k: string) => `${ids}-${k}`;

  // Profiles / root folders can arrive after the dialog opened.
  useEffect(() => {
    setForm((f) => {
      if (f.rootFolderPath && f.qualityProfileId !== null) return f;
      const init = initialAddForm(mediaType, rootFolders, profiles, loadDefaults(mediaType));
      return {
        ...f,
        rootFolderPath: f.rootFolderPath || init.rootFolderPath,
        qualityProfileId: f.qualityProfileId ?? init.qualityProfileId,
      };
    });
  }, [mediaType, rootFolders, profiles]);

  const errors = validateAddForm(form);
  const set = <K extends keyof AddFormState>(key: K, value: AddFormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const roots = rootFolders.filter((r) => r.mediaType === mediaType);
  const preview = destinationPath(form.rootFolderPath, result.title, result.year);
  const release = result.mediaType === 'movie' ? releaseChip(result.releaseDate) : null;

  const submit = () => {
    setTouched(true);
    if (!isValid(errors)) return;
    saveDefaults(mediaType, { rootFolderPath: form.rootFolderPath, qualityProfileId: form.qualityProfileId ?? undefined });
    const onSuccess = (item: { id: number; title: string }) => {
      toast.push({ tone: 'ok', title: t('library.addDialog.addedTitle', { title: item.title }) });
      onClose();
      void navigate(
        mediaType === 'series'
          ? { to: '/library/series/$id', params: { id: String(item.id) } }
          : { to: '/library/movie/$id', params: { id: String(item.id) } },
      );
    };
    if (mediaType === 'series') addSeries.mutate(toAddSeriesRequest(result.tmdbId, form), { onSuccess });
    else addMovie.mutate(toAddMovieRequest(result.tmdbId, form), { onSuccess });
  };

  return (
    <form
      className="mk-stack-sm"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="lib-add-head">
        <Poster src={result.images.poster} title={result.title} />
        <div style={{ minWidth: 0 }}>
          <div className="mk-result__title">
            {result.title} {result.year ? <span className="al-num mk-muted">{result.year}</span> : null}
          </div>
          <div className="mk-result__meta">{resultMeta(result)}</div>
          {result.mediaType === 'movie' ? (
            <div className="mk-dates" style={{ marginTop: 6, alignItems: 'center' }} aria-label={t('library.addDialog.releaseDates')}>
              <span>
                {t('common.released')}<span className="al-num">{result.releaseDate ?? '—'}</span>
              </span>
              {release ? (
                <Chip tone={release.tone} data-testid="availability">
                  {release.label}
                </Chip>
              ) : null}
            </div>
          ) : null}
          <p>{result.overview || t('common.noOverviewAvailable')}</p>
        </div>
      </div>

      <FormRow
        label={t('common.rootFolder')}
        htmlFor={fid('root')}
        error={touched ? errors.rootFolderPath : undefined}
        caption={roots.length === 0 ? t('library.addDialog.noRootFolderYetBrowse') : undefined}
      >
        <div className="mk-row" style={{ flexWrap: 'nowrap' }}>
          <Select id={fid('root')} value={form.rootFolderPath} onChange={(e) => set('rootFolderPath', e.target.value)} style={{ flex: 1 }}>
            <option value="">{t('library.addDialog.selectARootFolder')}</option>
            {roots.map((r) => (
              <option key={r.id} value={r.path}>
                {r.path}
                {r.accessible ? '' : t('library.addDialog.inaccessible')}
              </option>
            ))}
          </Select>
          <Button loading={addRoot.isPending} onClick={() => setBrowsing(true)}>
            {t('library.addDialog.browse')}
          </Button>
        </div>
      </FormRow>

      <FormRow label={t('common.qualityProfile')} htmlFor={fid('profile')} error={touched ? errors.qualityProfileId : undefined}>
        <Select id={fid('profile')} value={form.qualityProfileId?.toString() ?? ''} onChange={(e) => set('qualityProfileId', e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t('library.addDialog.selectAProfile')}</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormRow>

      {mediaType === 'series' ? (
        <>
          <FormRow label={t('common.monitor')} htmlFor={fid('monitor')}>
            <Select id={fid('monitor')} value={form.monitorOption} onChange={(e) => set('monitorOption', e.target.value as MonitorOption)}>
              {Object.entries(MONITOR_OPTION_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </FormRow>
          <FormRow label={t('common.seriesType')} htmlFor={fid('type')}>
            <Select id={fid('type')} value={form.seriesType} onChange={(e) => set('seriesType', e.target.value as SeriesType)}>
              {Object.entries(SERIES_TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </FormRow>
          <FormRow label={t('common.seasonFolders')} htmlFor={fid('season-folder')} captionInline caption={t('library.addDialog.putEachSeasonInIts')}>
            <Toggle id={fid('season-folder')} checked={form.seasonFolder} onChange={(e) => set('seasonFolder', e.target.checked)} />
          </FormRow>
        </>
      ) : (
        <>
          <FormRow label={t('status.monitored')} htmlFor={fid('monitored')} captionInline caption={t('library.addDialog.searchForTheMovieOnce')}>
            <Toggle id={fid('monitored')} checked={form.monitored} onChange={(e) => set('monitored', e.target.checked)} />
          </FormRow>
          <FormRow label={t('common.minimumAvailability')} htmlFor={fid('availability')}>
            <Select id={fid('availability')} value={form.minimumAvailability} onChange={(e) => set('minimumAvailability', e.target.value as MinimumAvailability)}>
              {Object.entries(MINIMUM_AVAILABILITY_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </FormRow>
        </>
      )}

      <LanguageProfileSelect allowDefault value={form.languageProfileId} onChange={(v) => set('languageProfileId', v)} />

      <FormRow label={t('common.tags')}>
        <TagPicker value={form.tags} onChange={(tagIds) => set('tags', tagIds)} />
      </FormRow>

      <FormRow
        label={t('common.searchOnAdd')}
        htmlFor={fid('search')}
        captionInline
        caption={mediaType === 'series' ? t('library.addDialog.searchForMissingEpisodesRight') : t('library.addDialog.searchForTheMovieRight')}
      >
        <Toggle id={fid('search')} checked={form.searchOnAdd} onChange={(e) => set('searchOnAdd', e.target.checked)} />
      </FormRow>

      <FormRow label={t('library.addDialog.destination')}>
        <div className="lib-path-preview" data-testid="path-preview">
          {preview || t('library.addDialog.chooseARootFolderTo')}
        </div>
      </FormRow>

      {mutation.isError ? (
        <p className="al-field__error" role="alert" style={{ margin: 0 }}>
          {errorMessage(mutation.error)}
        </p>
      ) : null}

      <div className="lib-form-foot">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={mutation.isPending} disabled={touched && !isValid(errors)}>
          {t('library.addDialog.addValue', { value: mediaType === 'series' ? t('library.addDialog.series') : t('library.addDialog.movie') })}
        </Button>
      </div>
      <FolderPickerModal
        open={browsing}
        onClose={() => setBrowsing(false)}
        title={t('common.chooseARootFolder')}
        initialPath={form.rootFolderPath}
        onSelect={(path) => {
          setBrowsing(false);
          if (roots.some((r) => r.path === path)) {
            set('rootFolderPath', path);
            return;
          }
          // A new folder becomes a root folder first; the add request needs a known root.
          addRoot.mutate({ path, mediaType }, { onSuccess: (root) => set('rootFolderPath', root.path) });
        }}
      />
    </form>
  );
}
