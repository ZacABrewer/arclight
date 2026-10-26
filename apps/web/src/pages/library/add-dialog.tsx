import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { MetadataSearchResult, MinimumAvailability, MonitorOption, QualityProfile, RootFolder, SeriesType } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button } from '../../components/button.js';
import { FormField, Select, Toggle } from '../../components/form.js';
import { Poster } from '../../components/media/media-ui.js';
import { destinationPath } from '../../components/media/path-preview.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import { Modal } from '../../components/modal.js';
import { PathPickerDialog } from '../../components/path-picker/index.js';
import { useAddRootFolder } from '../../hooks/settings.js';
import { useAddMovie, useAddSeries } from '../../hooks/library.js';
import { useToast } from '../../components/toast.js';
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
} from './add-form.js';

const REMEMBER_KEY = 'library.add.defaults';

function loadDefaults(mediaType: string): AddDefaults {
  try {
    const raw = localStorage.getItem(`${REMEMBER_KEY}.${mediaType}`);
    return raw ? (JSON.parse(raw) as AddDefaults) : {};
  } catch {
    return {};
  }
}

function saveDefaults(mediaType: string, d: AddDefaults) {
  try {
    localStorage.setItem(`${REMEMBER_KEY}.${mediaType}`, JSON.stringify(d));
  } catch {
    // ignore: remembering is a convenience
  }
}

export interface AddDialogProps {
  result: MetadataSearchResult | null;
  onClose: () => void;
  rootFolders: readonly RootFolder[];
  profiles: readonly QualityProfile[];
}

export function AddDialog({ result, onClose, rootFolders, profiles }: AddDialogProps) {
  return (
    <Modal open={result !== null} onClose={onClose} title={result ? `Add ${result.title}` : 'Add'} size="lg">
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

  const submit = () => {
    setTouched(true);
    if (!isValid(errors)) return;
    saveDefaults(mediaType, { rootFolderPath: form.rootFolderPath, qualityProfileId: form.qualityProfileId ?? undefined });
    const onSuccess = (item: { id: number; title: string }) => {
      toast.push({ tone: 'ok', title: `Added ${item.title}` });
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
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="result-card">
        <Poster url={result.images.poster} title={result.title} />
        <div className="result-card-body">
          <p className="result-card-title">
            {result.title} {result.year ? <span className="muted">({result.year})</span> : null}
          </p>
          <p className="result-card-overview">{result.overview || 'No overview.'}</p>
        </div>
      </div>

      <div className="fields">
        <FormField
          label="Root folder"
          error={touched ? errors.rootFolderPath : undefined}
          hint={
            <>
              {roots.length === 0 ? 'No root folder yet. ' : null}
              <Button size="sm" variant="ghost" loading={addRoot.isPending} onClick={() => setBrowsing(true)}>
                Browse for a folder…
              </Button>
            </>
          }
        >
          <Select value={form.rootFolderPath} onChange={(e) => set('rootFolderPath', e.target.value)}>
            <option value="">Select a root folder…</option>
            {roots.map((r) => (
              <option key={r.id} value={r.path}>
                {r.path}
                {r.accessible ? '' : ' (inaccessible)'}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Quality profile" error={touched ? errors.qualityProfileId : undefined}>
          <Select
            value={form.qualityProfileId?.toString() ?? ''}
            onChange={(e) => set('qualityProfileId', e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select a profile…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>

        {mediaType === 'series' ? (
          <>
            <FormField label="Monitor">
              <Select value={form.monitorOption} onChange={(e) => set('monitorOption', e.target.value as MonitorOption)}>
                {Object.entries(MONITOR_OPTION_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Series type">
              <Select value={form.seriesType} onChange={(e) => set('seriesType', e.target.value as SeriesType)}>
                {Object.entries(SERIES_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </FormField>
            <Toggle label="Use season folders" checked={form.seasonFolder} onChange={(e) => set('seasonFolder', e.target.checked)} />
          </>
        ) : (
          <>
            <Toggle label="Monitored" checked={form.monitored} onChange={(e) => set('monitored', e.target.checked)} />
            <FormField label="Minimum availability">
              <Select value={form.minimumAvailability} onChange={(e) => set('minimumAvailability', e.target.value as MinimumAvailability)}>
                {Object.entries(MINIMUM_AVAILABILITY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        )}

        <LanguageProfileSelect allowDefault value={form.languageProfileId} onChange={(v) => set('languageProfileId', v)} />

        <div className="field">
          <span className="field-label">Tags</span>
          <TagPicker value={form.tags} onChange={(ids) => set('tags', ids)} />
        </div>

        <Toggle
          label={mediaType === 'series' ? 'Start searching for missing episodes' : 'Start searching for the movie'}
          checked={form.searchOnAdd}
          onChange={(e) => set('searchOnAdd', e.target.checked)}
        />

        <div className="field">
          <span className="field-label">Destination</span>
          <div className="path-preview" data-testid="path-preview">
            {preview || <span className="muted">Choose a root folder to see the path</span>}
          </div>
        </div>
      </div>

      {mutation.isError ? (
        <p className="field-error-text" role="alert">
          {errorMessage(mutation.error)}
        </p>
      ) : null}

      <div className="modal-footer">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={mutation.isPending} disabled={touched && !isValid(errors)}>
          Add {mediaType === 'series' ? 'series' : 'movie'}
        </Button>
      </div>
      <PathPickerDialog
        open={browsing}
        onClose={() => setBrowsing(false)}
        title="Choose a root folder"
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
