import { useEffect, useId, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanSegmentsResponse, SeasonSegmentsResponse, type EpisodeSegmentsRow, type VideoSegment, type VideoSegmentEdit } from '@arclight/shared';
import { errorMessage, request } from '../../api/client.js';
import { Button, Chip, ErrorBlock, Input, Modal, Skeleton } from '../../arclight/index.js';
import { episodeCode } from '../../components/media/format.js';
import { useToast } from '../../components/toast.js';
import { t } from '../../i18n/index.js';

// Intro and credits of one season (admin): the effective segments of each episode with where they
// came from (chapters, audio detection or a manual edit), m:ss editing that saves a manual override
// (which wins over both), "Reset to detected" (drops the override) and "Scan this season" (queues
// detection again). Opened from the season header on the series page.

export const segmentKeys = {
  season: (seriesId: number, seasonNumber: number) => ['library', 'segments', seriesId, seasonNumber] as const,
};

export const segmentsApi = {
  season: (seriesId: number, seasonNumber: number) => request(`/playback/segments/series/${seriesId}/season/${seasonNumber}`, SeasonSegmentsResponse),
  save: (mediaFileId: number, segments: VideoSegmentEdit[]) => request(`/playback/segments/file/${mediaFileId}`, null, { method: 'PUT', json: { segments } }),
  reset: (mediaFileId: number) => request(`/playback/segments/file/${mediaFileId}`, null, { method: 'DELETE' }),
  scan: (seriesId: number, seasonNumber: number) => request('/playback/segments/scan', ScanSegmentsResponse, { method: 'POST', json: { seriesId, seasonNumber } }),
};

// ---- m:ss ---------------------------------------------------------------------------------------

/** 83_000 → "1:23", 3_723_000 → "1:02:03". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "1:23" / "1:02:03" / "83" (seconds) → ms; '' → null; anything else → NaN. */
export function parseClock(text: string): number | null {
  const v = text.trim();
  if (v === '') return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(v)) return Number.NaN;
  const parts = v.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return Number.NaN;
  const secs = parts.reduce((acc, p) => acc * 60 + p, 0);
  return Math.round(secs * 1000);
}

type EditType = 'intro' | 'credits';
const TYPES: readonly EditType[] = ['intro', 'credits'];

export type RowDraft = Record<EditType, { start: string; end: string }>;

export function toRowDraft(row: EpisodeSegmentsRow): RowDraft {
  const of = (type: EditType) => {
    const s = row.segments.find((x) => x.type === type);
    return s ? { start: formatClock(s.startMs), end: formatClock(s.endMs) } : { start: '', end: '' };
  };
  return { intro: of('intro'), credits: of('credits') };
}

/** The draft as a PUT body (recap segments are kept), or the first problem as a sentence. */
export function rowSegments(draft: RowDraft, row: EpisodeSegmentsRow): { ok: true; segments: VideoSegmentEdit[] } | { ok: false; error: string } {
  const out: VideoSegmentEdit[] = [];
  for (const type of TYPES) {
    const label = type === 'intro' ? t('library.segments.intro') : t('library.segments.credits');
    const start = parseClock(draft[type].start);
    const end = parseClock(draft[type].end);
    if (start === null && end === null) continue;
    if (start === null || end === null || Number.isNaN(start) || Number.isNaN(end)) return { ok: false, error: t('library.segments.badTime', { type: label }) };
    if (end <= start) return { ok: false, error: t('library.segments.endBeforeStart', { type: label }) };
    if (row.durationMs > 0 && start >= row.durationMs) return { ok: false, error: t('library.segments.pastEnd', { type: label }) };
    out.push({ type, startMs: start, endMs: row.durationMs > 0 ? Math.min(end, row.durationMs) : end });
  }
  for (const s of row.segments) if (s.type === 'recap') out.push({ type: 'recap', startMs: s.startMs, endMs: s.endMs });
  return { ok: true, segments: out };
}

const sameDraft = (a: RowDraft, b: RowDraft) => TYPES.every((k) => a[k].start === b[k].start && a[k].end === b[k].end);

