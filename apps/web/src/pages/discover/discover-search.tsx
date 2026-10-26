import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import type { PersonPage } from '@arclight/shared';
import { discoverApi } from '../../api/requests.js';
import { EmptyState, Input, PageHeader, Poster, Segmented, Skeleton } from '../../arclight/index.js';
import { PosterSkeletons, QueryError } from '../../components/media/media-kit.js';
import { DLink, titleTarget, useDiscoverNavigate, type DiscoverTarget } from '../../features/discover/base.js';
import { tmdbImage } from '../../features/discover/images.js';
import { useDiscoverInfinite } from '../../hooks/requests.js';
import { requestKeys } from '../../hooks/request-keys.js';
import { DiscoverGrid, GridFooter, PersonCard, dedupe, useInfiniteSentinel } from './discover-kit.js';
import { t } from '../../i18n/index.js';

// Search across movies, series and people: a type-ahead box (page headers, portal header)
// and the results page (/search?q=&type=) with infinite grids per type.

export type SearchType = 'all' | 'movie' | 'tv' | 'person';

export interface SearchParams {
  q: string;
  type?: SearchType;
}

export const parseSearchParams = (search: Record<string, unknown>): SearchParams => {
  const type = search['type'];
  return {
    q: typeof search['q'] === 'string' ? search['q'] : typeof search['q'] === 'number' ? String(search['q']) : '',
    ...(type === 'movie' || type === 'tv' || type === 'person' ? { type } : {}),
  };
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

interface Suggestion {
  key: string;
  label: string;
  meta: string;
  image: string | null;
  target: DiscoverTarget;
}

/** Search box with suggestions (titles and people) as you type; Enter opens the results page. */
export function DiscoverSearchBox({ initial = '', autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const go = useDiscoverNavigate();
  const listId = useId();
  const [term, setTerm] = useState(initial);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const q = useDebounced(term.trim(), 250);
  const enabled = open && q.length >= 2;
  const titles = useQuery({ queryKey: requestKeys.discover.suggest(`t:${q}`), queryFn: () => discoverApi.search(q, 1), enabled, staleTime: 60_000, retry: false });
  const people = useQuery({ queryKey: requestKeys.discover.suggest(`p:${q}`), queryFn: () => discoverApi.people(q, 1), enabled, staleTime: 60_000, retry: false });

  const suggestions = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];
    for (const item of (titles.data?.results ?? []).slice(0, 6)) {
      out.push({
        key: `${item.mediaType}-${item.tmdbId}`,
        label: item.title,
        meta: [item.year, item.mediaType === 'movie' ? t('common.movie') : t('common.series')].filter(Boolean).join(' · '),
        image: tmdbImage(item.posterUrl, 'profile'),
        target: titleTarget(item.mediaType, item.tmdbId),
      });
    }
    for (const p of (people.data?.results ?? []).slice(0, 3)) {
      out.push({ key: `person-${p.tmdbId}`, label: p.name, meta: p.knownForDepartment ?? '', image: tmdbImage(p.profileUrl, 'profile'), target: { to: '/person/$id', params: { id: String(p.tmdbId) } } });
    }
    return out;
  }, [titles.data, people.data]);
  const titleCount = Math.min(6, titles.data?.results.length ?? 0);
  // The last option is "See all results".
  const optionCount = enabled ? suggestions.length + 1 : 0;

  useEffect(() => setActive(-1), [q]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const searchAll = () => {
    const value = term.trim();
    if (!value) return;
    setOpen(false);
    void go({ to: '/search', search: { q: value } });
  };
  const choose = (index: number) => {
    const s = suggestions[index];
    setOpen(false);
    if (s) void go(s.target);
    else searchAll();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && optionCount) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % optionCount);
    } else if (e.key === 'ArrowUp' && optionCount) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? optionCount - 1 : i - 1));
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(active);
      else searchAll();
    }
  };
  const loading = enabled && (titles.isFetching || people.isFetching) && suggestions.length === 0;

  return (
    <div className="dk-search" ref={box}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          searchAll();
        }}
      >
        <Input
          type="search"
          role="combobox"
          aria-label={t('discover.search.label')}
          aria-expanded={enabled}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          placeholder={t('discover.search.placeholder')}
          value={term}
          autoFocus={autoFocus}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setTerm(e.currentTarget.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </form>
      {enabled ? (
        <div className="dk-suggest" id={listId} role="listbox" aria-label={t('discover.search.suggestions')}>
          {loading ? (
            <div style={{ padding: 12 }}>
              <Skeleton lines={3} />
            </div>
          ) : null}
          {suggestions.map((s, i) => (
            <div key={s.key}>
              {i === 0 && titleCount > 0 ? <div className="dk-suggest__group">{t('discover.search.titles')}</div> : null}
              {i === titleCount && suggestions.length > titleCount ? <div className="dk-suggest__group">{t('discover.search.people')}</div> : null}
              <div
                id={`${listId}-${i}`}
                role="option"
                aria-selected={active === i}
                className="dk-suggest__item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
              >
                <Poster src={s.image} title={s.label} />
                <span className="dk-suggest__title">{s.label}</span>
                <span className="dk-suggest__meta">{s.meta}</span>
              </div>
            </div>
          ))}
          <div
            id={`${listId}-${suggestions.length}`}
            role="option"
            aria-selected={active === suggestions.length}
            className="dk-suggest__all"
            onMouseDown={(e) => e.preventDefault()}
            onClick={searchAll}
          >
            {t('discover.search.seeAllResults', { q })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Infinite grid of people search results. */
function PeopleGrid({ q }: { q: string }) {
  const fetchPage = useCallback((page: number) => discoverApi.people(q, page), [q]);
  const query = useDiscoverInfinite<PersonPage>(requestKeys.discover.list('people', { q }), fetchPage);
  const sentinel = useInfiniteSentinel(query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage);
  if (query.isPending) return <PosterSkeletons />;
  if (query.isError) return <QueryError error={query.error} title={t('discover.search.couldNotLoadPeople')} onRetry={() => void query.refetch()} />;
  const people = dedupe(query.data.pages.flatMap((p) => p.results));
  if (people.length === 0) return <EmptyState title={t('discover.search.noPeople')}>{t('discover.search.tryAnotherName')}</EmptyState>;
  return (
    <>
      <div className="dk-people" data-testid="people-grid">
        {people.map((p) => (
          <PersonCard key={p.tmdbId} person={p} subtitle={p.knownFor.slice(0, 2).join(', ') || p.knownForDepartment} />
        ))}
      </div>
      <GridFooter sentinel={sentinel} hasNextPage={query.hasNextPage} loading={query.isFetchingNextPage} onMore={() => void query.fetchNextPage()} shown={people.length} total={query.data.pages[0]?.totalResults} />
    </>
  );
}

/** /search?q=&type=: results for titles (all, movies, series) or people. */
export function DiscoverSearchPage() {
  const search = parseSearchParams(useSearch({ strict: false }) as Record<string, unknown>);
  const go = useDiscoverNavigate();
  const q = search.q.trim();
  const type = search.type ?? 'all';
  const fetchPage = useCallback((page: number) => discoverApi.search(q, page, type === 'person' ? 'all' : type), [q, type]);
  return (
    <>
      <PageHeader index="02" title={q ? t('discover.lists.resultsForQ', { q }) : t('common.search')} actions={<DiscoverSearchBox key={q} initial={q} />}>
        {q ? (
          <Segmented
            aria-label={t('discover.search.resultType')}
            value={type}
            onChange={(next) => void go({ to: '/search', search: { q, ...(next === 'all' ? {} : { type: next }) }, replace: true })}
            options={[
              { value: 'all', label: t('common.all') },
              { value: 'movie', label: t('common.movies') },
              { value: 'tv', label: t('common.series') },
              { value: 'person', label: t('discover.search.people') },
            ]}
          />
        ) : null}
      </PageHeader>
      {!q ? (
        <EmptyState title={t('discover.lists.nothingToSearchFor')}>{t('discover.lists.typeATitleInThe')}</EmptyState>
      ) : type === 'person' ? (
        <PeopleGrid q={q} />
      ) : (
        <DiscoverGrid
          queryKey={requestKeys.discover.list('search', { q, type })}
          fetchPage={fetchPage}
          empty={
            <EmptyState title={t('discover.kit.noTitlesFound')}>
              {t('discover.search.noTitlesHelp')} <DLink to="/search" search={{ q, type: 'person' }}>{t('discover.search.searchPeopleInstead')}</DLink>
            </EmptyState>
          }
        />
      )}
    </>
  );
}
