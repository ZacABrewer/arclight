import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Modal } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useT } from '../../../i18n/index.js';
import { useAddToPlaylist, useCreatePlaylist, usePlaylists } from './api.js';
import { Artwork, LoadError } from './kit.js';
import { lengthLabel } from './format.js';

/** Pick a playlist (or start a new one) for some tracks. Used from every track menu. */
export function AddToPlaylistDialog({ open, onClose, trackIds }: { open: boolean; onClose: () => void; trackIds: number[] }) {
  const t = useT();
  const toast = useToast();
  const lists = usePlaylists();
  const add = useAddToPlaylist();
  const create = useCreatePlaylist();
  const [name, setName] = useState('');

  const done = (playlistName: string) => {
    toast.push({ tone: 'ok', title: t('player.browse.playlist.added', { count: trackIds.length, name: playlistName }) });
    setName('');
    onClose();
  };

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate({ name: trimmed, trackIds }, { onSuccess: () => done(trimmed) });
  };

  return (
    <Modal open={open} onClose={onClose} title={t('player.browse.playlist.addTitle')} size={560}>
      {lists.isError ? (
        <LoadError title={t('player.browse.playlist.loadFailed')} error={lists.error} onRetry={() => void lists.refetch()} />
      ) : lists.isPending ? (
        <p className="pb-muted">{t('player.browse.loading')}</p>
      ) : lists.data.length === 0 ? (
        <p className="pb-muted">{t('player.browse.playlist.noneYet')}</p>
      ) : (
        <ul className="pb-pick" aria-label={t('player.browse.playlist.yours')}>
          {lists.data.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="pb-pick__item"
                disabled={add.isPending}
                onClick={() => add.mutate({ id: p.id, trackIds }, { onSuccess: () => done(p.name) })}
              >
                <Artwork src={p.artworkUrls[0]} alt="" size={44} />
                <span className="pb-pick__text">
                  <span className="pb-pick__name">{p.name}</span>
                  <span className="pb-muted">{t('player.browse.playlist.meta', { count: p.trackCount, length: lengthLabel(p.durationMs) })}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="pb-inline-form" onSubmit={onCreate}>
        <Field label={t('player.browse.playlist.newName')} htmlFor="pb-new-playlist">
          <Input id="pb-new-playlist" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Button type="submit" variant="primary" disabled={!name.trim()} loading={create.isPending}>
          {t('player.browse.playlist.createAndAdd')}
        </Button>
      </form>
    </Modal>
  );
}
