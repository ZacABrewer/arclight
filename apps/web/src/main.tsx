import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { ErrorBoundary } from './components/error-boundary.js';
import { ToastProvider } from './components/toast.js';
import { toasts } from './lib/toast.js';
import { createQueryClient } from './query-client.js';
import { createAppRouter } from './router.js';
import './styles/index.css';

const queryClient = createQueryClient(toasts);
const router = createAppRouter(queryClient);

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
