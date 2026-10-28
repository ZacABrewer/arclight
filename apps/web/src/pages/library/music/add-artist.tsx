import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { AlbumTypeProfile, ArtistSearchResult, MonitorNewAlbums, MusicMonitorOption, QualityProfile, RootFolder } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, FormRow, Modal, Select, Toggle, buttonClass } from '../../../arclight/index.js';
import { FolderPickerModal } from '../../../components/media/folder-picker-modal.js';
import { Loading } from '../../../components/media/media-kit.js';
import { TagPicker } from '../../../components/media/tag-picker.js';
import { useToast } from '../../../components/toast.js';
import { useRootFolders } from '../../../hooks/library.js';
import { useAddArtist, useAlbumTypeProfiles, useArtistLookup, useMusicQualityProfiles } from '../../../hooks/music.js';
import { useAddRootFolder } from '../../../hooks/settings.js';
import { loadDefaults, saveDefaults } from '../add-dialog.js';
import { SquareArt } from './music-kit.js';
import { MONITOR_OPTIONS, NEW_ALBUM_OPTIONS, artistFolder, artistImage, monitorNewAlbumsLabel, monitorOptionLabel } from './music-model.js';
import '../library.css';
import './music.css';
import { t } from '../../../i18n/index.js';

/** "Group · GB · 1985 – 2019" for a search result. */
export function artistResultMeta(r: Pick<ArtistSearchResult, 'artistType' | 'country' | 'beginDate' | 'endDate' | 'ended'>): string {
  const begin = r.beginDate?.slice(0, 4);
  const end = r.endDate?.slice(0, 4);
  const span = begin ? (end ? `${begin} – ${end}` : r.ended ? `${begin} – ?` : `${begin} –`) : null;
  return [r.artistType, r.country, span].filter(Boolean).join(' · ');
}

/**
 * Music tab of Add New: search MusicBrainz for `term` (debounced by the page), then add an
 * artist with a root folder, a music quality profile, an album-type profile and monitoring.
 */
export function AddArtistResults({ term }: { term: string }) {
  const search = useArtistLookup(term);
  const [adding, setAdding] = useState<ArtistSearchResult | null>(null);
  const active = term.trim().length >= 2;

  return (
    <>
      {!active ? (
        <EmptyState title={t('music.add.typeAnArtist')}>{t('music.add.resultsComeFromMusicBrainz')}</EmptyState>
      ) : search.isError ? (
        <ErrorBlock title={t('music.add.searchFailed')} onRetry={() => void search.refetch()} retryLabel={t('library.addNew.tryAgain')}>
          {errorMessage(search.error)}
        </ErrorBlock>
      ) : search.isPending ? (
        <Loading label={t('library.addNew.searching')} />
      ) : search.data.length === 0 ? (
        <EmptyState title={t('library.addNew.noResultsForDebounced', { debounced: term.trim() })}>{t('library.addNew.checkTheSpellingOrTry')}</EmptyState>
      ) : (
        <div role="list" aria-label={t('common.searchResults')}>
          {search.data.map((r) => (
            <ArtistResultRow key={r.mbArtistId} result={r} onAdd={() => setAdding(r)} />
          ))}
        </div>
      )}
      <AddArtistDialog result={adding} onClose={() => setAdding(null)} />
    </>
  );
}

