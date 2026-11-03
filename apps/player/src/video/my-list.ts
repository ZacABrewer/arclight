import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MyListResponse, type MyListKey } from '@arclight/shared';
import { browseKeys } from '@web/features/player/browse/api';
import { request } from '../core/api';

// My List (spec §1.2, §9 Q20): the active profile's saved titles.
//   GET    /playback/my-list        { items: VideoCard[] } newest first
//   PUT    /playback/my-list/:key   add ("movie:12" / "series:3")
//   DELETE /playback/my-list/:key   remove
// Under the browse prefix, so a profile switch (which refetches everything) refreshes it too.

export const myListKeys = { list: () => [...browseKeys.all, 'my-list'] as const };

export const myListApi = {
  list: () => request('/playback/my-list', MyListResponse),
  add: (key: MyListKey) => request(`/playback/my-list/${encodeURIComponent(key)}`, null, { method: 'PUT' }),
  remove: (key: MyListKey) => request(`/playback/my-list/${encodeURIComponent(key)}`, null, { method: 'DELETE' }),
};

export function useMyList(enabled = true) {
  return useQuery({ queryKey: myListKeys.list(), queryFn: myListApi.list, enabled, retry: false, meta: { silent: true } });
}

/** Add or remove a title, then refresh every page that shows "in My List". */
export function useToggleMyList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, add }: { key: MyListKey; add: boolean }) => (add ? myListApi.add(key) : myListApi.remove(key)),
    onSettled: () => qc.invalidateQueries({ queryKey: browseKeys.all }),
  });
}
