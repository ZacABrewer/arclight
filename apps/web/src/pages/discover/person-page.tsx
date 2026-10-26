import { useMemo, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import type { PersonCredit } from '@arclight/shared';
import { KeyValue, Poster, SectionHead, Segmented, Skeleton, type KeyValueItem } from '../../arclight/index.js';
import { QueryError } from '../../components/media/media-kit.js';
import { DLink } from '../../features/discover/base.js';
import { tmdbImage } from '../../features/discover/images.js';
import { usePerson } from '../../hooks/requests.js';
import { DiscoverCard, DiscoverRow, GridFooter, useInfiniteSentinel } from './discover-kit.js';
import { t } from '../../i18n/index.js';

// Person page: Details layout with a square headshot, facts, biography, a "Known for" row and
// the full credits (appearances, crew) as grids that grow while scrolling.

/** Credits newest first, one card per title (crew can list a title for several jobs). */
export function sortCredits(credits: readonly PersonCredit[]): PersonCredit[] {
  const byKey = new Map<string, PersonCredit>();
  for (const c of credits) {
    const key = `${c.mediaType}-${c.tmdbId}`;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, c);
    else if (c.job && prev.job && !prev.job.includes(c.job)) byKey.set(key, { ...prev, job: `${prev.job}, ${c.job}` });
  }
  return [...byKey.values()].sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
}

/** The person's best-known titles: most voted first. */
export function knownFor(credits: readonly PersonCredit[], count = 16): PersonCredit[] {
  return sortCredits(credits)
    .filter((c) => (c.voteCount ?? 0) > 0)
    .sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0))
    .slice(0, count);
}

const PAGE = 42;

export function PersonPage() {
  const params = useParams({ strict: false }) as { id?: string };
  const person = usePerson(Number(params.id));
  const [tab, setTab] = useState<'all' | 'movie' | 'series'>('all');
  const cast = useMemo(() => sortCredits(person.data?.cast ?? []), [person.data]);
  const crew = useMemo(() => sortCredits(person.data?.crew ?? []), [person.data]);
  const top = useMemo(() => knownFor([...(person.data?.cast ?? []), ...(person.data?.crew ?? [])]), [person.data]);
  if (person.isPending) return <Skeleton lines={6} />;
  if (person.isError) return <QueryError error={person.error} title={t('discover.person.couldNotLoadThisPerson')} onRetry={() => void person.refetch()} />;
  const p = person.data;
  const facts: KeyValueItem[] = [
    { label: t('discover.person.knownFor'), value: p.knownForDepartment ?? '—', mono: false },
    { label: t('discover.person.born'), value: p.birthday ?? '—' },
    { label: t('discover.person.placeOfBirth'), value: p.placeOfBirth ?? '—', mono: false },
    ...(p.deathday ? [{ label: t('discover.person.died'), value: p.deathday }] : []),
  ];
  const pick = (list: PersonCredit[]) => (tab === 'all' ? list : list.filter((c) => c.mediaType === tab));

  return (
    <div className="mk-stack" style={{ gap: 40 }}>
      <section className="mk-hero__grid" aria-label={t('discover.person.person')} style={{ gridTemplateColumns: '208px minmax(0, 1fr)' }}>
        <Poster src={tmdbImage(p.profileUrl, 'posterLarge')} title={p.name} className="mk-headshot mk-hero__poster" loading="eager" />
        <div className="mk-hero__body">
          <div className="mk-crumb">
            <DLink to="">{t('common.discover')}</DLink> {t('discover.person.people')}
          </div>
          <h1 className="al-title-xl" style={{ margin: 0 }}>
            {p.name}
          </h1>
          <KeyValue layout="grid" columns={facts.length} items={facts} />
          <p className="mk-hero__overview">{p.biography || t('discover.person.noBiographyOnTmdb')}</p>
        </div>
      </section>
      {top.length > 3 ? <DiscoverRow title={t('discover.person.knownForTitles')} items={top} /> : null}
      {cast.length + crew.length > 0 ? (
        <Segmented
          aria-label={t('common.mediaType')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'movie', label: t('common.movies') },
            { value: 'series', label: t('common.series') },
          ]}
        />
      ) : null}
      {pick(cast).length > 0 ? <Credits key={`cast-${tab}`} title={t('discover.person.appearances')} credits={pick(cast)} sub={(c) => c.character} /> : null}
      {pick(crew).length > 0 ? <Credits key={`crew-${tab}`} title={t('discover.person.crew')} credits={pick(crew)} sub={(c) => c.job} /> : null}
    </div>
  );
}

/** A credits grid that renders a page of cards at a time as the reader scrolls. */
function Credits({ title, credits, sub }: { title: string; credits: PersonCredit[]; sub: (c: PersonCredit) => string | undefined }) {
  const [shown, setShown] = useState(PAGE);
  const more = shown < credits.length;
  const sentinel = useInfiniteSentinel(more, false, () => setShown((n) => n + PAGE));
  return (
    <section className="mk-slider" aria-label={title}>
      <SectionHead
        label={
          <h2 className="al-title-m mk-section-title">
            {title} <span className="al-num al-caption">{credits.length}</span>
          </h2>
        }
      />
      <div className="mk-poster-grid dk-grid">
        {credits.slice(0, shown).map((c) => (
          <DiscoverCard key={`${c.mediaType}-${c.tmdbId}`} item={c} subtitle={sub(c)} />
        ))}
      </div>
      <GridFooter sentinel={sentinel} hasNextPage={more} loading={false} onMore={() => setShown((n) => n + PAGE)} shown={Math.min(shown, credits.length)} total={credits.length} />
    </section>
  );
}
