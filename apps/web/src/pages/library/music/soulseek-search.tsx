import { useEffect, useId, useState } from 'react';
import type { SoulseekCandidate, SoulseekRejection } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, Input, Modal, Table, type Column } from '../../../arclight/index.js';
import { useAuth } from '../../../auth/auth-context.js';
import { formatBytes } from '../../../components/media/format.js';
import { Loading } from '../../../components/media/media-kit.js';
import { useSoulseekAuto, useSoulseekGrab, useSoulseekSearch, useSoulseekSettings } from '../../../hooks/soulseek.js';
import { t } from '../../../i18n/index.js';

// Album search through the user's slskd instance (POST /soulseek/search, /soulseek/grab,
// /soulseek/album/:id/auto). Admin-only, and only once Soulseek is on in Download Clients.

/** True when the signed-in admin has Soulseek switched on. */
export function useSoulseekAvailable(): boolean {
  const admin = useAuth().access.admin;
  const settings = useSoulseekSettings(admin);
  return admin && settings.data?.enabled === true;
}

export function soulseekRejectionLabel(r: SoulseekRejection): string {
  return t(`soulseek.rejection.${r}`);
}

/** The last path segment of a peer folder ("Music\\Artist - Album" → "Artist - Album"). */
export function folderName(directory: string): string {
  return directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;
}

export function SoulseekActions({ albumId, title }: { albumId: number; title: string }) {
  const [open, setOpen] = useState(false);
  const auto = useSoulseekAuto();
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('soulseek.searchSoulseek')}</Button>
      <Button variant="ghost" loading={auto.isPending} onClick={() => auto.mutate(albumId)}>
        {t('soulseek.autoGrab')}
      </Button>
      {open ? <SoulseekSearchModal albumId={albumId} title={title} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function SoulseekSearchModal({ albumId, title, onClose }: { albumId: number; title: string; onClose: () => void }) {
  const id = useId();
  const search = useSoulseekSearch();
  const grab = useSoulseekGrab();
  const [query, setQuery] = useState('');
  const run = (q?: string) => search.mutate(q ? { albumId, query: q } : { albumId });

  // Search once on open with the default "artist album" query.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => run(), [albumId]);
  useEffect(() => {
    if (search.data && !query) setQuery(search.data.query);
  }, [search.data, query]);

  const columns: Column<SoulseekCandidate>[] = [
    {
      key: 'folder',
      header: t('soulseek.folder'),
      sortValue: (c) => c.directory,
      cell: (c) => (
        <span title={c.directory}>
          {folderName(c.directory)}
          <span className="music-soulseek__peer">{c.username}</span>
        </span>
      ),
    },
    { key: 'quality', header: t('common.quality'), sortValue: (c) => c.score, cell: (c) => c.qualityName },
    {
      key: 'tracks',
      header: t('soulseek.tracks'),
      sortValue: (c) => c.matchedTracks,
      cell: (c) => `${c.matchedTracks} / ${c.totalTracks}`,
      mono: true,
      align: 'right',
    },
    { key: 'size', header: t('common.size'), sortValue: (c) => c.totalSize, cell: (c) => formatBytes(c.totalSize), mono: true, align: 'right' },
    {
      key: 'peer',
      header: t('soulseek.slot'),
      sortValue: (c) => (c.freeSlot ? -1 : c.queueLength),
      cell: (c) => (c.freeSlot ? <Chip tone="accent">{t('soulseek.freeSlot')}</Chip> : t('soulseek.queueLength', { count: c.queueLength })),
    },
    {
      key: 'status',
      header: t('common.status'),
      cell: (c) => (c.accepted ? <Chip tone="accent">{t('soulseek.accepted')}</Chip> : <span className="music-soulseek__rejections">{c.rejections.map(soulseekRejectionLabel).join(' · ')}</span>),
    },
    {
      key: 'grab',
      header: '',
      align: 'right',
      cell: (c) => (
        <Button
          size="sm"
          variant={c.accepted ? 'primary' : 'secondary'}
          loading={grab.isPending && grab.variables?.username === c.username && grab.variables.directory === c.directory}
          disabled={grab.isPending}
          aria-label={t('soulseek.grabFrom', { folder: folderName(c.directory), username: c.username })}
          onClick={() =>
            grab.mutate(
              { albumId, username: c.username, directory: c.directory, files: c.files.map((f) => ({ filename: f.filename, size: f.size })), qualityName: c.qualityName },
              { onSuccess: onClose },
            )
          }
        >
          {t('soulseek.grab')}
        </Button>
      ),
    },
  ];

  return (
    <Modal open onClose={onClose} title={t('soulseek.searchTitle', { title })} size={1100}>
      <form
        className="music-soulseek__query"
        onSubmit={(e) => {
          e.preventDefault();
          run(query.trim() || undefined);
        }}
      >
        <label className="al-label" htmlFor={`${id}-q`}>
          {t('soulseek.query')}
        </label>
        <Input id={`${id}-q`} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
        <Button type="submit" loading={search.isPending}>
          {t('common.search')}
        </Button>
      </form>
      {search.isPending ? (
        <Loading />
      ) : search.isError ? (
        <ErrorBlock title={t('soulseek.searchFailed')} onRetry={() => run(query.trim() || undefined)}>
          {errorMessage(search.error)}
        </ErrorBlock>
      ) : search.data && search.data.candidates.length === 0 ? (
        <EmptyState title={t('soulseek.noResults')}>{t('soulseek.noResultsBody')}</EmptyState>
      ) : search.data ? (
        <Table
          columns={columns}
          rows={search.data.candidates}
          rowKey={(c) => `${c.username}\u0000${c.directory}`}
          density="dense"
          defaultSort={{ key: 'quality', direction: 'desc' }}
          caption={t('soulseek.results')}
        />
      ) : null}
    </Modal>
  );
}