export function sourceLabel(source: VideoSegment['source']): string {
  if (source === 'manual') return t('library.segments.sourceManual');
  if (source === 'chapter') return t('library.segments.sourceChapter');
  if (source === 'fingerprint') return t('library.segments.sourceDetected');
  return t('library.segments.sourceNone');
}

// Theme tokens only; wraps on phones (no table to scroll sideways).
const css: Record<'list' | 'row' | 'head' | 'title' | 'fields' | 'field' | 'legend' | 'input' | 'actions', CSSProperties> = {
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 },
  row: { border: '1px solid var(--al-line-2)', borderRadius: 'var(--al-radius-card)', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
  head: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  title: { color: 'var(--al-text-2)', minWidth: 0, overflowWrap: 'anywhere' },
  fields: { display: 'flex', gap: 18, flexWrap: 'wrap' },
  field: { display: 'flex', alignItems: 'center', gap: 6, border: 0, padding: 0, margin: 0, flexWrap: 'wrap', minWidth: 0 },
  legend: { float: 'left', marginRight: 6, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--al-text-3)', fontSize: 13 },
  input: { width: 84 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
};

// ---- one episode ----------------------------------------------------------------------------------

function EpisodeRow({ row, seriesId, seasonNumber }: { row: EpisodeSegmentsRow; seriesId: number; seasonNumber: number }) {
  const qc = useQueryClient();
  const saved = toRowDraft(row);
  const [draft, setDraft] = useState<RowDraft>(saved);
  const savedKey = JSON.stringify(saved);
  // A refetch (after save, reset or a scan) replaces the draft.
  useEffect(() => setDraft(JSON.parse(savedKey) as RowDraft), [savedKey]);
  const refresh = () => qc.invalidateQueries({ queryKey: segmentKeys.season(seriesId, seasonNumber) });
  const save = useMutation({ mutationFn: (segments: VideoSegmentEdit[]) => segmentsApi.save(row.mediaFileId, segments), onSuccess: refresh, meta: { silent: true } });
  const reset = useMutation({ mutationFn: () => segmentsApi.reset(row.mediaFileId), onSuccess: refresh, meta: { silent: true } });
  const result = rowSegments(draft, row);
  const dirty = !sameDraft(draft, saved);
  const code = episodeCode(row.seasonNumber, row.episodeNumber);
  const baseId = useId();
  const set = (type: EditType, edge: 'start' | 'end', value: string) => setDraft((d) => ({ ...d, [type]: { ...d[type], [edge]: value } }));
  const failure = save.error ?? reset.error;

  return (
    <li style={css.row} aria-label={row.title ? `${code} ${row.title}` : code}>
      <div style={css.head}>
        <strong style={{ fontFamily: 'var(--al-mono)' }}>{code}</strong>
        <span style={css.title}>{row.title ?? ''}</span>
        {row.manual ? (
          <Chip tone="accent" dot="none">
            {t('library.segments.sourceManual')}
          </Chip>
        ) : null}
      </div>
      <div style={css.fields}>
        {TYPES.map((type) => {
          const seg = row.segments.find((s) => s.type === type);
          const label = type === 'intro' ? t('library.segments.intro') : t('library.segments.credits');
          return (
            <fieldset key={type} style={css.field}>
              <legend style={css.legend}>
                {label}{' '}
                <Chip tone={seg ? 'neutral' : 'muted'} dot="none">
                  {sourceLabel(seg?.source)}
                </Chip>
              </legend>
              <label className="al-sr-only" htmlFor={`${baseId}-${type}-s`}>
                {t('library.segments.startOf', { type: label, episode: code })}
              </label>
              <Input
                id={`${baseId}-${type}-s`}
                mono
                inputMode="numeric"
                placeholder="m:ss"
                style={css.input}
                value={draft[type].start}
                onChange={(e) => set(type, 'start', e.currentTarget.value)}
              />
              <span aria-hidden="true">–</span>
              <label className="al-sr-only" htmlFor={`${baseId}-${type}-e`}>
                {t('library.segments.endOf', { type: label, episode: code })}
              </label>
              <Input id={`${baseId}-${type}-e`} mono inputMode="numeric" placeholder="m:ss" style={css.input} value={draft[type].end} onChange={(e) => set(type, 'end', e.currentTarget.value)} />
            </fieldset>
          );
        })}
      </div>
      <div style={css.actions}>
        {dirty && !result.ok ? (
          <span className="al-form-row__error" role="alert">
            {result.error}
          </span>
        ) : null}
        {failure ? (
          <span className="al-form-row__error" role="alert">
            {errorMessage(failure)}
          </span>
        ) : null}
        <span className="mk-spacer" />
        {row.manual ? (
          <Button type="button" size="sm" variant="ghost" loading={reset.isPending} onClick={() => reset.mutate()}>
            {t('library.segments.reset')}
          </Button>
        ) : null}
        <Button type="button" size="sm" disabled={!dirty || !result.ok || save.isPending} loading={save.isPending} onClick={() => result.ok && save.mutate(result.segments)}>
          {t('library.segments.save')}
        </Button>
      </div>
    </li>
  );
}

// ---- the dialog -----------------------------------------------------------------------------------

export interface SegmentsDialogProps {
  open: boolean;
  onClose: () => void;
  seriesId: number;
  seasonNumber: number;
  /** "Severance Season 2". */
  title: string;
}

export function SegmentsDialog({ open, onClose, seriesId, seasonNumber, title }: SegmentsDialogProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const season = useQuery({
    queryKey: segmentKeys.season(seriesId, seasonNumber),
    queryFn: () => segmentsApi.season(seriesId, seasonNumber),
    enabled: open,
    // Follow a queued or running scan until it is done.
    refetchInterval: (q) => (q.state.data && (q.state.data.scan.status === 'queued' || q.state.data.scan.status === 'running') ? 5000 : false),
  });
  const scan = useMutation({
    mutationFn: () => segmentsApi.scan(seriesId, seasonNumber),
    meta: { errorTitle: t('library.segments.couldNotScan') },
    onSuccess: () => {
      toast.push({ tone: 'ok', title: t('library.segments.scanQueued'), durationMs: 4000 });
      void qc.invalidateQueries({ queryKey: segmentKeys.season(seriesId, seasonNumber) });
    },
  });
  const data = season.data;
  const episodes = data ? [...data.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber) : [];
  const status = data?.scan.status;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size={1100}
      title={t('library.segments.title', { title })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="secondary" loading={scan.isPending} disabled={scan.isPending || status === 'queued' || status === 'running'} onClick={() => scan.mutate()}>
            {t('library.segments.scanSeason')}
          </Button>
        </>
      }
    >
      <p className="mk-muted" style={{ marginTop: 0 }}>
        {t('library.segments.help')}
      </p>
      {data ? (
        <p className="mk-muted" role="status" data-testid="segments-scan" style={{ fontSize: 13 }}>
          {status === 'failed' && data.scan.error
            ? t('library.segments.scanFailed', { error: data.scan.error })
            : t(`library.segments.status.${status ?? 'never'}`, { date: data.scan.scannedAt ? new Date(data.scan.scannedAt).toLocaleString() : '' })}
        </p>
      ) : null}
      {season.isError ? (
        <ErrorBlock title={t('library.segments.couldNotLoad')} onRetry={() => void season.refetch()}>
          {errorMessage(season.error)}
        </ErrorBlock>
      ) : !data ? (
        <Skeleton lines={4} />
      ) : episodes.length === 0 ? (
        <p>{t('library.segments.noFiles')}</p>
      ) : (
        <ul style={css.list}>
          {episodes.map((row) => (
            <EpisodeRow key={row.mediaFileId} row={row} seriesId={seriesId} seasonNumber={seasonNumber} />
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** The season-header action: "Intro & credits" opens the dialog. */
export function SeasonSegmentsAction({ seriesId, seasonNumber, title }: { seriesId: number; seasonNumber: number; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="mk-action-link" aria-label={t('library.segments.openLabel', { title })} onClick={() => setOpen(true)}>
        {t('library.segments.open')}
      </button>
      {open ? <SegmentsDialog open onClose={() => setOpen(false)} seriesId={seriesId} seasonNumber={seasonNumber} title={title} /> : null}
    </>
  );
}
