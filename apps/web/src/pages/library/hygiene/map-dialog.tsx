import { useEffect, useId, useMemo, useState } from 'react';
import type { HygieneFinding } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Checkbox, ErrorBlock, Field, Modal, Segmented, Select, Skeleton } from '../../../arclight/index.js';
import { EntityPicker } from '../../../components/entity-picker.js';
import { episodeCode, formatBytes } from '../../../components/media/format.js';
import { useToast } from '../../../components/toast.js';
import { useHygieneMap, useMapEpisodes } from '../../../hooks/hygiene.js';
import { useMovieList, useSeriesList } from '../../../hooks/library.js';
import { bestSuggestion, buildMapRequest, episodesBySeason, fileName, guessLabel, initialMapDraft, suggestionLabel, type MapDraft } from './hygiene-model.js';
import { t } from '../../../i18n/index.js';

/** Map an orphan file onto a series' episodes or a movie, through manual import. */
export function MapDialog({ finding, onClose }: { finding: HygieneFinding | null; onClose: () => void }) {
  const [draft, setDraft] = useState<MapDraft>(() => (finding ? initialMapDraft(finding) : initialMapDraft({ suggestions: [], parsed: null })));
  const [error, setError] = useState<string | null>(null);
  const series = useSeriesList();
  const movies = useMovieList();
  const episodes = useMapEpisodes(draft.mediaType === 'series' ? draft.seriesId : null);
  const map = useHygieneMap();
  const toast = useToast();
  const modeId = useId();

  useEffect(() => {
    if (finding) {
      setDraft(initialMapDraft(finding));
      setError(null);
      map.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding]);

  const seriesOptions = useMemo(() => (series.data ?? []).map((s) => ({ id: s.id, label: s.title, detail: String(s.year) })), [series.data]);
  const movieOptions = useMemo(() => (movies.data ?? []).map((m) => ({ id: m.id, label: m.title, detail: String(m.year) })), [movies.data]);
  const seasons = useMemo(() => episodesBySeason(episodes.data ?? []), [episodes.data]);
  const best = finding ? bestSuggestion(finding) : undefined;

  const submit = () => {
    if (!finding) return;
    const built = buildMapRequest(draft);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    map.mutate(
      { id: finding.id, body: built.body },
      {
        onSuccess: (r) => {
          toast.push({ tone: 'ok', title: t('library.hygiene.mapDialog.importedFilename', { fileName: fileName(finding.path) }), message: r.destination });
          onClose();
        },
      },
    );
  };

  const toggleEpisode = (id: number, on: boolean) =>
    setDraft((d) => ({ ...d, episodeIds: on ? [...new Set([...d.episodeIds, id])] : d.episodeIds.filter((x) => x !== id) }));

  return (
    <Modal
      open={finding !== null}
      onClose={onClose}
      size={640}
      title={t('library.hygiene.mapDialog.mapFile')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={map.isPending} onClick={submit}>
            {t('library.hygiene.mapDialog.importFile')}
          </Button>
        </>
      }
    >
      {finding ? (
        <div className="hyg-map">
          <div className="hyg-map__file">
            <div className="al-num hyg-path">{finding.path}</div>
            <div className="al-caption">
              {formatBytes(finding.sizeBytes)} · {guessLabel(finding.parsed)}
              {best ? t('library.hygiene.mapDialog.bestMatchSuggestionlabel', { suggestionLabel: suggestionLabel(best) }) : ''}
            </div>
          </div>
          <Segmented
            aria-label={t('library.hygiene.mapDialog.mapTo')}
            value={draft.mediaType}
            onChange={(mediaType) => setDraft((d) => ({ ...d, mediaType }))}
            options={[
              { value: 'series', label: t('common.series') },
              { value: 'movie', label: t('common.movie') },
            ]}
          />
          {draft.mediaType === 'series' ? (
            <>
              <EntityPicker
                aria-label={t('common.series')}
                placeholder={t('library.hygiene.mapDialog.chooseASeries')}
                options={seriesOptions}
                value={draft.seriesId}
                onChange={(seriesId) => setDraft((d) => ({ ...d, seriesId, episodeIds: seriesId === best?.seriesId ? [...(best?.episodeIds ?? [])] : [] }))}
              />
              {draft.seriesId !== null ? (
                <fieldset className="hyg-episodes">
                  <legend className="al-label">{t('library.hygiene.mapDialog.episodesEpisodeidscountSelected', { episodeIdsCount: draft.episodeIds.length })}</legend>
                  {episodes.isPending ? <Skeleton lines={3} /> : null}
                  {seasons.map((s) => (
                    <div key={s.season} className="hyg-episodes__season">
                      <div className="al-caption">{s.season === 0 ? t('common.specials') : t('library.hygiene.mapDialog.seasonSeason', { season: s.season })}</div>
                      <div className="hyg-episodes__grid">
                        {s.episodes.map((e) => (
                          <Checkbox
                            key={e.id}
                            label={
                              <>
                                <span className="al-num">{episodeCode(e.seasonNumber, e.episodeNumber)}</span> {e.title}
                              </>
                            }
                            aria-label={`${episodeCode(e.seasonNumber, e.episodeNumber)} ${e.title}`}
                            checked={draft.episodeIds.includes(e.id)}
                            onChange={(ev) => toggleEpisode(e.id, ev.currentTarget.checked)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </fieldset>
              ) : null}
            </>
          ) : (
            <EntityPicker aria-label={t('common.movie')} placeholder={t('library.hygiene.mapDialog.chooseAMovie')} options={movieOptions} value={draft.movieId} onChange={(movieId) => setDraft((d) => ({ ...d, movieId }))} />
          )}
          <Field label={t('library.hygiene.mapDialog.importMode')} htmlFor={modeId} hint={t('library.hygiene.mapDialog.filesAlreadyInsideTheItems')}>
            <Select
              id={modeId}
              value={draft.importMode}
              onChange={(e) => {
                const importMode = e.currentTarget.value as MapDraft['importMode'];
                setDraft((d) => ({ ...d, importMode }));
              }}
              options={[
                { value: 'move', label: t('library.hygiene.mapDialog.move') },
                { value: 'copy', label: t('common.copy') },
                { value: 'auto', label: t('library.hygiene.mapDialog.auto') },
              ]}
            />
          </Field>
          {error ? (
            <p className="hyg-error" role="alert">
              {error}
            </p>
          ) : null}
          {map.isError ? <ErrorBlock title={t('library.hygiene.mapDialog.importFailed')}>{errorMessage(map.error)}</ErrorBlock> : null}
        </div>
      ) : null}
    </Modal>
  );
}
