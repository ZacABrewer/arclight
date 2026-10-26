import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { DiscoverPage } from '@arclight/shared';
import { discoverApi, type DiscoverKind } from '../../api/requests.js';
import { Button, FilterBar, Input, PageHeader, Segmented, Select, Tag } from '../../arclight/index.js';
import { useDiscoverNavigate, type DiscoverPath } from '../../features/discover/base.js';
import {
  activeFilterCount,
  browseQuery,
  idList,
  parseBrowseSearch,
  patchSearch,
  sortFor,
  sortsFor,
  toggleId,
  type BrowseKind,
  type BrowseLock,
  type BrowseSearch,
} from '../../features/discover/filters.js';
import { tmdbImage } from '../../features/discover/images.js';
import { useDiscoverEntity, useDiscoverGenres, useDiscoverOptions, useDiscoverTiles } from '../../hooks/requests.js';
import { requestKeys } from '../../hooks/request-keys.js';
import { DiscoverGrid } from './discover-kit.js';
import { t } from '../../i18n/index.js';

// Movies / Series browse and every page that is a filtered grid (genre, keyword, studio,
// network, streaming service): one filter bar, filters in the URL, infinite grid.

export function sortLabel(sort: string): string {
  const [field = '', dir] = sort.split('.');
  const names: Record<string, string> = {
    popularity: t('discover.browse.sortPopularity'),
    vote_average: t('discover.browse.sortRating'),
    vote_count: t('discover.browse.sortVotes'),
    primary_release_date: t('discover.browse.releaseDate'),
    first_air_date: t('discover.browse.firstAirDate'),
    revenue: t('discover.browse.sortRevenue'),
    original_title: t('common.title'),
    original_name: t('common.title'),
  };
  return `${names[field] ?? field} ${dir === 'asc' ? '↑' : '↓'}`;
}

/** Route search for browse pages: filters plus the media type on pages that serve both. */
export type BrowseRouteSearch = BrowseSearch & { mediaType?: DiscoverKind };

export const parseBrowseRouteSearch = (raw: Record<string, unknown>): BrowseRouteSearch => ({
  ...parseBrowseSearch(raw),
  ...(raw['mediaType'] === 'tv' ? { mediaType: 'tv' as const } : raw['mediaType'] === 'movie' ? { mediaType: 'movie' as const } : {}),
});

function useBrowseSearch(): BrowseRouteSearch {
  return parseBrowseRouteSearch(useSearch({ strict: false }) as Record<string, unknown>);
}

/** Updates the current page's search (filters) in place. */
function useSetSearch() {
  const navigate = useNavigate();
  return useCallback(
    (update: (prev: BrowseRouteSearch) => BrowseRouteSearch) =>
      void navigate({ to: '.', search: (prev: Record<string, unknown>) => update(parseBrowseRouteSearch(prev)), replace: true } as unknown as Parameters<typeof navigate>[0]),
    [navigate],
  );
}

/** A text filter edited locally and written to the URL after a pause (no request per keystroke). */
function useDraft(value: string | undefined, commit: (v: string) => void, delay = 500) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  useEffect(() => {
    if (draft === (value ?? '')) return;
    const id = setTimeout(() => commit(draft), delay);
    return () => clearTimeout(id);
    // Only a changed draft schedules a commit (commit itself is recreated every render).
  }, [draft]);
  return [draft, setDraft] as const;
}

