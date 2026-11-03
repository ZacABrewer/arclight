import type { Db } from '../../db/index.js';

// Stub of builder A's My List readers (redesign spec §3.2), replaced by the households branch at
// merge. Keys are "movie:<id>" / "series:<id>".

/** Which of `keys` are on the profile's My List. */
export async function myListHas(_db: Db, _profileId: number, _keys: string[]): Promise<Set<string>> {
  return new Set();
}

/** The profile's My List keys, newest first, at most `limit`. */
export async function myListKeys(_db: Db, _profileId: number, _limit: number): Promise<string[]> {
  return [];
}
