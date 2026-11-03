import type { ComponentType } from 'react';
import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { ProfileSettings, type HouseholdProfile, type HouseholdProfilesResponse, type Session } from '@arclight/shared';
import { AuthStateProvider, type AuthState } from '../../../auth/auth-context.js';
import { ADMIN_ACCESS } from '../../../auth/access.js';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { parseProfilesSearch } from './profile-session.js';

// Harness for the picker, the account menu and Settings > Profiles: the given pages under a bare
// root (with /player/profiles reading its search like the app's router), a signed-in auth state
// whose active profile is `activeId`, and household profiles built by `profile()`.

export const PROFILES_API = '/api/v1/households/profiles';

export function profile(id: number, over: Partial<HouseholdProfile> = {}): HouseholdProfile {
  const name = over.name ?? (id === 1 ? 'Owner' : `P${id}`);
  return {
    id,
    name,
    color: '#7c6cf0',
    initial: name[0]!,
    isOwner: id === 1,
    hasPin: false,
    contentRestrictions: null,
    settings: ProfileSettings.parse({}),
    sortOrder: id,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

export function profilesResponse(profiles: HouseholdProfile[], activeId = 1, max = 12): HouseholdProfilesResponse {
  const active = profiles.find((p) => p.id === activeId);
  return { profiles, activeProfileId: activeId, canManage: Boolean(active?.isOwner), max };
}

export function authFor(active: HouseholdProfile): AuthState {
  const session = {
    activeProfile: { id: active.id, name: active.name, color: active.color, initial: active.initial, isOwner: active.isOwner },
  } as unknown as Session;
  return {
    status: null,
    session,
    user: { id: 1, username: 'owner', displayName: 'Owner', settings: {} } as unknown as AuthState['user'],
    isAdmin: true,
    access: ADMIN_ACCESS,
    refresh: async () => {},
    logout: async () => {},
  };
}

export function renderPages(path: string, pages: Record<string, ComponentType>, auth: AuthState) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute({ component: () => <Outlet /> });
  const children = Object.entries(pages).map(([p, Page]) =>
    createRoute({ getParentRoute: () => root, path: p, validateSearch: p === '/player/profiles' ? parseProfilesSearch : undefined, component: () => <Page /> }),
  );
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree: root.addChildren(children), history });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <AuthStateProvider value={auth}>
          <RouterProvider router={router as never} />
        </AuthStateProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router, history, queryClient };
}
