import { getRouteApi } from '@tanstack/react-router';
import { ComingSoon } from '../components/coming-soon.js';

const route = getRouteApi('/search');

/**
 * Global search results. TODO(contract): needs a library search endpoint (series + movies by
 * title) and a metadata lookup for "add new"; until then it echoes the query.
 */
export function SearchPage() {
  const { q } = route.useSearch();
  return (
    <ComingSoon title="Search" phase="Phase 1">
      {q ? (
        <p>
          You searched for <strong>{q}</strong>.
        </p>
      ) : null}
    </ComingSoon>
  );
}
