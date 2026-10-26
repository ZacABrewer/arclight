import { useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Link } from '@tanstack/react-router';
import { CatalogueCategoryGroup, type CatalogueSource, type Indexer, type IndexerCatalogueEntry, type IndexerPrivacy, type ReleaseProtocol } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Checkbox, Chip, EmptyState, ErrorBlock, Input, Modal, ProtocolBadge, Select, Skeleton, type ChipTone } from '../../../arclight/index.js';
import { useMediaQuery } from '../../../arclight/index.js';
import { useIndexerCatalogue, useIndexerList, useIndexerProxies, useSyncCommunityCatalogue } from '../../../hooks/indexers.js';
import { relativeTime } from '../../../lib/format.js';
import { hasSolverProxy } from '../indexer-proxies/proxy-model.js';
import {
  addedIndex,
  DEFAULT_SORT,
  EMPTY_CHOOSER_FILTER,
  existingFor,
  filterEntries,
  languageName,
  languageOptions,
  moveActive,
  nextSort,
  primaryLanguage,
  sortEntries,
  type ChooserFilter,
  type ChooserSort,
  type SortKey,
  type SourceFilter,
} from './catalogue-model.js';
import { PRIVACY_LABELS, PRIVACY_TONES } from './definition-fields.js';
import { SolverHint } from './solver-hint.js';
import { useMeasuredRows } from './use-measured-rows.js';
import './indexers.css';
import { t } from '../../../i18n/index.js';

/** Where an entry comes from. Shown on every row. */
export const SOURCE_BADGES: Record<CatalogueSource, { label: string; tone: ChipTone; title: string }> = {
  builtin: { get label() { return t('settings.indexers.catalogue.builtIn'); }, tone: 'muted', get title() { return t('settings.indexers.catalogue.shippedWithArclight'); } },
  feed: { get label() { return t('common.feed'); }, tone: 'neutral', get title() { return t('settings.indexers.catalogue.downloadedFromTheDefinitionFeed'); } },
  custom: { get label() { return t('common.custom'); }, tone: 'default', get title() { return t('settings.indexers.catalogue.yourOwnDefinitionFileOverrides'); } },
  community: { get label() { return t('settings.indexers.catalogue.community'); }, tone: 'neutral', get title() { return t('settings.indexers.catalogue.communityTitle'); } },
  preset: { get label() { return t('settings.indexers.catalogue.preset'); }, tone: 'default', get title() { return t('settings.indexers.catalogue.presetTitle'); } },
  generic: { get label() { return t('settings.indexers.catalogue.generic'); }, tone: 'muted', get title() { return t('settings.indexers.catalogue.genericTitle'); } },
};

export function SourceBadge({ source }: { source: CatalogueSource }) {
  const b = SOURCE_BADGES[source];
  return (
    <Chip tone={b.tone} dot="none" title={b.title} data-source={source}>
      {b.label}
    </Chip>
  );
}

export const CATEGORY_GROUP_LABELS: Record<CatalogueCategoryGroup, string> = {
  get movies() { return t('settings.indexers.catalogue.groupMovies'); },
  get tv() { return t('settings.indexers.catalogue.groupTv'); },
  get anime() { return t('settings.indexers.catalogue.groupAnime'); },
  get music() { return t('settings.indexers.catalogue.groupMusic'); },
  get books() { return t('settings.indexers.catalogue.groupBooks'); },
  get xxx() { return t('settings.indexers.catalogue.groupXxx'); },
  get other() { return t('settings.indexers.catalogue.groupOther'); },
};

const COLUMNS: ReadonlyArray<{ key: SortKey; label: () => string }> = [
  { key: 'name', label: () => t('common.name') },
  { key: 'protocol', label: () => t('common.protocol') },
  { key: 'privacy', label: () => t('settings.indexers.catalogue.privacy') },
  { key: 'language', label: () => t('common.language') },
  { key: 'categories', label: () => t('common.categories') },
  { key: 'source', label: () => t('settings.indexers.catalogue.source') },
];

/** Estimated row height before measuring (desktop / phone). */
const ROW_ESTIMATE = 76;
const ROW_ESTIMATE_PHONE = 132;

