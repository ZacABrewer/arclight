import { languageNames } from '../../lib/format.js';
import { useState } from 'react';
import type { AudioFile, MediaFile } from '@arclight/shared';
import { Button, EmptyState, Modal, Table, Tag, type Column } from '../../arclight/index.js';
import { formatBytes, formatDate, seasonLabel } from '../../components/media/format.js';
import { QualityLabel, QueryError } from '../../components/media/media-kit.js';
import { useDeleteMediaFile } from '../../hooks/library.js';
import { useAnalyzeMedia } from '../../hooks/media-analysis.js';
import { MediaFileRowActions } from '../../features/transcode/file-row-actions.js';
import { mediaBadges, mediaInfoSummary } from './media-info.js';
import { versionColumn } from './versions/versions-editor.js';
import { formatDuration } from './music/music-model.js';
import './media-files.css';
import { t } from '../../i18n/index.js';

/** Codec / resolution / HDR / audio badges for one file; "Not analyzed" until ffprobe has run. */
export function MediaInfoBadges({ file }: { file: Pick<MediaFile, 'mediaInfo'> }) {
  const badges = mediaBadges(file.mediaInfo);
  if (badges.length === 0) return <span className="al-caption">{file.mediaInfo ? t('library.mediaFilesTable.noStreamsFound') : t('library.mediaFilesTable.notAnalyzed')}</span>;
  return (
    <span className="al-media-badges" title={mediaInfoSummary(file.mediaInfo)}>
      {badges.map((b) => (
        <Tag key={b.kind} className="al-num" data-kind={b.kind}>
          {b.label}
        </Tag>
      ))}
    </span>
  );
}

export function MediaFilesTable({
  files,
  error,
  loading,
  mediaType,
  ownerId,
}: {
  files: MediaFile[] | undefined;
  error: unknown;
  loading: boolean;
  mediaType: 'series' | 'movie';
  ownerId: number;
}) {
  const del = useDeleteMediaFile();
  const analyze = useAnalyzeMedia();
  const [confirm, setConfirm] = useState<MediaFile | null>(null);

  if (error) return <QueryError error={error} title={t('library.mediaFilesTable.couldNotLoadFiles')} />;

  const columns: Column<MediaFile>[] = [
    { key: 'path', header: t('library.mediaFilesTable.relativePath'), sortValue: (f) => f.relativePath, cell: (f) => f.relativePath, mono: true },
    ...versionColumn(files, (f) => f.versionTag, t('common.version')),
    ...(mediaType === 'series'
      ? [{ key: 'season', header: t('common.season'), sortValue: (f: MediaFile) => f.seasonNumber, cell: (f: MediaFile) => (f.seasonNumber == null ? '—' : seasonLabel(f.seasonNumber)), muted: true }]
      : []),
    { key: 'quality', header: t('common.quality'), sortValue: (f) => f.quality.quality.weight, cell: (f) => <QualityLabel quality={f.quality} /> },
    { key: 'mediainfo', header: t('library.mediaFilesTable.mediaInfo'), cell: (f) => <MediaInfoBadges file={f} /> },
    { key: 'languages', header: t('common.languages'), cell: (f) => languageNames(f.languages), mono: false },
    { key: 'group', header: t('common.group'), cell: (f) => f.releaseGroup ?? '—', muted: true },
    { key: 'size', header: t('common.size'), sortValue: (f) => f.sizeBytes, cell: (f) => formatBytes(f.sizeBytes), align: 'right', mono: true },
    { key: 'added', header: t('common.added'), sortValue: (f) => f.dateAdded, cell: (f) => formatDate(f.dateAdded), mono: true },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      cell: (f) => (
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <MediaFileRowActions file={f} />
          <Button size="sm" variant="danger" aria-label={t('library.mediaFilesTable.deleteRelativepath', { relativePath: f.relativePath })} onClick={() => setConfirm(f)}>
            {t('common.delete')}
          </Button>
        </span>
      ),
      align: 'right',
    },
  ];

  return (
    <>
      <div className="al-media-files__bar">
        <span className="al-caption">{t('library.mediaFilesTable.mediaInfoComesFromFfprobe')}</span>
        <Button
          size="sm"
          variant="secondary"
          loading={analyze.isPending}
          disabled={!files || files.length === 0}
          onClick={() => analyze.mutate(mediaType === 'series' ? { seriesId: ownerId } : { movieId: ownerId })}
        >
          {t('library.mediaFilesTable.analyze')}
        </Button>
      </div>
      <Table
        columns={columns}
        rows={files}
        loading={loading}
        rowKey={(f) => f.id}
        density="dense"
        defaultSort={{ key: 'path', direction: 'asc' }}
        empty={<EmptyState title={t('library.mediaFilesTable.noFilesOnDisk')}>{t('library.mediaFilesTable.searchOrImportToAdd')}</EmptyState>}
        caption={t('library.mediaFilesTable.mediaFiles')}
      />
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t('library.mediaFilesTable.deleteFile')}
        size={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() => confirm && del.mutate({ fileId: confirm.id, mediaType, ownerId }, { onSuccess: () => setConfirm(null) })}
            >
              {t('library.mediaFilesTable.deleteFile2')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          <span className="al-num">{confirm?.relativePath}</span> {t('library.mediaFilesTable.bytesWillBeDeletedFrom', { bytes: formatBytes(confirm?.sizeBytes) })}
        </p>
      </Modal>
    </>
  );
}

