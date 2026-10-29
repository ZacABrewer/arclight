import { createContext, useCallback, useContext, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';

// Discover pages render in two places: the app (/discover/...) and the public request portal
// (/portal/..., which the router maps onto any portal path or hostname). Both trees have the
// same sub-routes, so every link inside a discover page is written relative to its root and
// resolved here against the tree it is in.

export type DiscoverBase = '/discover' | '/portal';

const BaseContext = createContext<DiscoverBase>('/discover');

export function DiscoverBaseProvider({ base, children }: { base: DiscoverBase; children: ReactNode }) {
  return <BaseContext.Provider value={base}>{children}</BaseContext.Provider>;
}

export function useDiscoverBase(): DiscoverBase {
  return useContext(BaseContext);
}

export function useInPortal(): boolean {
  return useDiscoverBase() === '/portal';
}

/** Discover sub-routes, relative to the discover root ('' is the home page). */
export type DiscoverPath =
  | ''
  | '/movies'
  | '/tv'
  | '/trending'
  | '/upcoming'
  | '/list/$list'
  | '/search'
  | '/movie/$tmdbId'
  | '/tv/$tmdbId'
  | '/person/$id'
  | '/collection/$id'
  | '/genre/$id'
  | '/keyword/$id'
  | '/studio/$id'
  | '/network/$id'
  | '/provider/$id'
  | '/music'
  | '/music/album/$mbid'
  | '/music/artist/$mbid'
  | '/audiobooks'
  | '/audiobooks/book/$asin'
  | '/audiobooks/author/$asin'
  | '/requests'
  | '/issues'
  | '/profile';

export interface DiscoverTarget {
  to: DiscoverPath;
  params?: Record<string, string> | undefined;
  search?: Record<string, unknown> | undefined;
}

/** Link target of a title page. */
export function titleTarget(mediaType: 'movie' | 'series', tmdbId: number): DiscoverTarget {
  return { to: mediaType === 'movie' ? '/movie/$tmdbId' : '/tv/$tmdbId', params: { tmdbId: String(tmdbId) } };
}

/** The full route path of a discover target in a tree (for tests and plain hrefs). */
export function discoverPath(base: DiscoverBase, target: DiscoverTarget): string {
  let path = `${base}${target.to}`;
  for (const [k, v] of Object.entries(target.params ?? {})) path = path.replace(`$${k}`, encodeURIComponent(v));
  return path;
}

export type DLinkProps = DiscoverTarget &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    replace?: boolean | undefined;
    children?: ReactNode;
  };

/** A Link to a discover sub-route in the current tree (app or portal). */
export function DLink({ to, params, search, replace, ...anchor }: DLinkProps) {
  const base = useDiscoverBase();
  // One cast point: both trees register these sub-routes, the base picks the tree.
  const props = {
    to: `${base}${to}`,
    ...(params ? { params } : {}),
    ...(search ? { search } : {}),
    ...(replace ? { replace } : {}),
  } as unknown as Parameters<typeof Link>[0];
  return <Link {...props} {...(anchor as object)} />;
}

/** navigate() for discover sub-routes in the current tree. */
export function useDiscoverNavigate() {
  const base = useDiscoverBase();
  const navigate = useNavigate();
  return useCallback(
    (target: DiscoverTarget & { replace?: boolean }) =>
      navigate({
        to: `${base}${target.to}`,
        ...(target.params ? { params: target.params } : {}),
        ...(target.search ? { search: target.search } : {}),
        ...(target.replace ? { replace: true } : {}),
      } as unknown as Parameters<typeof navigate>[0]),
    [base, navigate],
  );
}