export interface CatalogueChooserProps {
  /** A supported entry the user wants to add (also "Add another" on an added one). */
  onPick: (entry: IndexerCatalogueEntry) => void;
  /** "Edit existing" on an entry that is already added. */
  onEditExisting: (indexer: Indexer) => void;
  /** Focus target for the dialog. */
  searchRef?: Ref<HTMLInputElement> | undefined;
}

/**
 * The add-indexer chooser (handoff §9, laid out like a release table): search, filters,
 * sortable columns and a virtualised listbox of every catalogue entry. Entries the user
 * already has are greyed with an "Added" chip; unsupported ones stay listed with the reason.
 */
export function CatalogueChooser({ onPick, onEditExisting, searchRef }: CatalogueChooserProps) {
  const catalogue = useIndexerCatalogue();
  const indexers = useIndexerList();
  const proxies = useIndexerProxies();
  const missingSolver = proxies.isSuccess && !hasSolverProxy(proxies.data);
  const phone = useMediaQuery('(max-width: 767.98px)');
  const [filter, setFilter] = useState<ChooserFilter>(EMPTY_CHOOSER_FILTER);
  const [sort, setSort] = useState<ChooserSort>(DEFAULT_SORT);
  const [active, setActive] = useState(0);
  const [choice, setChoice] = useState<{ entry: IndexerCatalogueEntry; existing: Indexer[] } | null>(null);
  const [info, setInfo] = useState<IndexerCatalogueEntry | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const entries = catalogue.data?.entries;
  const rows = useMemo(() => sortEntries(filterEntries(entries ?? [], filter), sort), [entries, filter, sort]);
  const languages = useMemo(() => languageOptions(entries ?? []), [entries]);
  const added = useMemo(() => addedIndex(indexers.data ?? []), [indexers.data]);
  const keys = useMemo(() => rows.map((r) => r.key), [rows]);
  const range = useMeasuredRows({ keys, estimate: phone ? ROW_ESTIMATE_PHONE : ROW_ESTIMATE, scrollRef });
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));

  const set = <K extends keyof ChooserFilter>(k: K, v: ChooserFilter[K]) => {
    setFilter((f) => ({ ...f, [k]: v }));
    setActive(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const activate = (entry: IndexerCatalogueEntry | undefined) => {
    if (!entry) return;
    if (entry.support === 'unsupported') return setInfo(entry);
    const existing = existingFor(entry, added);
    if (existing.length) return setChoice({ entry, existing });
    onPick(entry);
  };

  const go = (i: number) => {
    setActive(i);
    range.scrollToIndex(i);
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight || 600) / (phone ? ROW_ESTIMATE_PHONE : ROW_ESTIMATE)));
    const next = moveActive(e.key, activeIndex, rows.length, page);
    if (next !== null) {
      e.preventDefault();
      go(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(rows[activeIndex]);
    }
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && rows.length) {
      e.preventDefault();
      go(0);
      listRef.current?.focus();
    } else if (e.key === 'Enter' && rows.length) {
      e.preventDefault();
      activate(rows[activeIndex]);
    }
  };

  const filtered = filter !== EMPTY_CHOOSER_FILTER && JSON.stringify(filter) !== JSON.stringify(EMPTY_CHOOSER_FILTER);

  return (
    <div className="al-catalogue">
      <div className="al-catalogue__toolbar">
        <Input
          ref={searchRef}
          type="search"
          className="al-catalogue__search"
          aria-label={t('settings.indexers.searchIndexers')}
          aria-controls={listId}
          placeholder={t('settings.indexers.catalogue.searchPlaceholder')}
          value={filter.text}
          onChange={(e) => set('text', e.currentTarget.value)}
          onKeyDown={onSearchKey}
        />
        <div className="al-catalogue__filters" role="group" aria-label={t('settings.indexers.catalogue.filters')}>
          <Select
            aria-label={t('common.protocol')}
            value={filter.protocol}
            onChange={(e) => set('protocol', e.currentTarget.value as ReleaseProtocol | 'all')}
            options={[
              { value: 'all', label: t('settings.indexers.catalogue.anyProtocol') },
              { value: 'torrent', label: t('common.torrent') },
              { value: 'usenet', label: t('common.usenet') },
            ]}
          />
          <Select
            aria-label={t('settings.indexers.catalogue.privacy')}
            value={filter.privacy}
            onChange={(e) => set('privacy', e.currentTarget.value as IndexerPrivacy | 'all')}
            options={[
              { value: 'all', label: t('settings.indexers.catalogue.anyPrivacy') },
              { value: 'public', label: t('settings.indexers.catalogue.public') },
              { value: 'semi-private', label: t('settings.indexers.catalogue.semiPrivate') },
              { value: 'private', label: t('common.private') },
            ]}
          />
          <Select
            aria-label={t('common.language')}
            value={filter.language}
            onChange={(e) => set('language', e.currentTarget.value)}
            options={[
              { value: '', label: t('settings.indexers.catalogue.anyLanguage') },
              ...languages.map((l) => ({ value: l.code, label: `${languageName(l.code)} (${l.count})` })),
            ]}
          />
          <Select
            aria-label={t('settings.indexers.catalogue.category')}
            value={filter.category}
            onChange={(e) => set('category', e.currentTarget.value as CatalogueCategoryGroup | 'all')}
            options={[
              { value: 'all', label: t('settings.indexers.catalogue.anyCategory') },
              ...CatalogueCategoryGroup.options.map((g) => ({ value: g, label: CATEGORY_GROUP_LABELS[g] })),
            ]}
          />
          <Select
            aria-label={t('settings.indexers.catalogue.source')}
            value={filter.source}
            onChange={(e) => set('source', e.currentTarget.value as SourceFilter)}
            options={[
              { value: 'all', label: t('settings.indexers.catalogue.anySource') },
              { value: 'arclight', label: t('settings.indexers.catalogue.builtIn') },
              { value: 'community', label: t('settings.indexers.catalogue.community') },
              { value: 'preset', label: t('settings.indexers.catalogue.presetsAndEndpoints') },
              { value: 'custom', label: t('common.custom') },
            ]}
          />
          <Checkbox label={t('settings.indexers.catalogue.testedOnly')} checked={filter.testedOnly} onChange={(e) => set('testedOnly', e.currentTarget.checked)} />
          <Checkbox label={t('settings.indexers.catalogue.hideUnsupported')} checked={filter.hideUnsupported} onChange={(e) => set('hideUnsupported', e.currentTarget.checked)} />
          {filtered ? (
            <Button size="sm" variant="ghost" onClick={() => setFilter(EMPTY_CHOOSER_FILTER)}>
              {t('settings.indexers.catalogue.clearFilters')}
            </Button>
          ) : null}
        </div>
        {phone ? (
          <Select
            aria-label={t('settings.indexers.catalogue.sortBy')}
            value={`${sort.key}:${sort.direction}`}
            onChange={(e) => {
              const [key, direction] = e.currentTarget.value.split(':') as [SortKey, 'asc' | 'desc'];
              setSort({ key, direction });
            }}
            options={COLUMNS.flatMap((c) => [
              { value: `${c.key}:asc`, label: `${c.label()} ↑` },
              { value: `${c.key}:desc`, label: `${c.label()} ↓` },
            ])}
          />
        ) : null}
      </div>

      {catalogue.isPending ? (
        <Skeleton lines={6} />
      ) : catalogue.isError ? (
        <ErrorBlock title={t('settings.indexers.catalogue.couldntLoadTheCatalogue')} onRetry={() => void catalogue.refetch()}>
          {errorMessage(catalogue.error)}
        </ErrorBlock>
      ) : (
        <>
          <CatalogueSummary shown={rows.length} catalogue={catalogue.data} />
          {phone ? null : (
            <div className="al-catalogue__head al-catalogue__grid" role="presentation">
              {COLUMNS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="al-catalogue__sort"
                  data-active={sort.key === c.key || undefined}
                  aria-label={t('settings.indexers.catalogue.sortByColumn', { column: c.label() })}
                  aria-pressed={sort.key === c.key}
                  onClick={() => setSort((s) => nextSort(s, c.key))}
                >
                  {c.label()}
                  <span aria-hidden="true">{sort.key === c.key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                </button>
              ))}
            </div>
          )}
          {rows.length === 0 ? (
            <EmptyState title={t('settings.indexers.catalogue.noDefinitionsMatch')}>{t('settings.indexers.catalogue.tryFewerWordsOrAnother')}</EmptyState>
          ) : (
            <div className="al-catalogue__scroll" ref={scrollRef}>
              <div
                ref={listRef}
                id={listId}
                role="listbox"
                tabIndex={0}
                className="al-catalogue__list"
                aria-label={t('settings.indexers.catalogue.catalogueEntries')}
                aria-activedescendant={rows[activeIndex] ? `${listId}-${activeIndex}` : undefined}
                onKeyDown={onListKey}
              >
                <div role="presentation" style={{ height: range.padTop }} />
                {rows.slice(range.start, range.end).map((entry, i) => {
                  const index = range.start + i;
                  return (
                    <CatalogueRow
                      key={entry.key}
                      id={`${listId}-${index}`}
                      entry={entry}
                      existing={existingFor(entry, added)}
                      active={index === activeIndex}
                      needsSolver={missingSolver && entry.requiresFlareSolverr === true}
                      measure={range.measure}
                      onActivate={() => {
                        setActive(index);
                        activate(entry);
                      }}
                    />
                  );
                })}
                <div role="presentation" style={{ height: range.padBottom }} />
              </div>
            </div>
          )}
        </>
      )}

      {choice ? (
        <AddedChoice
          entry={choice.entry}
          existing={choice.existing}
          onClose={() => setChoice(null)}
          onEdit={(indexer) => {
            setChoice(null);
            onEditExisting(indexer);
          }}
          onAddAnother={() => {
            const entry = choice.entry;
            setChoice(null);
            onPick(entry);
          }}
        />
      ) : null}
      {info ? <UnsupportedInfo entry={info} onClose={() => setInfo(null)} /> : null}
    </div>
  );
}

