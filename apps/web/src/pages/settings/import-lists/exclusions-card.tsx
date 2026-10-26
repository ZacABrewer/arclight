import { useState, type FormEvent } from 'react';
import type { ImportListExclusion, MediaType } from '@arclight/shared';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Input, Select } from '../../../components/form.js';
import { Table, type Column } from '../../../components/table.js';
import { useAddImportListExclusion, useDeleteImportListExclusion, useImportListExclusions } from '../../../hooks/import-lists.js';
import { SaveError } from '../shared.js';

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
    { key: 'year', header: 'Year', sortValue: (x) => x.year ?? null, cell: (x) => x.year ?? '—', width: '70px' },
    { key: 'type', header: 'Type', sortValue: (x) => x.mediaType, cell: (x) => (x.mediaType === 'series' ? 'Series' : 'Movie'), width: '80px' },
    { key: 'tmdb', header: 'TMDB id', sortValue: (x) => x.tmdbId, cell: (x) => x.tmdbId, width: '100px' },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (x) => (
        <Button size="sm" variant="ghost" aria-label={`Remove ${x.title}`} onClick={() => remove.mutate(x.id)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <Card title="List exclusions">
      {list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <Table caption="List exclusions" columns={columns} rows={list.data} loading={list.isPending} rowKey={(x) => x.id} sortable empty="No exclusions." />
      )}
      <form className="inline-form" onSubmit={submit} aria-label="Add exclusion">
        <Select
          aria-label="Exclusion type"
          value={mediaType}
          onChange={(e) => setMediaType(e.currentTarget.value as MediaType)}
          options={[
            { value: 'movie', label: 'Movie' },
            { value: 'series', label: 'Series' },
          ]}
        />
        <Input aria-label="TMDB id" inputMode="numeric" placeholder="TMDB id" value={tmdbId} onChange={(e) => setTmdbId(e.currentTarget.value)} />
        <Input aria-label="Exclusion title" placeholder="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <Input aria-label="Exclusion year" inputMode="numeric" placeholder="Year" value={year} onChange={(e) => setYear(e.currentTarget.value)} />
        <Button type="submit" disabled={!valid} loading={add.isPending}>
          Add exclusion
        </Button>
      </form>
      <SaveError error={add.error} />
    </Card>
  );
}
