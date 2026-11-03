/**
 * Keeps an in-memory map (rate-limit counters, short-lived caches) from growing without bound:
 * drops the entries `expired` says are stale, then the oldest insertions until at most `max`
 * remain. Maps iterate in insertion order, so "oldest" is the first key.
 */
export function pruneMap<K, V>(map: Map<K, V>, max: number, expired: (value: V) => boolean): void {
  for (const [key, value] of map) if (expired(value)) map.delete(key);
  while (map.size > max) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}
