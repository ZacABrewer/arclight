import { useMemo, useState } from 'react';
import type { IndexerDefinitionSummary, IndexerPrivacy, ReleaseProtocol } from '@arclight/shared';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { EmptyState } from '../../../components/empty-state.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Input, Select } from '../../../components/form.js';
import { ProtocolBadge } from '../../../components/protocol-badge.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useIndexerDefinitions, useReloadDefinitions } from '../../../hooks/indexers.js';
import { catalogueLanguages, EMPTY_CATALOGUE_FILTER, filterDefinitions, PRIVACY_TONES, type CatalogueFilter } from './definition-fields.js';

/** Searchable list of site definitions; picking one opens the editor. */
export function CatalogueList({ onPick }: { onPick: (def: IndexerDefinitionSummary) => void }) {
  const defs = useIndexerDefinitions();
  const reload = useReloadDefinitions();
  const [filter, setFilter] = useState<CatalogueFilter>(EMPTY_CATALOGUE_FILTER);
  const rows = useMemo(() => filterDefinitions(defs.data ?? [], filter), [defs.data, filter]);
  const languages = useMemo(() => catalogueLanguages(defs.data ?? []), [defs.data]);

  if (defs.isPending) return <LoadingBlock />;
  if (defs.isError) return <ErrorView error={defs.error} onRetry={() => void defs.refetch()} />;

  return (
    <div className="catalogue">
      <div className="row catalogue-filters">
        <Input
          aria-label="Search definitions"
          placeholder="Search by name, description, language"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.currentTarget.value })}
        />
        <Select
          aria-label="Privacy"
          value={filter.privacy}
          onChange={(e) => setFilter({ ...filter, privacy: e.currentTarget.value as IndexerPrivacy | 'all' })}
          options={[
            { value: 'all', label: 'Any privacy' },
            { value: 'public', label: 'Public' },
            { value: 'semi-private', label: 'Semi-private' },
            { value: 'private', label: 'Private' },
          ]}
        />
        <Select
          aria-label="Protocol"
          value={filter.protocol}
          onChange={(e) => setFilter({ ...filter, protocol: e.currentTarget.value as ReleaseProtocol | 'all' })}
          options={[
            { value: 'all', label: 'Any protocol' },
            { value: 'torrent', label: 'Torrent' },
            { value: 'usenet', label: 'Usenet' },
          ]}
        />
        <Select
          aria-label="Language"
          value={filter.language}
          onChange={(e) => setFilter({ ...filter, language: e.currentTarget.value })}
          options={[{ value: '', label: 'Any language' }, ...languages.map((l) => ({ value: l, label: l }))]}
        />
        <Button size="sm" variant="ghost" loading={reload.isPending} onClick={() => reload.mutate()}>
          Reload
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No definitions match">Try fewer words or another filter.</EmptyState>
      ) : (
        <ul className="catalogue-list" aria-label="Definitions">
          {rows.map((d) => (
            <li key={d.id}>
              <button type="button" className="catalogue-item link-button" onClick={() => onPick(d)} aria-label={`Add ${d.name}`}>
                <span className="catalogue-item-head">
                  <strong>{d.name}</strong>
                  <Badge tone={PRIVACY_TONES[d.privacy]}>{d.privacy}</Badge>
                  <ProtocolBadge protocol={d.protocol} />
                  {d.tested ? <Badge tone="ok">tested</Badge> : <Badge tone="neutral">untested</Badge>}
                  {d.source === 'custom' ? <Badge tone="info">custom</Badge> : null}
                  <span className="muted">{d.language}</span>
                </span>
                {d.description ? <span className="muted catalogue-item-desc">{d.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