function DraftInput({ value, onCommit, ...rest }: { value: string | undefined; onCommit: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useDraft(value, onCommit);
  return <Input {...rest} value={draft} onChange={(e) => setDraft(e.currentTarget.value)} />;
}

function Toggle({ pressed, onClick, children, label }: { pressed: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" className="dk-toggle" aria-pressed={pressed} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

function KeywordFilter({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(term.trim()), 300);
    return () => clearTimeout(id);
  }, [term]);
  const found = useQuery({ queryKey: requestKeys.discover.list('keywords', { q }), queryFn: () => discoverApi.keywords(q), enabled: q.length >= 2, staleTime: 300_000 });
  const ids = idList(value);
  return (
    <div className="dk-filters__field dk-filters__wide">
      <span className="al-label">{t('discover.browse.keywords')}</span>
      <div className="dk-toggles">
        {ids.map((id) => (
          <KeywordChip key={id} id={id} onRemove={() => onChange(toggleId(value, id))} />
        ))}
      </div>
      <Input aria-label={t('discover.browse.findKeyword')} placeholder={t('discover.browse.findKeyword')} value={term} onChange={(e) => setTerm(e.currentTarget.value)} />
      {found.data && found.data.results.length > 0 ? (
        <div className="dk-keyword-results">
          {found.data.results.slice(0, 12).map((k) => (
            <Toggle
              key={k.id}
              pressed={ids.includes(k.id)}
              onClick={() => {
                onChange(toggleId(value, k.id));
                setTerm('');
              }}
            >
              {k.name}
            </Toggle>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KeywordChip({ id, onRemove }: { id: number; onRemove: () => void }) {
  const entity = useDiscoverEntity('keyword', id);
  const name = entity.data?.name ?? t('discover.lists.keywordId', { id });
  return (
    <Toggle pressed onClick={onRemove} label={t('discover.browse.removeKeyword', { name })}>
      {name} ×
    </Toggle>
  );
}

/** The filter bar: common filters in one row, the rest under "More filters". */
function BrowseFilters({ kind, search, lock }: { kind: BrowseKind; search: BrowseRouteSearch; lock: BrowseLock }) {
  const set = useSetSearch();
  const genres = useDiscoverGenres(kind);
  const options = useDiscoverOptions();
  const region = lock.watchRegion ?? search.region ?? options.data?.region;
  const providers = useDiscoverTiles('providers', kind, region);
  const moreId = useId();
  const advancedSet = ['ratingMax', 'votesMin', 'runtimeMin', 'runtimeMax', 'lang', 'cert', 'providers', 'keywords'].some((k) => search[k as keyof BrowseSearch] !== undefined);
  const [more, setMore] = useState(advancedSet);
  const patch = (p: Parameters<typeof patchSearch>[1]) => set((prev) => ({ ...patchSearch(prev, p), ...(prev.mediaType ? { mediaType: prev.mediaType } : {}) }));
  const certs = options.data?.certifications[kind] ?? [];
  const count = activeFilterCount(search);

  return (
    <div className="dk-filters">
      <FilterBar
        onClear={() => set((prev) => (prev.mediaType ? { mediaType: prev.mediaType } : {}))}
        activeCount={count}
        end={
          <Button variant="ghost" size="sm" aria-expanded={more} aria-controls={moreId} onClick={() => setMore(!more)}>
            {more ? t('discover.browse.fewerFilters') : t('discover.browse.moreFilters')}
          </Button>
        }
      >
        <Select aria-label={t('discover.browse.sort')} value={sortFor(kind, search.sort)} onChange={(e) => patch({ sort: e.currentTarget.value === 'popularity.desc' ? undefined : e.currentTarget.value })} options={sortsFor(kind).map((s) => ({ value: s, label: sortLabel(s) }))} />
        <DraftInput aria-label={t('discover.browse.yearFrom')} mono inputMode="numeric" placeholder="1990" style={{ width: 90 }} value={search.from} onCommit={(v) => patch({ from: v })} />
        <DraftInput aria-label={t('discover.browse.yearTo')} mono inputMode="numeric" placeholder="2026" style={{ width: 90 }} value={search.to} onCommit={(v) => patch({ to: v })} />
        <DraftInput aria-label={t('discover.browse.minRating')} mono type="number" min={0} max={10} step={0.5} placeholder={t('discover.browse.rating')} style={{ width: 96 }} value={search.ratingMin} onCommit={(v) => patch({ ratingMin: v })} />
        <Toggle pressed={search.hideAvailable === true} onClick={() => patch({ hideAvailable: search.hideAvailable ? undefined : true })}>
          {t('discover.browse.hideAvailable')}
        </Toggle>
        <Toggle pressed={search.hideRequested === true} onClick={() => patch({ hideRequested: search.hideRequested ? undefined : true })}>
          {t('discover.browse.hideRequested')}
        </Toggle>
      </FilterBar>

      {genres.data && genres.data.length > 0 ? (
        <div className="dk-toggles" role="group" aria-label={t('discover.browse.genres')}>
          {genres.data
            .filter((g) => String(g.id) !== lock.genre)
            .map((g) => (
              <Toggle key={g.id} pressed={idList(search.genres).includes(g.id)} onClick={() => patch({ genres: toggleId(search.genres, g.id) })}>
                {g.name}
              </Toggle>
            ))}
        </div>
      ) : null}

      {more ? (
        <div className="dk-filters__more" id={moreId}>
          <div className="dk-filters__field">
            <span className="al-label">{t('discover.browse.ratingRange')}</span>
            <div className="dk-filters__pair">
              <DraftInput aria-label={t('discover.browse.minRating')} mono type="number" min={0} max={10} step={0.5} placeholder="0" value={search.ratingMin} onCommit={(v) => patch({ ratingMin: v })} />
              <span className="mk-dim">–</span>
              <DraftInput aria-label={t('discover.browse.maxRating')} mono type="number" min={0} max={10} step={0.5} placeholder="10" value={search.ratingMax} onCommit={(v) => patch({ ratingMax: v })} />
            </div>
          </div>
          <div className="dk-filters__field">
            <span className="al-label">{t('discover.browse.minVotes')}</span>
            <DraftInput aria-label={t('discover.browse.minVotes')} mono type="number" min={0} placeholder="0" value={search.votesMin} onCommit={(v) => patch({ votesMin: v })} />
          </div>
          <div className="dk-filters__field">
            <span className="al-label">{t('discover.browse.runtimeRange')}</span>
            <div className="dk-filters__pair">
              <DraftInput aria-label={t('discover.browse.runtimeMin')} mono type="number" min={0} placeholder={t('discover.browse.min')} end="min" value={search.runtimeMin} onCommit={(v) => patch({ runtimeMin: v })} />
              <span className="mk-dim">–</span>
              <DraftInput aria-label={t('discover.browse.runtimeMax')} mono type="number" min={0} placeholder={t('common.max')} end="min" value={search.runtimeMax} onCommit={(v) => patch({ runtimeMax: v })} />
            </div>
          </div>
          <div className="dk-filters__field">
            <span className="al-label">{t('discover.browse.originalLanguage')}</span>
            <Select aria-label={t('discover.browse.originalLanguage')} value={search.lang ?? ''} onChange={(e) => patch({ lang: e.currentTarget.value || undefined })}>
              <option value="">{t('discover.browse.anyLanguage')}</option>
              {(options.data?.languages ?? []).map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
              {search.lang && !options.data?.languages.some((l) => l.code === search.lang) ? <option value={search.lang}>{search.lang}</option> : null}
            </Select>
          </div>
          <div className="dk-filters__field">
            <span className="al-label">{t('discover.browse.certification')}</span>
            <Select aria-label={t('discover.browse.certification')} value={search.cert ?? ''} onChange={(e) => patch({ cert: e.currentTarget.value || undefined })}>
              <option value="">{t('discover.browse.anyCertification')}</option>
              {certs.map((c) => (
                <option key={c.certification} value={c.certification}>
                  {t('discover.browse.upTo', { certification: c.certification })}
                </option>
              ))}
              {search.cert && !certs.some((c) => c.certification === search.cert) ? <option value={search.cert}>{search.cert}</option> : null}
            </Select>
          </div>
          {lock.watchProviders ? null : (
            <div className="dk-filters__field dk-filters__wide">
              <div className="dk-filters__pair">
                <span className="al-label">{t('discover.browse.streamingOn')}</span>
                <Select aria-label={t('discover.browse.region')} style={{ maxWidth: 220 }} value={region ?? ''} onChange={(e) => patch({ region: e.currentTarget.value || undefined })}>
                  {(options.data?.regions ?? []).map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.name}
                    </option>
                  ))}
                  {region && !options.data?.regions.some((r) => r.code === region) ? <option value={region}>{region}</option> : null}
                </Select>
              </div>
              <div className="dk-toggles" role="group" aria-label={t('discover.browse.streamingOn')}>
                {(providers.data ?? []).slice(0, 30).map((p) => (
                  <Toggle key={p.id} pressed={idList(search.providers).includes(p.id)} label={p.name} onClick={() => patch({ providers: toggleId(search.providers, p.id) })}>
                    {p.imageUrl ? <img src={tmdbImage(p.imageUrl, 'logo') ?? undefined} alt="" loading="lazy" /> : null}
                    <span>{p.name}</span>
                  </Toggle>
                ))}
              </div>
            </div>
          )}
          {lock.keywords ? null : <KeywordFilter value={search.keywords} onChange={(v) => patch({ keywords: v })} />}
        </div>
      ) : null}
    </div>
  );
}

function KindToggle({ value, onChange }: { value: DiscoverKind; onChange: (k: DiscoverKind) => void }) {
  return (
    <Segmented
      aria-label={t('common.mediaType')}
      value={value}
      onChange={onChange}
      options={[
        { value: 'movie', label: t('common.movies') },
        { value: 'tv', label: t('common.series') },
      ]}
    />
  );
}

export interface BrowsePageProps {
  kind: BrowseKind;
  title: string;
  subtitle?: ReactNode;
  /** What the page fixes (its genre, studio, ...). */
  lock?: BrowseLock;
  /** How the media type switch works: separate routes (Movies/TV) or ?mediaType= (genre pages); null hides it. */
  kindSwitch: { route: Record<BrowseKind, DiscoverPath> } | 'search' | null;
  /** Grid query key prefix (page identity). */
  source: string;
  onFirstPage?: (page: DiscoverPage) => void;
}

export function BrowsePage({ kind, title, subtitle, lock = {}, kindSwitch, source, onFirstPage }: BrowsePageProps) {
  const search = useBrowseSearch();
  const go = useDiscoverNavigate();
  const set = useSetSearch();
  const query = useMemo(() => browseQuery(kind, search, lock), [kind, search, lock]);
  const fetchPage = useCallback((page: number) => (kind === 'movie' ? discoverApi.movies({ ...query, page }) : discoverApi.tv({ ...query, page })), [kind, query]);
  const switchKind = (next: DiscoverKind) => {
    if (kindSwitch === 'search') set((prev) => ({ ...prev, mediaType: next, ...(prev.sort ? { sort: sortFor(next, prev.sort) } : {}) }));
    else if (kindSwitch) void go({ to: kindSwitch.route[next], search: { ...search, ...(search.sort ? { sort: sortFor(next, search.sort) } : {}) } });
  };

  return (
    <>
      <PageHeader index="02" title={title} subtitle={subtitle}>
        {kindSwitch ? <KindToggle value={kind} onChange={switchKind} /> : null}
      </PageHeader>
      <BrowseFilters kind={kind} search={search} lock={lock} />
      <DiscoverGrid queryKey={requestKeys.discover.list(source, { kind, query })} fetchPage={fetchPage} {...(onFirstPage ? { onFirstPage } : {})} />
    </>
  );
}

const ROUTES = { route: { movie: '/movies', tv: '/tv' } } as const satisfies { route: Record<BrowseKind, DiscoverPath> };

export function DiscoverMoviesPage() {
  return <BrowsePage kind="movie" title={t('discover.browse.discoverMovies')} kindSwitch={ROUTES} source="movies" />;
}

export function DiscoverTvPage() {
  return <BrowsePage kind="tv" title={t('discover.browse.discoverSeries')} kindSwitch={ROUTES} source="tv" />;
}

function useIdParam(): string {
  const params = useParams({ strict: false }) as { id?: string };
  return params.id && /^\d+$/.test(params.id) ? params.id : '0';
}

export function DiscoverGenrePage() {
  const id = useIdParam();
  const kind = useBrowseSearch().mediaType ?? 'movie';
  const genres = useDiscoverGenres(kind);
  const name = genres.data?.find((g) => g.id === Number(id))?.name ?? t('discover.lists.genreId', { id });
  const lock = useMemo(() => ({ genre: id }), [id]);
  return <BrowsePage key={id} kind={kind} title={name} subtitle={kind === 'movie' ? t('common.movies') : t('common.series')} lock={lock} kindSwitch="search" source="genre" />;
}

export function DiscoverKeywordPage() {
  const id = useIdParam();
  const kind = useBrowseSearch().mediaType ?? 'movie';
  const entity = useDiscoverEntity('keyword', Number(id));
  const lock = useMemo(() => ({ keywords: id }), [id]);
  return <BrowsePage key={id} kind={kind} title={entity.data?.name ?? t('discover.lists.keywordId', { id })} subtitle={<Tag>{t('discover.browse.keyword')}</Tag>} lock={lock} kindSwitch="search" source="keyword" />;
}

function CompanyPage({ kind }: { kind: 'studio' | 'network' }) {
  const id = useIdParam();
  const entity = useDiscoverEntity(kind, Number(id));
  const lock = useMemo(() => (kind === 'studio' ? { studio: Number(id) } : { network: Number(id) }), [id, kind]);
  const subtitle = entity.data?.imageUrl ? <img className="dk-company-logo" src={tmdbImage(entity.data.imageUrl, 'logo') ?? undefined} alt="" style={{ height: 28, filter: 'grayscale(1) brightness(1.6)' }} /> : undefined;
  return (
    <BrowsePage
      key={id}
      kind={kind === 'studio' ? 'movie' : 'tv'}
      title={entity.data?.name ?? (kind === 'studio' ? t('common.studio') : t('common.network'))}
      subtitle={subtitle}
      lock={lock}
      kindSwitch={null}
      source={kind}
    />
  );
}

export function DiscoverStudioPage() {
  return <CompanyPage kind="studio" />;
}

export function DiscoverNetworkPage() {
  return <CompanyPage kind="network" />;
}

export function DiscoverProviderPage() {
  const id = useIdParam();
  const search = useBrowseSearch();
  const kind = search.mediaType ?? 'movie';
  const options = useDiscoverOptions();
  const region = search.region ?? options.data?.region;
  const providers = useDiscoverTiles('providers', kind, region);
  const name = providers.data?.find((p) => p.id === Number(id))?.name ?? t('discover.browse.streamingService');
  const lock = useMemo(() => ({ watchProviders: id, ...(region ? { watchRegion: region } : {}) }), [id, region]);
  return <BrowsePage key={id} kind={kind} title={name} subtitle={region ? <span className="al-num">{region}</span> : undefined} lock={lock} kindSwitch="search" source="provider" />;
}