/** "Showing 412 of 590 · 585 can be added · 5 not supported yet" plus the community line. */
function CatalogueSummary({ shown, catalogue }: { shown: number; catalogue: NonNullable<ReturnType<typeof useIndexerCatalogue>['data']> }) {
  const sync = useSyncCommunityCatalogue();
  const c = catalogue.community;
  return (
    <div className="al-catalogue__summary">
      <span className="al-num">
        {t('settings.indexers.catalogue.countsLine', {
          shown,
          total: catalogue.counts.total,
          supported: catalogue.counts.supported,
          unsupported: catalogue.counts.unsupported,
        })}
      </span>
      <span>
        {!c.enabled ? (
          <>
            {t('settings.indexers.catalogue.communityOff')}{' '}
            <Link to="/settings/indexercatalogue" className="al-link">
              {t('settings.indexers.catalogue.catalogueSettings')}
            </Link>
          </>
        ) : c.lastSuccessAt ? (
          <>
            {t('settings.indexers.catalogue.communitySynced', { when: relativeTime(c.lastSuccessAt) })}{' '}
            <Link to="/settings/indexercatalogue" className="al-link">
              {t('settings.indexers.catalogue.catalogueSettings')}
            </Link>
          </>
        ) : (
          <>
            {c.lastError ? t('settings.indexers.catalogue.communityFailed', { error: c.lastError }) : t('settings.indexers.catalogue.communityNotSynced')}{' '}
            <Button size="sm" variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()}>
              {t('common.syncNow')}
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

function CatalogueRow({
  id,
  entry,
  existing,
  active,
  needsSolver,
  measure,
  onActivate,
}: {
  id: string;
  entry: IndexerCatalogueEntry;
  existing: readonly Indexer[];
  active: boolean;
  needsSolver: boolean;
  measure: (el: HTMLElement | null) => void;
  onActivate: () => void;
}) {
  const unsupported = entry.support === 'unsupported';
  const isAdded = existing.length > 0;
  const descId = `${id}-desc`;
  return (
    <div
      id={id}
      ref={measure}
      data-row-key={entry.key}
      role="option"
      aria-selected={active}
      aria-disabled={unsupported || undefined}
      aria-label={entry.name}
      aria-describedby={descId}
      className="al-catalogue__row al-catalogue__grid"
      data-added={isAdded || undefined}
      data-support={entry.support}
      onClick={onActivate}
    >
      <div className="al-catalogue__cell al-catalogue__cell--name">
        <span className="al-catalogue__name">{entry.name}</span>
        <span className="al-catalogue__chips">
          {isAdded ? (
            <Chip tone="accent" dot="none" title={existing.map((i) => i.name).join(', ')}>
              {t('settings.indexers.catalogue.added')}
            </Chip>
          ) : null}
          {entry.support === 'unsupported' ? (
            <Chip tone="warn" dot="none">
              {t('settings.indexers.catalogue.notSupportedYet')}
            </Chip>
          ) : null}
          {entry.support === 'limited' ? (
            <Chip tone="warn" dot="none" title={entry.supportReason}>
              {t('settings.indexers.catalogue.limited')}
            </Chip>
          ) : null}
          {entry.kind === 'definition' && !entry.tested && !unsupported ? (
            <Chip tone="muted" dot="none">
              {t('settings.indexers.catalogue.untested')}
            </Chip>
          ) : null}
        </span>
        <span id={descId} className="al-catalogue__desc">
          {isAdded ? <span className="al-catalogue__added">{t('settings.indexers.catalogue.alreadyUsedAs', { names: existing.map((i) => i.name).join(', ') })} </span> : null}
          {entry.description}
          {entry.supportReason && entry.support !== 'supported' ? <span className="al-catalogue__reason">{entry.supportReason}</span> : null}
        </span>
        {needsSolver ? <SolverHint as="span" /> : null}
      </div>
      <div className="al-catalogue__cell" data-col="protocol">
        <ProtocolBadge protocol={entry.protocol} />
      </div>
      <div className="al-catalogue__cell" data-col="privacy">
        {entry.kind === 'generic' ? null : (
          <Chip tone={PRIVACY_TONES[entry.privacy]} dot="none">
            {PRIVACY_LABELS[entry.privacy]}
          </Chip>
        )}
      </div>
      <div className="al-catalogue__cell al-catalogue__lang" data-col="language" title={entry.language ? languageName(primaryLanguage(entry.language)) : undefined}>
        {entry.language || '—'}
      </div>
      <div className="al-catalogue__cell al-catalogue__cats" data-col="categories">
        {entry.categoryGroups.map((g) => CATEGORY_GROUP_LABELS[g]).join(' · ') || '—'}
      </div>
      <div className="al-catalogue__cell" data-col="source">
        <SourceBadge source={entry.source} />
      </div>
    </div>
  );
}

/** "Already added": edit the existing indexer (primary) or add another one (secondary). */
export function AddedChoice({
  entry,
  existing,
  onClose,
  onEdit,
  onAddAnother,
}: {
  entry: IndexerCatalogueEntry;
  existing: readonly Indexer[];
  onClose: () => void;
  onEdit: (indexer: Indexer) => void;
  onAddAnother: () => void;
}) {
  const [first, ...rest] = existing;
  return (
    <Modal
      open
      size={560}
      onClose={onClose}
      title={t('settings.indexers.catalogue.alreadyAddedTitle', { name: entry.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="secondary" onClick={onAddAnother}>
            {t('settings.indexers.catalogue.addAnother')}
          </Button>
          {first ? (
            <Button variant="primary" onClick={() => onEdit(first)}>
              {existing.length > 1 ? t('settings.indexers.catalogue.editName', { name: first.name }) : t('settings.indexers.catalogue.editExisting')}
            </Button>
          ) : null}
        </>
      }
    >
      <p>{t('settings.indexers.catalogue.alreadyAddedBody', { count: existing.length, names: existing.map((i) => i.name).join(', ') })}</p>
      {rest.length ? (
        <ul className="al-catalogue__existing">
          {rest.map((i) => (
            <li key={i.id}>
              <Button size="sm" variant="ghost" onClick={() => onEdit(i)}>
                {t('settings.indexers.catalogue.editName', { name: i.name })}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="al-catalogue__hint">{t('settings.indexers.catalogue.addAnotherHint')}</p>
    </Modal>
  );
}

/** Why a community definition cannot be added yet. */
function UnsupportedInfo({ entry, onClose }: { entry: IndexerCatalogueEntry; onClose: () => void }) {
  return (
    <Modal
      open
      size={560}
      onClose={onClose}
      title={t('settings.indexers.catalogue.notSupportedTitle', { name: entry.name })}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <p>{t('settings.indexers.catalogue.notSupportedBody')}</p>
      <p className="al-catalogue__reason al-num">{entry.supportReason}</p>
      <p className="al-catalogue__hint">{t('settings.indexers.catalogue.notSupportedHint', { file: `${entry.id}.yml` })}</p>
    </Modal>
  );
}
