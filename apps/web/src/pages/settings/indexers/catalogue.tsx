import { useMemo, useState } from 'react';
import type { IndexerDefinitionSummary, IndexerPrivacy, IndexerTemplate, ReleaseProtocol } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, ProtocolBadge, Select, Skeleton, type ChipTone } from '../../../arclight/index.js';
import { useIndexerDefinitions, useIndexerProxies, useReloadDefinitions } from '../../../hooks/indexers.js';
import { hasSolverProxy } from '../indexer-proxies/proxy-model.js';
import { SolverHint } from './solver-hint.js';
import { definitionNeedsSolver, catalogueLanguages, EMPTY_CATALOGUE_FILTER, filterDefinitions, PRIVACY_LABELS, PRIVACY_TONES, type CatalogueFilter } from './definition-fields.js';
import './indexers.css';
import { t } from '../../../i18n/index.js';

type DefinitionSource = IndexerDefinitionSummary['source'];

/** Where a definition comes from: shipped, the definition feed, or the user's own YAML (wins). */
export const SOURCE_BADGES: Record<DefinitionSource, { label: string; tone: ChipTone; title: string }> = {
  builtin: { get label() { return t('settings.indexers.catalogue.builtIn'); }, tone: 'muted', get title() { return t('settings.indexers.catalogue.shippedWithArclight'); } },
  feed: { get label() { return t('common.feed'); }, tone: 'neutral', get title() { return t('settings.indexers.catalogue.downloadedFromTheDefinitionFeed'); } },
  custom: { get label() { return t('common.custom'); }, tone: 'default', get title() { return t('settings.indexers.catalogue.yourOwnDefinitionFileOverrides'); } },
};

export function SourceBadge({ source }: { source: DefinitionSource }) {
  const b = SOURCE_BADGES[source];
  return (
    <Chip tone={b.tone} dot="none" title={b.title} data-source={source}>
      {b.label}
    </Chip>
  );
}

/** One chooser row: name, privacy chip, protocol badge, source badge, then the description. */
export function DefinitionRow({ def, onPick, needsSolver = false }: { def: IndexerDefinitionSummary; onPick: (def: IndexerDefinitionSummary) => void; needsSolver?: boolean }) {
  return (
    <li>
      <button type="button" className="al-chooser__row" onClick={() => onPick(def)} aria-label={t('settings.indexers.catalogue.addName', { name: def.name })}>
        <span className="al-chooser__head">
          <span className="al-chooser__name">{def.name}</span>
          <Chip tone={PRIVACY_TONES[def.privacy]} dot="none">
            {PRIVACY_LABELS[def.privacy]}
          </Chip>
          <ProtocolBadge protocol={def.protocol} />
          <SourceBadge source={def.source} />
          {def.tested ? null : (
            <Chip tone="muted" dot="none">
              {t('settings.indexers.catalogue.untested')}
            </Chip>
          )}
          {def.language ? <span className="al-chooser__lang">{def.language}</span> : null}
        </span>
        {def.description ? <span className="al-chooser__desc">{def.description}</span> : null}
      </button>
      {needsSolver ? <SolverHint /> : null}
    </li>
  );
}

/** Generic Torznab / Newznab endpoints as chooser rows. */
export function TemplateList({ templates, onPick }: { templates: readonly IndexerTemplate[]; onPick: (item: IndexerTemplate) => void }) {
  if (templates.length === 0) return <EmptyState title={t('settings.indexers.catalogue.noEndpointTypesMatch')}>{t('settings.indexers.catalogue.tryFewerWords')}</EmptyState>;
  return (
    <ul className="al-chooser__list" aria-label={t('settings.indexers.catalogue.endpointTypes')}>
      {templates.map((entry) => (
        <li key={entry.implementation}>
          <button type="button" className="al-chooser__row" onClick={() => onPick(entry)} aria-label={t('settings.indexers.catalogue.addImplementationname', { implementationName: entry.implementationName })}>
            <span className="al-chooser__head">
              <span className="al-chooser__name">{entry.implementationName}</span>
              <ProtocolBadge protocol={entry.protocol} />
            </span>
            <span className="al-chooser__desc">
              {t('settings.indexers.catalogue.anyImplementationnameEndpointAUrl', { implementationName: entry.implementationName, value: entry.protocol === 'torrent' ? t('settings.indexers.catalogue.jackettProwlarrOrATracker') : t('settings.indexers.catalogue.aUsenetIndexerApi') })}
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
  const proxies = useIndexerProxies();
  // Only hint once we know no FlareSolverr-type proxy exists.
  const missingSolver = proxies.isSuccess && !hasSolverProxy(proxies.data);
  const [filter, setFilter] = useState<Omit<CatalogueFilter, 'text'>>(EMPTY_CATALOGUE_FILTER);
  const rows = useMemo(() => filterDefinitions(defs.data ?? [], { ...filter, text }), [defs.data, filter, text]);
  const languages = useMemo(() => catalogueLanguages(defs.data ?? []), [defs.data]);

  if (defs.isPending) return <Skeleton lines={4} />;
  if (defs.isError)
    return (
      <ErrorBlock title={t('settings.indexers.catalogue.couldntLoadTheCatalogue')} onRetry={() => void defs.refetch()}>
        {errorMessage(defs.error)}
      </ErrorBlock>
    );

  return (
    <div className="al-chooser">
      <div className="al-chooser__filters">
        <Select
          aria-label={t('settings.indexers.catalogue.privacy')}
          value={filter.privacy}
          onChange={(e) => setFilter({ ...filter, privacy: e.currentTarget.value as IndexerPrivacy | 'all' })}
          options={[
            { value: 'all', label: t('settings.indexers.catalogue.anyPrivacy') },
            { value: 'public', label: t('settings.indexers.catalogue.public') },
            { value: 'semi-private', label: t('settings.indexers.catalogue.semiPrivate') },
            { value: 'private', label: t('common.private') },
          ]}
        />
        <Select
          aria-label={t('common.protocol')}
          value={filter.protocol}
          onChange={(e) => setFilter({ ...filter, protocol: e.currentTarget.value as ReleaseProtocol | 'all' })}
          options={[
            { value: 'all', label: t('settings.indexers.catalogue.anyProtocol') },
            { value: 'torrent', label: t('common.torrent') },
            { value: 'usenet', label: t('common.usenet') },
          ]}
        />
        <Select
          aria-label={t('common.language')}
          value={filter.language}
          onChange={(e) => setFilter({ ...filter, language: e.currentTarget.value })}
          options={[{ value: '', label: t('settings.indexers.catalogue.anyLanguage') }, ...languages.map((l) => ({ value: l, label: l }))]}
        />
        <Button size="sm" variant="ghost" loading={reload.isPending} onClick={() => reload.mutate()}>
          {t('settings.indexers.catalogue.reloadDefinitions')}
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t('settings.indexers.catalogue.noDefinitionsMatch')}>{t('settings.indexers.catalogue.tryFewerWordsOrAnother')}</EmptyState>
      ) : (
        <ul className="al-chooser__list" aria-label={t('settings.indexers.catalogue.definitions')}>
          {rows.map((d) => (
            <DefinitionRow key={d.id} def={d} onPick={onPick} needsSolver={missingSolver && definitionNeedsSolver(d)} />
          ))}
        </ul>
      )}
    </div>
  );
}
