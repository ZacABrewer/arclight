import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { PlayerTrack } from '@arclight/shared';
import { Button, ButtonGroup, Field, Icon, Input, Modal } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { useCreatePlaylist, useDeletePlaylist, useMovePlaylistEntry, usePlaylist, usePlaylists, useRemovePlaylistEntry, useRenamePlaylist } from './api.js';
import { PlaylistArt, PlaylistCard } from './cards.js';
import { DownloadButton } from './download.js';
import { lengthLabel, shuffled } from './format.js';
import { DetailsSkeleton, Empty, GridSkeleton, LoadError, PageTitle, ShuffleIcon, playerPaths, useNumericParam } from './kit.js';
import { MusicNav } from './music-nav.js';
import { usePlayerActions } from './player-hooks.js';
import { TrackList } from './tracks.js';

/** Name dialog for create and rename. */
function NameDialog({
  open,
  title,
  submitLabel,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  initial: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    // Reset the field each time the dialog opens.
    setLastOpen(open);
    if (open) setName(initial);
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form id="pb-name-form" onSubmit={submit}>
        <Field label={t('player.browse.playlist.name')} htmlFor="pb-playlist-name">
          <Input id="pb-playlist-name" value={name} maxLength={200} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </Field>
        <ButtonGroup className="pb-dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()} loading={busy}>
            {submitLabel}
          </Button>
        </ButtonGroup>
      </form>
    </Modal>
  );
}

