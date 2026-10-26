import { getRouteApi, Link } from '@tanstack/react-router';
import type { PersonCredit } from '@arclight/shared';
import { KeyValue, Poster, SectionHead, Skeleton, type KeyValueItem } from '../../arclight/index.js';
import { QueryError } from '../../components/media/media-kit.js';
import { usePerson } from '../../hooks/requests.js';
import { DiscoverCard } from './discover-kit.js';
import { t } from '../../i18n/index.js';

const route = getRouteApi('/discover/person/$id');

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

export function PersonPage() {
  const { id } = route.useParams();
  const person = usePerson(Number(id));
  if (person.isPending) return <Skeleton lines={6} />;
  if (person.isError) return <QueryError error={person.error} title={t('discover.person.couldNotLoadThisPerson')} onRetry={() => void person.refetch()} />;
  const p = person.data;
  const cast = sortCredits(p.cast);
  const crew = sortCredits(p.crew);
  const facts: KeyValueItem[] = [
    { label: t('discover.person.knownFor'), value: p.knownForDepartment ?? '—', mono: false },
    { label: t('discover.person.born'), value: p.birthday ?? '—' },
    { label: t('discover.person.placeOfBirth'), value: p.placeOfBirth ?? '—', mono: false },
    ...(p.deathday ? [{ label: t('discover.person.died'), value: p.deathday }] : []),
  ];

  return (
    <div className="mk-stack" style={{ gap: 40 }}>
      <section className="mk-hero__grid" aria-label={t('discover.person.person')} style={{ gridTemplateColumns: '208px minmax(0, 1fr)' }}>
        <Poster src={p.profileUrl} title={p.name} className="mk-headshot mk-hero__poster" />
        <div className="mk-hero__body">
          <div className="mk-crumb">
            <Link to="/discover">{t('common.discover')}</Link> {t('discover.person.people')}
          </div>
          <h1 className="al-title-xl" style={{ margin: 0 }}>
            {p.name}
          </h1>
          <KeyValue layout="grid" columns={facts.length} items={facts} />
          <p className="mk-hero__overview">{p.biography || t('discover.person.noBiographyOnTmdb')}</p>
        </div>
      </section>
      {cast.length > 0 ? <Credits title={t('discover.person.appearances')} credits={cast} sub={(c) => c.character} /> : null}
      {crew.length > 0 ? <Credits title={t('discover.person.crew')} credits={crew} sub={(c) => c.job} /> : null}
    </div>
  );
}

function Credits({ title, credits, sub }: { title: string; credits: PersonCredit[]; sub: (c: PersonCredit) => string | undefined }) {
  return (
    <section className="mk-slider" aria-label={title}>
      <SectionHead
        label={
          <h2 className="al-title-m mk-section-title">
            {title} <span className="al-num al-caption">{credits.length}</span>
          </h2>
        }
      />
      <div className="mk-poster-grid">
        {credits.map((c) => (
          <DiscoverCard key={`${c.mediaType}-${c.tmdbId}`} item={c} subtitle={sub(c)} />
        ))}
      </div>
    </section>
  );
}
