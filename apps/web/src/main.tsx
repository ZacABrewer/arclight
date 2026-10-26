import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { ErrorBoundary } from './components/error-boundary.js';
import { ToastProvider } from './components/toast.js';
import { toasts } from './lib/toast.js';
import { createQueryClient } from './query-client.js';
import { createAppRouter } from './router.js';
import { setUnauthorizedHandler } from './api/client.js';
import { authKeys, loginHref } from './auth/guard.js';
import './styles/index.css';

const queryClient = createQueryClient(toasts);
const router = createAppRouter(queryClient);

// A 401 from any api call means the session ended: drop the cached auth state and go to
// /login, coming back here afterwards.
setUnauthorizedHandler(() => {
  const { pathname, href } = router.state.location;
  if (pathname === '/login' || pathname === '/setup') return;
  void queryClient.invalidateQueries({ queryKey: authKeys.all });
  void router.navigate({ href: loginHref(href), replace: true });
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider store={toasts}>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