function ArtistResultRow({ result, onAdd }: { result: ArtistSearchResult; onAdd: () => void }) {
  const inLibrary = result.artistId != null;
  const meta = artistResultMeta(result);
  return (
    <article className="mk-result" role="listitem" aria-label={result.name}>
      <SquareArt src={artistImage(result)} title={result.name} />
      <div style={{ minWidth: 0 }}>
        <h2 className="mk-result__title">
          {result.name}
          {result.disambiguation ? <span className="mk-muted" style={{ fontSize: 14, fontWeight: 400 }}>({result.disambiguation})</span> : null}
          {inLibrary ? <Chip tone="accent">{t('common.inLibrary')}</Chip> : null}
        </h2>
        {meta ? <div className="music-result__meta">{meta}</div> : null}
        {result.genres.length ? (
          <div className="music-result__genres">
            {result.genres.slice(0, 5).map((g) => (
              <Chip key={g} tone="muted" dot="none">
                {g}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>
      <div>
        {inLibrary ? (
          <Link className={buttonClass({ variant: 'ghost', size: 'sm' })} to="/library/music/artist/$id" params={{ id: String(result.artistId) }}>
            {t('common.open')}
          </Link>
        ) : (
          <Button size="sm" variant="secondary" aria-label={t('library.addNew.addTitle', { title: result.name })} onClick={onAdd}>
            {t('common.add')}
          </Button>
        )}
      </div>
    </article>
  );
}

export function AddArtistDialog({ result, onClose }: { result: ArtistSearchResult | null; onClose: () => void }) {
  const rootFolders = useRootFolders();
  const profiles = useMusicQualityProfiles(result !== null);
  const typeProfiles = useAlbumTypeProfiles(result !== null);
  return (
    <Modal open={result !== null} onClose={onClose} title={result ? t('library.addDialog.addTitle', { title: result.name }) : t('common.add')} size={560}>
      {result ? (
        <AddArtistForm
          key={result.mbArtistId}
          result={result}
          onClose={onClose}
          rootFolders={(rootFolders.data ?? []).filter((r) => r.mediaType === 'music')}
          profiles={profiles.data ?? []}
          typeProfiles={typeProfiles.data ?? []}
        />
      ) : null}
    </Modal>
  );
}

interface ArtistFormState {
  rootFolderPath: string;
  qualityProfileId: number | null;
  albumTypeProfileId: number | null;
  monitorOption: MusicMonitorOption;
  monitorNewAlbums: MonitorNewAlbums;
  tags: number[];
  searchOnAdd: boolean;
}

function initialState(rootFolders: readonly RootFolder[], profiles: readonly QualityProfile[], typeProfiles: readonly AlbumTypeProfile[]): ArtistFormState {
  const d = loadDefaults('music');
  const root = rootFolders.find((r) => r.path === d.rootFolderPath) ?? rootFolders[0];
  const profile = profiles.find((p) => p.id === d.qualityProfileId) ?? profiles[0];
  const types = typeProfiles.find((p) => p.isDefault) ?? typeProfiles[0];
  return {
    rootFolderPath: root?.path ?? '',
    qualityProfileId: profile?.id ?? null,
    albumTypeProfileId: types?.id ?? null,
    monitorOption: 'all',
    monitorNewAlbums: 'all',
    tags: [],
    searchOnAdd: false,
  };
}

function AddArtistForm({
  result,
  onClose,
  rootFolders,
  profiles,
  typeProfiles,
}: {
  result: ArtistSearchResult;
  onClose: () => void;
  rootFolders: RootFolder[];
  profiles: QualityProfile[];
  typeProfiles: AlbumTypeProfile[];
}) {
  const [form, setForm] = useState<ArtistFormState>(() => initialState(rootFolders, profiles, typeProfiles));
  const [touched, setTouched] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const add = useAddArtist();
  const addRoot = useAddRootFolder();
  const toast = useToast();
  const navigate = useNavigate();
  const ids = useId();
  const fid = (k: string) => `${ids}-${k}`;
  const set = <K extends keyof ArtistFormState>(key: K, value: ArtistFormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Root folders and profiles can arrive after the dialog opened.
  useEffect(() => {
    setForm((f) => {
      const init = initialState(rootFolders, profiles, typeProfiles);
      return {
        ...f,
        rootFolderPath: f.rootFolderPath || init.rootFolderPath,
        qualityProfileId: f.qualityProfileId ?? init.qualityProfileId,
        albumTypeProfileId: f.albumTypeProfileId ?? init.albumTypeProfileId,
      };
    });
  }, [rootFolders, profiles, typeProfiles]);

  const errors = {
    rootFolderPath: form.rootFolderPath ? undefined : t('music.add.chooseAMusicRootFolder'),
    qualityProfileId: form.qualityProfileId === null ? t('library.addForm.chooseAQualityProfile') : undefined,
  };
  const valid = !errors.rootFolderPath && !errors.qualityProfileId;

  const submit = () => {
    setTouched(true);
    if (!valid || form.qualityProfileId === null) return;
    saveDefaults('music', { rootFolderPath: form.rootFolderPath, qualityProfileId: form.qualityProfileId });
    add.mutate(
      {
        mbArtistId: result.mbArtistId,
        rootFolderPath: form.rootFolderPath,
        qualityProfileId: form.qualityProfileId,
        ...(form.albumTypeProfileId !== null ? { albumTypeProfileId: form.albumTypeProfileId } : {}),
        monitored: form.monitorOption !== 'none',
        monitorOption: form.monitorOption,
        monitorNewAlbums: form.monitorNewAlbums,
        tags: form.tags,
        searchOnAdd: form.searchOnAdd,
      },
      {
        onSuccess: (artist) => {
          toast.push({ tone: 'ok', title: t('library.addDialog.addedTitle', { title: artist.name }), message: t('music.add.albumsLoadInTheBackground') });
          onClose();
          void navigate({ to: '/library/music/artist/$id', params: { id: String(artist.id) } });
        },
      },
    );
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
        <SquareArt src={artistImage(result)} title={result.name} />
        <div style={{ minWidth: 0 }}>
          <div className="mk-result__title">{result.name}</div>
          {result.disambiguation ? <div className="mk-result__meta">{result.disambiguation}</div> : null}
          <div className="mk-result__meta">{artistResultMeta(result)}</div>
        </div>
      </div>

      <FormRow
        label={t('common.rootFolder')}
        htmlFor={fid('root')}
        error={touched ? errors.rootFolderPath : undefined}
        caption={rootFolders.length === 0 ? t('music.add.noMusicRootFolderYet') : undefined}
      >
        <div className="mk-row" style={{ flexWrap: 'nowrap' }}>
          <Select id={fid('root')} value={form.rootFolderPath} onChange={(e) => set('rootFolderPath', e.target.value)} style={{ flex: 1 }}>
            <option value="">{t('library.addDialog.selectARootFolder')}</option>
            {rootFolders.map((r) => (
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

      <FormRow label={t('common.qualityProfile')} htmlFor={fid('profile')} error={touched ? errors.qualityProfileId : undefined} caption={t('music.add.musicProfilesOnly')}>
        <Select id={fid('profile')} value={form.qualityProfileId?.toString() ?? ''} onChange={(e) => set('qualityProfileId', e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t('library.addDialog.selectAProfile')}</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormRow>

      <FormRow label={t('music.albumTypeProfile')} htmlFor={fid('types')} caption={t('music.add.albumTypeProfileCaption')}>
        <Select id={fid('types')} value={form.albumTypeProfileId?.toString() ?? ''} onChange={(e) => set('albumTypeProfileId', e.target.value ? Number(e.target.value) : null)}>
          {typeProfiles.length === 0 ? <option value="">{t('music.add.serverDefault')}</option> : null}
          {typeProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormRow>

      <FormRow label={t('common.monitor')} htmlFor={fid('monitor')}>
        <Select id={fid('monitor')} value={form.monitorOption} onChange={(e) => set('monitorOption', e.target.value as MusicMonitorOption)}>
          {MONITOR_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {monitorOptionLabel(v)}
            </option>
          ))}
        </Select>
      </FormRow>

      <FormRow label={t('music.monitorNewAlbumsLabel')} htmlFor={fid('new')}>
        <Select id={fid('new')} value={form.monitorNewAlbums} onChange={(e) => set('monitorNewAlbums', e.target.value as MonitorNewAlbums)}>
          {NEW_ALBUM_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {monitorNewAlbumsLabel(v)}
            </option>
          ))}
        </Select>
      </FormRow>

      <FormRow label={t('common.tags')}>
        <TagPicker value={form.tags} onChange={(tags) => set('tags', tags)} />
      </FormRow>

      <FormRow label={t('common.searchOnAdd')} htmlFor={fid('search')} captionInline caption={t('music.add.searchOnAddCaption')}>
        <Toggle id={fid('search')} checked={form.searchOnAdd} onChange={(e) => set('searchOnAdd', e.currentTarget.checked)} />
      </FormRow>

      <FormRow label={t('library.addDialog.destination')}>
        <div className="lib-path-preview" data-testid="path-preview">
          {artistFolder(form.rootFolderPath, result.name) || t('library.addDialog.chooseARootFolderTo')}
        </div>
      </FormRow>

      {add.isError ? (
        <p className="al-field__error" role="alert" style={{ margin: 0 }}>
          {errorMessage(add.error)}
        </p>
      ) : null}

      <div className="lib-form-foot">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={add.isPending} disabled={touched && !valid}>
          {t('music.addArtist')}
        </Button>
      </div>
      <FolderPickerModal
        open={browsing}
        onClose={() => setBrowsing(false)}
        title={t('common.chooseARootFolder')}
        initialPath={form.rootFolderPath}
        onSelect={(path) => {
          setBrowsing(false);
          if (rootFolders.some((r) => r.path === path)) {
            set('rootFolderPath', path);
            return;
          }
          addRoot.mutate({ path, mediaType: 'music' }, { onSuccess: (root) => set('rootFolderPath', root.path) });
        }}
      />
    </form>
  );
}
