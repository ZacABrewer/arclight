import { useState, type FormEvent } from 'react';
import type { ImportListExclusion, MediaType } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, Input, Select, Table, type Column } from '../../../arclight/index.js';
import { useAddImportListExclusion, useDeleteImportListExclusion, useImportListExclusions } from '../../../hooks/import-lists.js';
import { SaveError, SettingsSection } from '../shared.js';

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
    { key: 'title', header: 'Title', sortValue: (x) => x.title, cell: (x) => x.title },
    { key: 'year', header: 'Year', sortValue: (x) => x.year ?? null, cell: (x) => x.year ?? '—', width: '80px', mono: true },
    { key: 'type', header: 'Type', sortValue: (x) => x.mediaType, cell: (x) => (x.mediaType === 'series' ? 'Series' : 'Movie'), width: '90px', muted: true },
    { key: 'tmdb', header: 'TMDB id', sortValue: (x) => x.tmdbId, cell: (x) => x.tmdbId, width: '110px', mono: true },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      width: '110px',
      cell: (x) => (
        <Button size="sm" variant="ghost" aria-label={`Remove ${x.title}`} onClick={() => remove.mutate(x.id)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <SettingsSection label="List exclusions" {...(list.data ? { count: list.data.length } : {})}>
      {list.isError ? (
        <ErrorBlock title="Could not load exclusions" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <Table
          caption="List exclusions"
          density="dense"
          columns={columns}
          rows={list.data}
          loading={list.isPending}
          rowKey={(x) => x.id}
          sortable
          empty="No exclusions. Titles you exclude are never added by a list."
        />
      )}
      <form className="al-inline-form" onSubmit={submit} aria-label="Add exclusion">
        <Select
          aria-label="Exclusion type"
          value={mediaType}
          onChange={(e) => setMediaType(e.currentTarget.value as MediaType)}
          options={[
            { value: 'movie', label: 'Movie' },
            { value: 'series', label: 'Series' },
          ]}
        />
        <Input aria-label="TMDB id" mono inputMode="numeric" placeholder="TMDB id" value={tmdbId} onChange={(e) => setTmdbId(e.currentTarget.value)} />
        <Input aria-label="Exclusion title" placeholder="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <Input aria-label="Exclusion year" mono inputMode="numeric" placeholder="Year" value={year} onChange={(e) => setYear(e.currentTarget.value)} />
        <Button type="submit" variant="secondary" disabled={!valid} loading={add.isPending}>
          Add exclusion
        </Button>
      </form>
      <SaveError error={add.error} />
    </SettingsSection>
  );
}
