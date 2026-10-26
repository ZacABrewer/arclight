import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client.js';
import { libraryApi } from '../api/library.js';
import { libraryKeys } from './library-keys.js';

/**
 * Calendar items for a range. Resolves to `null` while the calendar module is not registered
 * (404) so the page can say so instead of erroring.
 * Note: live.ts does not invalidate ['calendar'] on library events yet; the page refetches on
 * mount and every 5 minutes.
 */
export function useCalendar(start: string, end: string, unmonitored: boolean) {
  return useQuery({
    queryKey: libraryKeys.calendar.range(start, end, unmonitored),
    queryFn: async () => {
      try {
        return await libraryApi.calendar.list({ start, end, unmonitored });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404 && err.path === '/calendar') return null;
        throw err;
      }
    },
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}

/** iCal feed location; `null` when the route is not served yet. */
export function useCalendarFeed(enabled: boolean) {
  return useQuery({
    queryKey: [...libraryKeys.calendar.all, 'feed'],
    queryFn: async () => {
      try {
        return await libraryApi.calendar.feed();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled,
    retry: false,
    staleTime: Infinity,
  });
}
