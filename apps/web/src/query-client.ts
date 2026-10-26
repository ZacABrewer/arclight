import { MutationCache, QueryClient } from '@tanstack/react-query';
import { errorMessage } from './api/client.js';
import { toasts as defaultToasts, type ToastStore } from './lib/toast.js';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** Title of the error toast shown when this mutation fails. */
      errorTitle?: string;
      /** Set when the caller renders the error itself and no toast is wanted. */
      silent?: boolean;
    };
  }
}

/** Failed mutations raise an error toast unless they opt out with `meta.silent`. */
export function createQueryClient(toasts: ToastStore = defaultToasts): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (mutation.meta?.silent) return;
        toasts.error(mutation.meta?.errorTitle ?? 'Something went wrong', errorMessage(error));
      },
    }),
    defaultOptions: {
      queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });
}
