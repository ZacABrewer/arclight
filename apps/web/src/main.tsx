import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { ErrorBoundary } from './components/error-boundary.js';
import { ToastProvider } from './components/toast.js';
import { toasts } from './lib/toast.js';
import { createQueryClient } from './query-client.js';
import { createAppRouter } from './router.js';
import { readPortalDocument } from './features/discover/portal-location.js';
import { setUnauthorizedHandler } from './api/client.js';
import { authKeys, isPublicPath, loginHref } from './auth/guard.js';
import { registerServiceWorker } from './register-sw.js';
import { I18nProvider, applyLocaleSetting } from './i18n/index.js';
import './arclight/fonts.js';
import './styles/index.css';

const queryClient = createQueryClient(toasts);
// The server marks portal pages (portal paths and hostnames); the router maps them onto /portal.
const router = createAppRouter(queryClient, readPortalDocument());

// A 401 from any api call means the session ended: drop the cached auth state and go to
// /login (with the "session expired" banner), coming back here afterwards.
setUnauthorizedHandler(() => {
  const { pathname, href } = router.state.location;
  // Public pages (the request portal) answer anonymous visitors; a 401 there is not a lost session.
  if (pathname === '/login' || pathname === '/setup' || isPublicPath(pathname)) return;
  void queryClient.invalidateQueries({ queryKey: authKeys.all });
  void router.navigate({ href: loginHref(href, true), replace: true });
});

registerServiceWorker();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

// Load the UI language before the first paint (English is bundled; others are one small
// chunk). The signed-in user's own setting is applied by AuthProvider once the session loads.
void applyLocaleSetting().finally(() => {
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ToastProvider store={toasts}>
              <RouterProvider router={router} />
            </ToastProvider>
          </I18nProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
});