function DeleteDialog({ open, name, busy, onClose, onConfirm }: { open: boolean; name: string; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const t = useT();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('player.browse.playlist.deleteTitle', { name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger-solid" loading={busy} onClick={onConfirm}>
            {t('player.browse.playlist.delete')}
          </Button>
        </>
      }
    >
      <p>{t('player.browse.playlist.deleteBody')}</p>
    </Modal>
  );
}

/** /player/music/playlists */
export function PlaylistsPage() {
  const t = useT();
  const q = usePlaylists();
  const create = useCreatePlaylist();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  return (
    <div className="pb-page">
      <PageTitle
        actions={
          <Button variant="primary" icon={<Icon name="plus" />} onClick={() => setCreating(true)}>
            {t('player.browse.playlist.new')}
          </Button>
        }
      >
        {t('player.browse.nav.playlists')}
      </PageTitle>
      <MusicNav />
      {q.isPending ? (
        <GridSkeleton count={6} label={t('player.browse.loading')} />
      ) : q.isError ? (
        <LoadError title={t('player.browse.playlist.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <Empty
          title={t('player.browse.playlist.emptyTitle')}
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('player.browse.playlist.new')}
            </Button>
          }
        >
          {t('player.browse.playlist.emptyBody')}
        </Empty>
      ) : (
        <ul className="pb-grid" aria-label={t('player.browse.playlist.yours')}>
          {q.data.map((p) => (
            <PlaylistCard key={p.id} playlist={p} />
          ))}
        </ul>
      )}
      <NameDialog
        open={creating}
        title={t('player.browse.playlist.new')}
        submitLabel={t('player.browse.playlist.create')}
        initial=""
        busy={create.isPending}
        onClose={() => setCreating(false)}
        onSubmit={(name) =>
          create.mutate(
            { name },
            {
              onSuccess: (p) => {
                setCreating(false);
                void navigate({ to: playerPaths.playlist(p.id) } as unknown as Parameters<typeof navigate>[0]);
              },
            },
          )
        }
      />
    </div>
  );
}

/** /player/music/playlist/$playlistId */
export function PlaylistPage() {
  const t = useT();
  const id = useNumericParam('playlistId');
  const q = usePlaylist(id);
  const player = usePlayerActions();
  const rename = useRenamePlaylist();
  const remove = useDeletePlaylist();
  const moveEntry = useMovePlaylistEntry();
  const removeEntry = useRemovePlaylistEntry();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);

  if (!Number.isFinite(id)) return <Empty title={t('player.browse.playlist.notFound')} />;
  if (q.isPending) return <DetailsSkeleton label={t('player.browse.loading')} />;
  if (q.isError) {
    return (
      <div className="pb-page">
        <LoadError title={t('player.browse.playlist.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  const list = q.data;
  const keys = list.tracks.map((tr) => tr.itemKey);
  const source = `playlist:${list.id}`;
  // Edits name entries, not track ids: the same song can be in a playlist twice.
  const entries = list.entryIds;
  const busy = moveEntry.isPending || removeEntry.isPending;
  const move = (index: number, by: -1 | 1) => {
    const entryId = entries[index];
    const anchor = entries[index + by];
    if (entryId === undefined || anchor === undefined) return;
    moveEntry.mutate({ id: list.id, entryId, to: by < 0 ? { beforeEntryId: anchor } : { afterEntryId: anchor } });
  };
  const removeAt = (index: number) => {
    const entryId = entries[index];
    if (entryId !== undefined) removeEntry.mutate({ id: list.id, entryId });
  };
  const rowActions = (track: PlayerTrack, index: number) => (
    <span className="pb-track__edit">
      <Button
        variant="ghost"
        className="pb-icon-btn"
        icon={<Icon name="arrowUp" />}
        aria-label={t('player.browse.playlist.moveUp', { title: track.title })}
        disabled={index === 0 || busy}
        onClick={() => move(index, -1)}
      />
      <Button
        variant="ghost"
        className="pb-icon-btn"
        icon={<Icon name="arrowDown" />}
        aria-label={t('player.browse.playlist.moveDown', { title: track.title })}
        disabled={index === entries.length - 1 || busy}
        onClick={() => move(index, 1)}
      />
      <Button
        variant="ghost"
        className="pb-icon-btn"
        icon={<Icon name="close" />}
        aria-label={t('player.browse.playlist.remove', { title: track.title })}
        disabled={busy}
        onClick={() => removeAt(index)}
      />
    </span>
  );

  return (
    <div className="pb-page">
      <section className="pb-hero" aria-labelledby="pb-playlist-title">
        <div className="pb-hero__art">
          <PlaylistArt urls={list.artworkUrls} />
        </div>
        <div className="pb-hero__body">
          <p className="pb-eyebrow">{t('player.browse.playlist.kind')}</p>
          <h1 className="pb-title" id="pb-playlist-title">
            {list.name}
          </h1>
          {list.description ? <p className="pb-overview">{list.description}</p> : null}
          <p className="pb-hero__meta">{t('player.browse.playlist.meta', { count: list.tracks.length, length: lengthLabel(list.durationMs) })}</p>
          <ButtonGroup className="pb-hero__actions">
            <Button variant="primary" icon={<Icon name="play" />} disabled={!keys.length} onClick={() => player.playItems(keys, { source })}>
              {t('player.browse.play')}
            </Button>
            <Button icon={<ShuffleIcon />} disabled={!keys.length} onClick={() => player.playItems(shuffled(keys), { source })}>
              {t('player.browse.shuffle')}
            </Button>
            <DownloadButton itemKeys={keys} />
            <Button variant="ghost" icon={<Icon name="edit" />} onClick={() => setDialog('rename')}>
              {t('player.browse.playlist.rename')}
            </Button>
            <Button variant="danger" icon={<Icon name="trash" />} onClick={() => setDialog('delete')}>
              {t('player.browse.playlist.delete')}
            </Button>
          </ButtonGroup>
        </div>
      </section>
      {list.tracks.length ? (
        <TrackList tracks={list.tracks} source={source} label={t('player.browse.playlist.tracks')} showAlbum rowActions={rowActions} />
      ) : (
        <Empty title={t('player.browse.playlist.noTracks')}>{t('player.browse.playlist.noTracksBody')}</Empty>
      )}
      <NameDialog
        open={dialog === 'rename'}
        title={t('player.browse.playlist.rename')}
        submitLabel={t('common.save')}
        initial={list.name}
        busy={rename.isPending}
        onClose={() => setDialog(null)}
        onSubmit={(name) => rename.mutate({ id: list.id, name }, { onSuccess: () => setDialog(null) })}
      />
      <DeleteDialog
        open={dialog === 'delete'}
        name={list.name}
        busy={remove.isPending}
        onClose={() => setDialog(null)}
        onConfirm={() =>
          remove.mutate(list.id, {
            onSuccess: () => {
              setDialog(null);
              void navigate({ to: playerPaths.playlists } as unknown as Parameters<typeof navigate>[0]);
            },
          })
        }
      />
    </div>
  );
}
