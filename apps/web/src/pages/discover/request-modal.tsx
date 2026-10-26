import { useMemo, useState } from 'react';
import type { CreateRequest, TitleDetail, TitleSeason } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Checkbox, Field, FormRow, Modal, Select, Table, type Column } from '../../arclight/index.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import { useToast } from '../../components/toast.js';
import { seasonBlocker } from '../../features/requests/request-rules.js';
import { useQualityProfiles, useRootFolders } from '../../hooks/library.js';
import { useCreateRequest, useRequestsSettings } from '../../hooks/requests.js';
import { StatusLabelChip } from './discover-kit.js';
import { t } from '../../i18n/index.js';

export interface RequestModalProps {
  title: TitleDetail;
  open: boolean;
  onClose: () => void;
  /** Request the 4K track ("Request 4K" button). */
  is4k?: boolean;
}

export function seasonName(s: Pick<TitleSeason, 'seasonNumber' | 'name'>): string {
  return s.name ?? (s.seasonNumber === 0 ? t('common.specials') : t('discover.requestModal.seasonSeasonnumber', { seasonNumber: s.seasonNumber }));
}

/** Request dialog (Modal 560): season checklist table, quality target, root folder, tags. */
export function RequestModal({ title, open, onClose, is4k = false }: RequestModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={t('discover.requestModal.requestTitleValue', { title: title.title, value: is4k ? ' in 4K' : '' })} size={560}>
      {open ? <RequestForm title={title} onClose={onClose} is4k={is4k} /> : null}
    </Modal>
  );
}

function RequestForm({ title, onClose, is4k }: { title: TitleDetail; onClose: () => void; is4k: boolean }) {
  const settings = useRequestsSettings();
  const toast = useToast();
  const create = useCreateRequest();
  const rootFolders = useRootFolders();
  const profiles = useQualityProfiles();
  const isSeries = title.mediaType === 'series';
  const [selected, setSelected] = useState<number[]>([]);
  const [all, setAll] = useState(false);
  const [rootFolderPath, setRootFolderPath] = useState('');
  const [profileId, setProfileId] = useState('');
  const [tags, setTags] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const partial = settings.data?.partialRequestsEnabled ?? true;
  const specials = settings.data?.enableSpecialEpisodes ?? false;
  const seasons = useMemo(
    () => title.seasons.filter((s) => specials || s.seasonNumber > 0).sort((a, b) => a.seasonNumber - b.seasonNumber),
    [title.seasons, specials],
  );
  const requestable = seasons.filter((s) => seasonBlocker(s, is4k) === null).map((s) => s.seasonNumber);
  const allSelected = !partial || all;
  const chosen = allSelected ? requestable : selected.filter((n) => requestable.includes(n));
  const folders = (rootFolders.data ?? []).filter((f) => f.mediaType === (isSeries ? 'series' : 'movie'));

  const toggleSeason = (n: number) => {
    setAll(false);
    setSelected((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));
  };

  const submit = () => {
    if (isSeries && chosen.length === 0) {
      setError(t('discover.requestModal.pickAtLeastOneSeason'));
      return;
    }
    setError(null);
    const body: CreateRequest = {
      mediaType: title.mediaType,
      tmdbId: title.tmdbId,
      is4k,
      ...(isSeries ? { seasons: allSelected ? ('all' as const) : chosen } : {}),
      ...(title.canRequestAdvanced && rootFolderPath ? { rootFolderPath } : {}),
      ...(title.canRequestAdvanced && profileId ? { qualityProfileId: Number(profileId) } : {}),
      ...(title.canRequestAdvanced && tags.length ? { tags } : {}),
    };
    create.mutate(body, {
      onSuccess: (outcome) => {
        if (outcome.kind === 'accepted') toast.push({ tone: 'info', title: outcome.message });
        else toast.push({ tone: 'ok', title: outcome.request.status === 'pending' ? t('discover.requestModal.requestSentForApproval') : t('common.requestApproved'), message: title.title });
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const columns: Column<TitleSeason>[] = [
    {
      key: 'pick',
      header: <span className="al-sr-only">{t('common.request')}</span>,
      width: '40px',
      cell: (s) => {
        const blocker = seasonBlocker(s, is4k);
        return (
          <Checkbox
            aria-label={seasonName(s)}
            disabled={blocker !== null || !partial}
            checked={blocker === null && (allSelected || selected.includes(s.seasonNumber))}
            onChange={() => toggleSeason(s.seasonNumber)}
          />
        );
      },
    },
    { key: 'season', header: t('common.season'), cell: (s) => seasonName(s) },
    { key: 'episodes', header: t('common.episodes'), mono: true, align: 'right', cell: (s) => s.episodeCount },
    {
      key: 'status',
      header: t('common.status'),
      cell: (s) => {
        const blocker = seasonBlocker(s, is4k);
        return blocker ? <StatusLabelChip label={blocker} /> : <span className="mk-dim">—</span>;
      },
    },
  ];

  return (
    <form
      className="mk-stack-sm"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {isSeries ? (
        <>
          {partial ? (
            <Checkbox
              label={t('discover.requestModal.allSeasons')}
              aria-label={t('discover.requestModal.allSeasons')}
              checked={all}
              disabled={requestable.length === 0}
              onChange={(e) => {
                setAll(e.currentTarget.checked);
                if (!e.currentTarget.checked) setSelected([]);
              }}
            />
          ) : (
            <p className="al-caption" style={{ margin: 0 }}>
              {t('discover.requestModal.seriesRequestsCoverEverySeason')}
            </p>
          )}
          <Table columns={columns} rows={seasons} rowKey={(s) => s.seasonNumber} sortable={false} caption={t('common.seasons')} maxHeight={320} empty={<span className="al-caption">{t('discover.requestModal.noSeasonInformationOnTmdb')}</span>} />
        </>
      ) : null}

      {title.canRequestAdvanced ? (
        <div className="mk-stack-sm" data-testid="request-advanced">
          <FormRow label={t('common.qualityTarget')} htmlFor="request-profile">
            <Select id="request-profile" value={profileId} onChange={(e) => setProfileId(e.currentTarget.value)}>
              <option value="">{t('common.defaultProfile')}</option>
              {(profiles.data ?? []).map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormRow>
          <FormRow label={t('common.rootFolder')} htmlFor="request-root">
            <Select id="request-root" value={rootFolderPath} onChange={(e) => setRootFolderPath(e.currentTarget.value)}>
              <option value="">{t('common.defaultFolder')}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.path}>
                  {f.path}
                </option>
              ))}
            </Select>
          </FormRow>
          <Field label={t('common.tags')}>
            <div>
              <TagPicker value={tags} onChange={setTags} />
            </div>
          </Field>
        </div>
      ) : null}

      {error ? (
        <p className="al-field__error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      <div className="mk-row mk-row--end">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {isSeries && !allSelected ? t('discover.requestModal.requestSeasons', { chosenCount: chosen.length }) : is4k ? t('discover.requestModal.request4k') : t('common.request')}
        </Button>
      </div>
    </form>
  );
}