/** "FLAC · 24-bit · 96 kHz · 2 ch" / "MP3 · 320 kbps" badges for one audio file. */
export function audioBadges(f: Pick<AudioFile, 'codec' | 'bitrateKbps' | 'sampleRateHz' | 'bitDepth' | 'channels'>): Array<{ kind: string; label: string }> {
  const out: Array<{ kind: string; label: string }> = [];
  if (f.codec) out.push({ kind: 'codec', label: f.codec });
  if (f.bitDepth) out.push({ kind: 'depth', label: `${f.bitDepth}-bit` });
  if (f.sampleRateHz) out.push({ kind: 'rate', label: `${Number((f.sampleRateHz / 1000).toFixed(1))} kHz` });
  if (f.bitrateKbps && !f.bitDepth) out.push({ kind: 'bitrate', label: `${f.bitrateKbps} kbps` });
  if (f.channels) out.push({ kind: 'channels', label: `${f.channels} ch` });
  return out;
}

/** Audio variant of the files table (music and audiobooks): tags and stream details instead of ffprobe video info. */
export function AudioFilesTable({ files, error, loading }: { files: AudioFile[] | undefined; error: unknown; loading: boolean }) {
  if (error) return <QueryError error={error} title={t('library.mediaFilesTable.couldNotLoadFiles')} />;
  const columns: Column<AudioFile>[] = [
    { key: 'path', header: t('library.mediaFilesTable.relativePath'), sortValue: (f) => f.relativePath, cell: (f) => f.relativePath, mono: true },
    {
      key: 'position',
      header: t('music.discTrack'),
      sortValue: (f) => (f.discNumber ?? 0) * 1000 + (f.trackNumber ?? 0),
      cell: (f) => (f.trackNumber == null ? '—' : `${f.discNumber ?? 1}-${String(f.trackNumber).padStart(2, '0')}`),
      mono: true,
      width: '84px',
    },
    { key: 'quality', header: t('common.quality'), sortValue: (f) => f.quality.quality.weight, cell: (f) => <QualityLabel quality={f.quality} /> },
    {
      key: 'audio',
      header: t('library.mediaFilesTable.mediaInfo'),
      cell: (f) => (
        <span className="al-media-badges">
          {audioBadges(f).map((b) => (
            <Tag key={b.kind} className="al-num" data-kind={b.kind}>
              {b.label}
            </Tag>
          ))}
        </span>
      ),
    },
    { key: 'duration', header: t('music.duration'), sortValue: (f) => f.durationMs ?? 0, cell: (f) => formatDuration(f.durationMs), mono: true, align: 'right' },
    { key: 'size', header: t('common.size'), sortValue: (f) => f.sizeBytes, cell: (f) => formatBytes(f.sizeBytes), align: 'right', mono: true },
    { key: 'added', header: t('common.added'), sortValue: (f) => f.dateAdded, cell: (f) => formatDate(f.dateAdded), mono: true },
  ];
  return (
    <Table
      columns={columns}
      rows={files}
      loading={loading}
      rowKey={(f) => f.id}
      density="dense"
      defaultSort={{ key: 'path', direction: 'asc' }}
      empty={<EmptyState title={t('library.mediaFilesTable.noFilesOnDisk')}>{t('music.rescanToFindFiles')}</EmptyState>}
      caption={t('library.mediaFilesTable.mediaFiles')}
    />
  );
}
