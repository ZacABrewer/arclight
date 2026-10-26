import { useState, type FormEvent } from 'react';
import type { ImportListExclusion, MediaType } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, Input, Select, Table, type Column } from '../../../arclight/index.js';
import { useAddImportListExclusion, useDeleteImportListExclusion, useImportListExclusions } from '../../../hooks/import-lists.js';
import { SaveError, SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

/** Titles import lists never add again (shared with the library's import exclusions). */
export function ExclusionsCard() {
  const list = useImportListExclusions();
  const add = useAddImportListExclusion();
  const remove = useDeleteImportListExclusion();
  const [mediaType, setMediaType] = useState<MediaType>('movie');
  const [tmdbId, setTmdbId] = useState('');
  const [title, setTitle] = useState('');
  const [year, setYear] = useState('');

  const id = Number(tmdbId);
  const valid = Number.isInteger(id) && id > 0 && title.trim() !== '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const y = Number(year);
    add.mutate(
      { mediaType, tmdbId: id, title: title.trim(), year: year.trim() && Number.isInteger(y) ? y : null },
      {
        onSuccess: () => {
          setTmdbId('');
          setTitle('');
          setYear('');
        },
      },
    );
  };

  const columns: Array<Column<ImportListExclusion>> = [
    { key: 'title', header: t('common.title'), sortValue: (x) => x.title, cell: (x) => x.title },
    { key: 'year', header: t('common.year'), sortValue: (x) => x.year ?? null, cell: (x) => x.year ?? '—', width: '80px', mono: true },
    { key: 'type', header: t('common.type'), sortValue: (x) => x.mediaType, cell: (x) => (x.mediaType === 'series' ? t('common.series') : t('common.movie')), width: '90px', muted: true },
    { key: 'tmdb', header: t('settings.importLists.exclusionsCard.tmdbId'), sortValue: (x) => x.tmdbId, cell: (x) => x.tmdbId, width: '110px', mono: true },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      width: '110px',
      cell: (x) => (
        <Button size="sm" variant="ghost" aria-label={t('settings.importLists.exclusionsCard.removeTitle', { title: x.title })} onClick={() => remove.mutate(x.id)}>
          {t('common.remove')}
        </Button>
      ),
    },
  ];

  return (
    <SettingsSection label={t('settings.importLists.exclusionsCard.listExclusions')} {...(list.data ? { count: list.data.length } : {})}>
      {list.isError ? (
        <ErrorBlock title={t('settings.importLists.exclusionsCard.couldNotLoadExclusions')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <Table
          caption={t('settings.importLists.exclusionsCard.listExclusions')}
          density="dense"
          columns={columns}
          rows={list.data}
          loading={list.isPending}
          rowKey={(x) => x.id}
          sortable
          empty={t('settings.importLists.exclusionsCard.noExclusionsTitlesYouExclude')}
        />
      )}
      <form className="al-inline-form" onSubmit={submit} aria-label={t('settings.importLists.exclusionsCard.addExclusion')}>
        <Select
          aria-label={t('settings.importLists.exclusionsCard.exclusionType')}
          value={mediaType}
          onChange={(e) => setMediaType(e.currentTarget.value as MediaType)}
          options={[
            { value: 'movie', label: t('common.movie') },
            { value: 'series', label: t('common.series') },
          ]}
        />
        <Input aria-label={t('settings.importLists.exclusionsCard.tmdbId')} mono inputMode="numeric" placeholder={t('settings.importLists.exclusionsCard.tmdbId')} value={tmdbId} onChange={(e) => setTmdbId(e.currentTarget.value)} />
        <Input aria-label={t('settings.importLists.exclusionsCard.exclusionTitle')} placeholder={t('common.title')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <Input aria-label={t('settings.importLists.exclusionsCard.exclusionYear')} mono inputMode="numeric" placeholder={t('common.year')} value={year} onChange={(e) => setYear(e.currentTarget.value)} />
        <Button type="submit" variant="secondary" disabled={!valid} loading={add.isPending}>
          {t('settings.importLists.exclusionsCard.addExclusion')}
        </Button>
      </form>
      <SaveError error={add.error} />
    </SettingsSection>
  );
}
