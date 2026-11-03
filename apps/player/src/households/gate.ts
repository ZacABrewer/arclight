import type { QueryClient } from '@tanstack/react-query';
import type { HouseholdProfilesResponse } from '@arclight/shared';
import { householdKeys, householdsApi } from './api';
import { isPicked, needsPicker } from './state';

/**
 * Before any /player page: should "Who's watching?" come first? Only on the first page of an
 * app run, for accounts with two or more profiles. A server without households (older version,
 * 404) or no network: straight in, after one try (it holds up the first page).
 */
export async function shouldShowPicker(
  qc: QueryClient,
  accountId: string,
  fetchProfiles: () => Promise<HouseholdProfilesResponse> = householdsApi.profiles,
  storage?: Storage | null,
): Promise<boolean> {
  if (isPicked(accountId, storage)) return false;
  try {
    const res = await qc.fetchQuery({ queryKey: householdKeys.profiles(), queryFn: fetchProfiles, staleTime: 30_000, retry: false });
    return needsPicker(res, accountId, storage);
  } catch {
    return false;
  }
}
