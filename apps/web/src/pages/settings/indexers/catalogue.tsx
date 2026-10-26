import { useMemo, useState } from 'react';
import type { IndexerDefinitionSummary, IndexerPrivacy, IndexerTemplate, ReleaseProtocol } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, ProtocolBadge, Select, Skeleton } from '../../../arclight/index.js';
import { useIndexerDefinitions, useReloadDefinitions } from '../../../hooks/indexers.js';
import { catalogueLanguages, EMPTY_CATALOGUE_FILTER, filterDefinitions, PRIVACY_LABELS, PRIVACY_TONES, type CatalogueFilter } from './definition-fields.js';
import './indexers.css';

/** One chooser row: name, privacy chip, protocol badge, then the description. */
export function DefinitionRow({ def, onPick }: { def: IndexerDefinitionSummary; onPick: (def: IndexerDefinitionSummary) => void }) {
  return (
    <li>
      <button type="button" className="al-chooser__row" onClick={() => onPick(def)} aria-label={`Add ${def.name}`}>
        <span className="al-chooser__head">
          <span className="al-chooser__name">{def.name}</span>
          <Chip tone={PRIVACY_TONES[def.privacy]} dot="none">
            {PRIVACY_LABELS[def.privacy]}
          </Chip>
          <ProtocolBadge protocol={def.protocol} />
          {def.tested ? null : (
            <Chip tone="muted" dot="none">
              Untested
            </Chip>
          )}
          {def.source === 'custom' ? (
            <Chip tone="default" dot="none">
              Custom
            </Chip>
          ) : null}
          {def.language ? <span className="al-chooser__lang">{def.language}</span> : null}
        </span>
        {def.description ? <span className="al-chooser__desc">{def.description}</span> : null}
      </button>
    </li>
  );
}

/** Generic Torznab / Newznab endpoints as chooser rows. */
export function TemplateList({ templates, onPick }: { templates: readonly IndexerTemplate[]; onPick: (t: IndexerTemplate) => void }) {
  if (templates.length === 0) return <EmptyState title="No endpoint types match">Try fewer words.</EmptyState>;
  return (
    <ul className="al-chooser__list" aria-label="Endpoint types">
      {templates.map((t) => (
        <li key={t.implementation}>
          <button type="button" className="al-chooser__row" onClick={() => onPick(t)} aria-label={`Add ${t.implementationName}`}>
            <span className="al-chooser__head">
              <span className="al-chooser__name">{t.implementationName}</span>
              <ProtocolBadge protocol={t.protocol} />
            </span>
            <span className="al-chooser__desc">
              Any {t.implementationName} endpoint: a URL and an API key ({t.protocol === 'torrent' ? 'Jackett, Prowlarr or a tracker API' : 'a usenet indexer API'}).
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Catalogue tab: site definitions filtered by the chooser's search text plus privacy, protocol and language. */
export function CatalogueList({ onPick, text = '' }: { onPick: (def: IndexerDefinitionSummary) => void; text?: string }) {
  const defs = useIndexerDefinitions();
  const reload = useReloadDefinitions();
  const [filter, setFilter] = useState<Omit<CatalogueFilter, 'text'>>(EMPTY_CATALOGUE_FILTER);
  const rows = useMemo(() => filterDefinitions(defs.data ?? [], { ...filter, text }), [defs.data, filter, text]);
  const languages = useMemo(() => catalogueLanguages(defs.data ?? []), [defs.data]);

  if (defs.isPending) return <Skeleton lines={4} />;
  if (defs.isError)
    return (
      <ErrorBlock title="Couldn't load the catalogue" onRetry={() => void defs.refetch()}>
        {errorMessage(defs.error)}
      </ErrorBlock>
    );

  return (
    <div className="al-chooser">
      <div className="al-chooser__filters">
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
          Reload definitions
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No definitions match">Try fewer words or another filter.</EmptyState>
      ) : (
        <ul className="al-chooser__list" aria-label="Definitions">
          {rows.map((d) => (
            <DefinitionRow key={d.id} def={d} onPick={onPick} />
          ))}
        </ul>
      )}
    </div>
  );
}
