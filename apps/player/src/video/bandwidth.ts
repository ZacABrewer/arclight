import { getSession } from '../core/session';

// The last throughput the native video player measured, per account and network type, so the
// next video starts on a fitting HLS rung instead of Media3's generic guess (playback design §4.7):
// localStorage['arclight.bandwidth.<accountId>.<network>'] = kbit/s. A hint only: the player's
// meter takes over after the first segments.

export type NetworkKind = 'cellular' | 'other';

const MAX_KBPS = 10_000_000;

type Id = number | string | null | undefined;

const key = (accountId: Id, network: NetworkKind) => `arclight.bandwidth.${accountId ?? 'none'}.${network}`;
const activeAccount = (): string | null => getSession()?.accountId ?? null;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved estimate in kbit/s, or null when none (or unreadable). */
export function readBandwidth(network: NetworkKind, s: Storage | null = store(), accountId: Id = activeAccount()): number | null {
  try {
    const v = Number(s?.getItem(key(accountId, network)) ?? NaN);
    return Number.isInteger(v) && v > 0 && v <= MAX_KBPS ? v : null;
  } catch {
    return null;
  }
}

/** Saves an estimate (ignored unless a whole number of kbit/s in range). */
export function writeBandwidth(network: NetworkKind, kbps: number, s: Storage | null = store(), accountId: Id = activeAccount()): void {
  const v = Math.round(kbps);
  if (!Number.isFinite(v) || v <= 0 || v > MAX_KBPS) return;
  try {
    s?.setItem(key(accountId, network), String(v));
  } catch {
    // Blocked storage: the player starts from its own guess.
  }
}
