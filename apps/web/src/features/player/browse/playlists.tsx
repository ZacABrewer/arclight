import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { PlayerTrack } from '@arclight/shared';
import { Button, ButtonGroup, Field, Input, Modal } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { RdError, RdLoading } from '../redesign/pages/common.js';
import { useCreatePlaylist, useDeletePlaylist, useMovePlaylistEntry, usePlaylist, usePlaylists, useRemovePlaylistEntry, useRenamePlaylist } from './api.js';
import { PlaylistArt, PlaylistTile } from './cards.js';
import { DownloadButton } from './download.js';
import { lengthLabel, shuffled } from './format.js';
import { playerPaths, useNumericParam } from './kit.js';
import { MusicNav } from './music-nav.js';
import { usePlayerActions } from './player-hooks.js';
import { AudioDetail, AudioHead, AudioNotice, AudioPage, AudioSection, DetailAction, PrimaryAction } from './rd-audio.js';
import { AudioIcon } from './rd-icons.js';
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

/** /player/music/playlists: the head (New playlist beside the title), the chips, then the playlists as a tile grid. */
export function PlaylistsPage() {
  const t = useT();
  const q = usePlaylists();
  const create = useCreatePlaylist();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const newButton = (
    <button type="button" className="rd-btn rd-btn--primary" onClick={() => setCreating(true)}>
      <AudioIcon name="plus" size={18} />
      {t('player.browse.playlist.new')}
    </button>
  );

  return (
    <AudioPage>
      <AudioHead title={t('player.browse.nav.playlists')} actions={newButton}>
        <MusicNav />
      </AudioHead>
      <AudioSection>
        {q.isPending ? (
          <RdLoading />
        ) : q.isError ? (
          <RdError title={t('player.browse.playlist.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <AudioNotice
            title={t('player.browse.playlist.emptyTitle')}
            action={
              <button type="button" className="rd-btn rd-btn--primary" onClick={() => setCreating(true)}>
                {t('player.browse.playlist.new')}
              </button>
            }
          >
            {t('player.browse.playlist.emptyBody')}
          </AudioNotice>
        ) : (
          <ul className="rd-music-grid" aria-label={t('player.browse.playlist.yours')}>
            {q.data.map((p) => (
              <li key={p.id}>
                <PlaylistTile playlist={p} fill />
              </li>
            ))}
          </ul>
        )}
      </AudioSection>
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
    </AudioPage>
  );
}

/** A small icon button in a playlist track row (move up, move down, remove). */
function EditButton({ icon, label, disabled, onClick }: { icon: 'up' | 'down' | 'close'; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="rd-music-iconbtn" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <AudioIcon name={icon} size={18} />
    </button>
  );
}

/** /player/music/playlist/$playlistId: the title page (mosaic cover), then the editable track list. */
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

  if (!Number.isFinite(id)) {
    return (
      <AudioPage>
        <AudioNotice title={t('player.browse.playlist.notFound')} />
      </AudioPage>
    );
  }
  if (q.isPending) return <RdLoading />;
  if (q.isError) {
    return (
      <AudioPage>
        <RdError title={t('player.browse.playlist.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </AudioPage>
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
      <EditButton icon="up" label={t('player.browse.playlist.moveUp', { title: track.title })} disabled={index === 0 || busy} onClick={() => move(index, -1)} />
      <EditButton icon="down" label={t('player.browse.playlist.moveDown', { title: track.title })} disabled={index === entries.length - 1 || busy} onClick={() => move(index, 1)} />
      <EditButton icon="close" label={t('player.browse.playlist.remove', { title: track.title })} disabled={busy} onClick={() => removeAt(index)} />
    </span>
  );

  return (
    <AudioDetail
      kicker={t('player.browse.playlist.kind')}
      title={list.name}
      image={list.artworkUrls[0]}
      cover={<PlaylistArt name={list.name} urls={list.artworkUrls} className="rd-music-detail__cover" />}
      lines={
        <>
          <p className="rd-music-detail__meta">{t('player.browse.playlist.meta', { count: list.tracks.length, length: lengthLabel(list.durationMs) })}</p>
          {list.description ? <p className="rd-music-detail__blurb">{list.description}</p> : null}
        </>
      }
      primary={<PrimaryAction label={t('player.browse.play')} disabled={!keys.length} onClick={() => player.playItems(keys, { source })} />}
      actions={
        <>
          <DetailAction icon="shuffle" label={t('player.browse.shuffle')} disabled={!keys.length} onClick={() => player.playItems(shuffled(keys), { source })} />
          <DownloadButton itemKeys={keys} />
          <DetailAction icon="edit" label={t('player.browse.playlist.rename')} onClick={() => setDialog('rename')} />
          <DetailAction icon="trash" label={t('player.browse.playlist.delete')} danger onClick={() => setDialog('delete')} />
        </>
      }
    >
      {list.tracks.length ? (
        <TrackList tracks={list.tracks} source={source} label={t('player.browse.playlist.tracks')} showAlbum rowActions={rowActions} />
      ) : (
        <AudioNotice title={t('player.browse.playlist.noTracks')}>{t('player.browse.playlist.noTracksBody')}</AudioNotice>
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
    </AudioDetail>
  );
}
