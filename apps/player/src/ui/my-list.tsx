import { EmptyState, Skeleton } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { HomeCard } from '@web/features/player/video/cards';
import { useMyList } from '../video/my-list';

// /player/watch/my-list on phones (§4.4): the active profile's My List as a grid, with the
// design's empty text. A stand-in until the shared portrait page from the web redesign is mounted.
export function MyListPage() {
  const t = useT();
  const list = useMyList();
  const items = list.data?.items ?? [];
  if (list.isPending) return <Skeleton lines={6} />;
  return (
    <section className="app-mylist">
      <h1 className="app-mylist__title">{t('app.tv.tab.myList')}</h1>
      {items.length ? (
        <ul className="vw-grid" aria-label={t('app.tv.tab.myList')}>
          {items.map((c) => (
            <HomeCard key={`${c.kind}:${c.id}`} card={c} shape="wide" />
          ))}
        </ul>
      ) : (
        <EmptyState title={t('app.tv.tab.myList')}>{t('app.tv.myListEmpty')}</EmptyState>
      )}
    </section>
  );
}
