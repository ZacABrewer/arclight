import { randomBytes } from 'node:crypto';
import { hashToken } from '../auth/hash.js';
import { TokenBuckets, type RateLimitOptions } from './portal.js';

// Plex PIN sign-in and linking are bound to the browser (and, for linking, the account) that
// created the PIN. plex.tv PIN ids are small sequential integers, so the id alone proves nothing:
// creating a PIN sets a short-lived HttpOnly cookie, and a poll for that id only goes to plex.tv
// when the cookie matches. A PIN finishes once; both routes are rate-limited per peer and per PIN.

/** Browser-binding cookie of a Plex PIN in flight. */
export const PLEX_PIN_COOKIE = 'al_plex';
/** plex.tv PINs live 15 minutes; the binding never outlives them. */
export const PLEX_PIN_TTL_MS = 15 * 60_000;
const MAX_PINS = 5_000;

/** PIN creation per peer: a few retries, then one every 30 seconds. */
export const PLEX_PIN_CREATE_LIMIT: RateLimitOptions = { capacity: 10, refillPerSecond: 1 / 30 };
/** Polls per peer: several tabs behind one address polling every 2 seconds. */
export const PLEX_POLL_PEER_LIMIT: RateLimitOptions = { capacity: 60, refillPerSecond: 2 };
/** Polls per PIN: the web client polls every 2 seconds. */
export const PLEX_POLL_PIN_LIMIT: RateLimitOptions = { capacity: 10, refillPerSecond: 1 };

interface PendingPin {
  /** sha256 of the binding cookie. */
  bindingHash: string;
  /** The signed-in user linking their account; null for a sign-in. */
  userId: number | null;
  expires: number;
  /** A poll is talking to plex.tv; a parallel poll waits instead of finishing it twice. */
  busy: boolean;
}

export type PinCheck = 'ok' | 'busy' | 'forbidden';

/** 429 with Retry-After. */
export class PlexPinRateLimited extends Error {
  constructor(readonly retryAfter: number) {
    super('too many Plex sign-in attempts; wait a moment and try again');
    this.name = 'PlexPinRateLimited';
  }
}

export class PlexPinGuard {
  private readonly pins = new Map<number, PendingPin>();
  private readonly creates: TokenBuckets;
  private readonly peerPolls: TokenBuckets;
  private readonly pinPolls: TokenBuckets;

  constructor(private readonly now: () => number = Date.now) {
    this.creates = new TokenBuckets(PLEX_PIN_CREATE_LIMIT, now);
    this.peerPolls = new TokenBuckets(PLEX_POLL_PEER_LIMIT, now);
    this.pinPolls = new TokenBuckets(PLEX_POLL_PIN_LIMIT, now);
  }

  /**
   * Counts a PIN creation by `peer`; throws PlexPinRateLimited over the limit, or when the table
   * is full (refused rather than evicting someone's real sign-in).
   */
  throttleCreate(peer: string): void {
    if (!this.creates.take(peer)) throw new PlexPinRateLimited(Math.max(1, this.creates.retryAfter(peer)));
    this.prune();
    if (this.pins.size >= MAX_PINS) throw new PlexPinRateLimited(60);
  }

  /** Counts a poll; throws PlexPinRateLimited over the per-peer or per-PIN limit. */
  throttlePoll(peer: string, pinId: number): void {
    if (!this.peerPolls.take(peer)) throw new PlexPinRateLimited(Math.max(1, this.peerPolls.retryAfter(peer)));
    const key = String(pinId);
    if (!this.pinPolls.take(key)) throw new PlexPinRateLimited(Math.max(1, this.pinPolls.retryAfter(key)));
  }

  /** Remembers a new PIN; returns the binding value for the cookie. */
  bind(pinId: number, userId: number | null): string {
    const binding = randomBytes(32).toString('base64url');
    this.pins.set(pinId, { bindingHash: hashToken(binding), userId, expires: this.now() + PLEX_PIN_TTL_MS, busy: false });
    return binding;
  }

  /**
   * A poll for `pinId` from a caller holding `binding`, as `userId` (null: the sign-in flow).
   * 'busy' while another poll of the same PIN is in flight; 'ok' marks it busy until
   * release() or finish().
   */
  claim(pinId: number, binding: string | undefined, userId: number | null): PinCheck {
    const pin = this.pins.get(pinId);
    if (!pin || pin.expires <= this.now()) {
      if (pin) this.pins.delete(pinId);
      return 'forbidden';
    }
    if (!binding || hashToken(binding) !== pin.bindingHash || pin.userId !== userId) return 'forbidden';
    if (pin.busy) return 'busy';
    pin.busy = true;
    return 'ok';
  }

  /** The poll ended without finishing (still pending, or failed): the PIN may be polled again. */
  release(pinId: number): void {
    const pin = this.pins.get(pinId);
    if (pin) pin.busy = false;
  }

  /** The PIN signed someone in or linked an account: it is spent. */
  finish(pinId: number): void {
    this.pins.delete(pinId);
  }

  private prune(): void {
    const t = this.now();
    for (const [id, pin] of this.pins) if (pin.expires <= t) this.pins.delete(id);
  }
}

export function plexPinCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [`${PLEX_PIN_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
