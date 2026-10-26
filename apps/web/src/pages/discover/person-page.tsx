import { getRouteApi } from '@tanstack/react-router';
import type { PersonCredit } from '@arclight/shared';
import { ErrorView } from '../../components/error-boundary.js';
import { Facts, Poster } from '../../components/media/media-ui.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { DiscoverCard } from '../../features/requests/discover-ui.js';
import { usePerson } from '../../hooks/requests.js';
import '../../features/requests/requests.css';

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
  if (person.isPending) return <LoadingBlock />;
  if (person.isError) return <ErrorView error={person.error} onRetry={() => void person.refetch()} />;
  const p = person.data;
  const cast = sortCredits(p.cast);
  const crew = sortCredits(p.crew);

  return (
    <Page title={p.name} subtitle={p.knownForDepartment ?? undefined}>
      <section className="person-hero">
        <Poster url={p.profileUrl ?? undefined} title={p.name} size="lg" />
        <div className="stack-sm">
          <Facts
            items={[
              ['Born', [p.birthday, p.placeOfBirth].filter(Boolean).join(' · ') || '—'],
              ...(p.deathday ? ([['Died', p.deathday]] as Array<[string, string]>) : []),
            ]}
          />
          <p className="person-bio">{p.biography || 'No biography available.'}</p>
        </div>
      </section>
      {cast.length > 0 ? (
        <section className="discover-section">
          <h2 className="discover-section-title">Appearances ({cast.length})</h2>
          <div className="poster-grid">
            {cast.map((c) => (
              <DiscoverCard key={`${c.mediaType}-${c.tmdbId}`} item={c} subtitle={c.character} />
            ))}
          </div>
        </section>
      ) : null}
      {crew.length > 0 ? (
        <section className="discover-section">
          <h2 className="discover-section-title">Crew ({crew.length})</h2>
          <div className="poster-grid">
            {crew.map((c) => (
              <DiscoverCard key={`${c.mediaType}-${c.tmdbId}`} item={c} subtitle={c.job} />
            ))}
          </div>
        </section>
      ) : null}
    </Page>
  );
}
