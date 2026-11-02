import { useEffect, useId, useMemo, useState } from 'react';
import type { SmartCollection, SmartCollectionList, SmartCollectionSort, SmartCollectionWatchStatus } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, Field, Input, Modal, Pane, Segmented, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { TermList } from '../../../components/forms/term-list.js';
import { useDebouncedValue } from '../../../hooks/metadata.js';
import { useSaveSmartCollection, useSmartCollectionPreview } from '../../../hooks/smart-collections.js';
import { t } from '../../../i18n/index.js';
import { formatDateTime } from '../../../lib/format.js';
import { decades, draftDecade, draftFrom, listLabel, sortLabel, toInput, validateDraft, watchStatusLabel, type CollectionDraft } from './collection-model.js';

const LISTS: SmartCollectionList[] = ['trending', 'popular', 'topRated'];
const WATCH: SmartCollectionWatchStatus[] = ['any', 'unwatched', 'watched', 'inProgress'];
const SORTS: SmartCollectionSort[] = ['added', 'title', 'year', 'rating', 'plays', 'list'];

/** Titles the draft matches right now (POST /collections/smart/preview), refreshed as the form settles. */
function Preview({ draft }: { draft: CollectionDraft }) {
  const settled = useDebouncedValue(draft, 400);
  const body = useMemo(() => (Object.keys(validateDraft(settled, { requireName: false })).length ? null : toInput(settled, settled.name.trim() || 'Preview')), [settled]);
  const preview = useSmartCollectionPreview(body);
  return (
    <Pane small title={t('smartCollections.editor.preview')} aria-label={t('smartCollections.editor.preview')} aria-live="polite" className="sc-preview">
      {body === null ? (
        <p className="al-caption">{t('smartCollections.editor.fixToPreview')}</p>
      ) : preview.isError ? (
        <ErrorBlock title={t('smartCollections.editor.previewFailed')}>{errorMessage(preview.error)}</ErrorBlock>
      ) : preview.isPending ? (
        <Skeleton lines={4} />
      ) : (
        <>
          <p className="al-caption sc-preview__total">{t('smartCollections.editor.matches', { count: preview.data.total })}</p>
          {preview.data.items.length ? (
            <ul className="sc-titles">
              {preview.data.items.map((i) => (
                <li key={`${i.mediaType}-${i.id}`}>
                  <span className="sc-titles__name">{i.title}</span> <span className="al-caption al-num">{i.year}</span>
                  {i.removeAt ? <span className="al-caption"> · {formatDateTime(i.removeAt)}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {preview.data.total > preview.data.items.length ? <p className="al-caption">{t('smartCollections.editor.andMore', { count: preview.data.total - preview.data.items.length })}</p> : null}
        </>
      )}
    </Pane>
  );
}

export interface CollectionEditorProps {
  open: boolean;
  /** null = new collection. */
  collection: SmartCollection | null;
  onClose: () => void;
}

export function CollectionEditor({ open, collection, onClose }: CollectionEditorProps) {
  const [draft, setDraft] = useState<CollectionDraft>(() => draftFrom(collection));
  const [showErrors, setShowErrors] = useState(false);
  const save = useSaveSmartCollection();
  const id = {
    name: useId(),
    genres: useId(),
    exclude: useId(),
    decade: useId(),
    yearFrom: useId(),
    yearTo: useId(),
    studios: useId(),
    tmdb: useId(),
    list: useId(),
    rating: useId(),
    added: useId(),
    watch: useId(),
    sort: useId(),
    limit: useId(),
  };

  useEffect(() => {
    if (open) {
      setDraft(draftFrom(collection));
      setShowErrors(false);
      save.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, collection]);

  const set = <K extends keyof CollectionDraft>(k: K, v: CollectionDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const errors = validateDraft(draft);
  const shown = showErrors ? errors : {};
  const decade = draftDecade(draft);

  const submit = () => {
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    save.mutate({ id: collection?.id ?? null, body: toInput(draft) }, { onSuccess: onClose });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={collection ? t('smartCollections.editor.editName', { name: collection.name }) : t('smartCollections.editor.add')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {collection ? t('common.save') : t('smartCollections.editor.create')}
          </Button>
        </>
      }
    >
      <div className="sc-editor">
        <div className="sc-editor__form">
          {save.isError ? (
            <p className="sc-error" role="alert">
              {errorMessage(save.error)}
            </p>
          ) : null}
          <Field label={t('common.name')} htmlFor={id.name} error={shown.name}>
            <Input id={id.name} value={draft.name} invalid={!!shown.name} onChange={(e) => set('name', e.currentTarget.value)} />
          </Field>
          <div className="sc-row">
            <Toggle label={t('common.enabled')} checked={draft.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
            <Segmented
              aria-label={t('common.mediaType')}
              value={draft.mediaType}
              onChange={(v) => set('mediaType', v)}
              options={[
                { value: 'movie', label: t('common.movies') },
                { value: 'series', label: t('common.series') },
                { value: 'all', label: t('smartCollections.both') },
              ]}
            />
          </div>

          <fieldset className="sc-fieldset">
            <legend className="al-label">{t('smartCollections.editor.genres')}</legend>
            <Field label={t('smartCollections.editor.includeGenres')} htmlFor={id.genres}>
              <TermList id={id.genres} value={draft.genres} onChange={(v) => set('genres', v)} placeholder={t('smartCollections.editor.genrePlaceholder')} />
            </Field>
            {draft.genres.length > 1 ? (
              <Segmented
                aria-label={t('smartCollections.editor.genreMatch')}
                variant="soft"
                value={draft.genreMatch}
                onChange={(v) => set('genreMatch', v)}
                options={[
                  { value: 'any', label: t('smartCollections.editor.anyGenre') },
                  { value: 'all', label: t('smartCollections.editor.allGenres') },
                ]}
              />
            ) : null}
            <Field label={t('smartCollections.editor.excludeGenres')} htmlFor={id.exclude}>
              <TermList id={id.exclude} value={draft.excludeGenres} onChange={(v) => set('excludeGenres', v)} placeholder={t('smartCollections.editor.genrePlaceholder')} />
            </Field>
          </fieldset>

          <fieldset className="sc-fieldset">
            <legend className="al-label">{t('smartCollections.editor.release')}</legend>
            <div className="sc-grid">
              <Field label={t('smartCollections.editor.decade')} htmlFor={id.decade}>
                <Select
                  id={id.decade}
                  value={decade === null ? '' : String(decade)}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setDraft((d) => (v ? { ...d, yearFrom: v, yearTo: String(Number(v) + 9) } : { ...d, yearFrom: '', yearTo: '' }));
                  }}
                >
                  <option value="">{t('smartCollections.editor.anyDecade')}</option>
                  {decades().map((y) => (
                    <option key={y} value={String(y)}>
                      {t('smartCollections.editor.decadeValue', { year: y })}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('smartCollections.editor.yearFrom')} htmlFor={id.yearFrom} error={shown.yearFrom}>
                <Input id={id.yearFrom} mono inputMode="numeric" value={draft.yearFrom} invalid={!!shown.yearFrom} onChange={(e) => set('yearFrom', e.currentTarget.value)} />
              </Field>
              <Field label={t('smartCollections.editor.yearTo')} htmlFor={id.yearTo} error={shown.yearTo}>
                <Input id={id.yearTo} mono inputMode="numeric" value={draft.yearTo} invalid={!!shown.yearTo} onChange={(e) => set('yearTo', e.currentTarget.value)} />
              </Field>
            </div>
          </fieldset>

          <fieldset className="sc-fieldset">
            <legend className="al-label">{t('smartCollections.editor.source')}</legend>
            <Field label={t('smartCollections.editor.studios')} htmlFor={id.studios} hint={t('smartCollections.editor.studiosHint')}>
              <TermList id={id.studios} value={draft.studios} onChange={(v) => set('studios', v)} placeholder={t('smartCollections.editor.studioPlaceholder')} />
            </Field>
            <Field label={t('smartCollections.editor.tmdbCollections')} htmlFor={id.tmdb} hint={t('smartCollections.editor.tmdbCollectionsHint')} error={shown.tmdbCollectionIds}>
              <TermList id={id.tmdb} value={draft.tmdbCollectionIds} onChange={(v) => set('tmdbCollectionIds', v)} placeholder={t('smartCollections.editor.tmdbPlaceholder')} />
            </Field>
            <Field label={t('smartCollections.editor.list')} htmlFor={id.list}>
              <Select id={id.list} value={draft.list} onChange={(e) => set('list', e.currentTarget.value as SmartCollectionList | '')}>
                <option value="">{t('smartCollections.editor.noList')}</option>
                {LISTS.map((l) => (
                  <option key={l} value={l}>
                    {listLabel(l)}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>

          <fieldset className="sc-fieldset">
            <legend className="al-label">{t('smartCollections.editor.filters')}</legend>
            <div className="sc-grid">
              <Field label={t('smartCollections.editor.minRating')} htmlFor={id.rating} error={shown.minRating}>
                <Input id={id.rating} mono inputMode="decimal" value={draft.minRating} invalid={!!shown.minRating} onChange={(e) => set('minRating', e.currentTarget.value)} />
              </Field>
              <Field label={t('smartCollections.editor.addedWithin')} htmlFor={id.added} error={shown.addedWithinDays}>
                <Input id={id.added} mono inputMode="numeric" value={draft.addedWithinDays} invalid={!!shown.addedWithinDays} onChange={(e) => set('addedWithinDays', e.currentTarget.value)} />
              </Field>
              <Field label={t('smartCollections.editor.watchStatus')} htmlFor={id.watch} hint={t('smartCollections.editor.watchStatusHint')}>
                <Select id={id.watch} value={draft.watchStatus} onChange={(e) => set('watchStatus', e.currentTarget.value as SmartCollectionWatchStatus)}>
                  {WATCH.map((w) => (
                    <option key={w} value={w}>
                      {watchStatusLabel(w)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </fieldset>

          <fieldset className="sc-fieldset">
            <legend className="al-label">{t('smartCollections.editor.order')}</legend>
            <div className="sc-grid">
              <Field label={t('smartCollections.editor.sort')} htmlFor={id.sort}>
                <Select id={id.sort} value={draft.sort} onChange={(e) => set('sort', e.currentTarget.value as SmartCollectionSort)}>
                  {SORTS.map((s) => (
                    <option key={s} value={s}>
                      {sortLabel(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('smartCollections.editor.limit')} htmlFor={id.limit} hint={t('smartCollections.editor.limitHint')} error={shown.limit}>
                <Input id={id.limit} mono inputMode="numeric" value={draft.limit} invalid={!!shown.limit} onChange={(e) => set('limit', e.currentTarget.value)} />
              </Field>
            </div>
          </fieldset>
        </div>
        <Preview draft={draft} />
      </div>
    </Modal>
  );
}
