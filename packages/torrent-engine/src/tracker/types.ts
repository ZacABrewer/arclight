import type { PeerAddress } from '../compact.js';

export type AnnounceEvent = 'started' | 'stopped' | 'completed';

export interface AnnounceParams {
  infoHash: Buffer;
  peerId: Buffer;
  port: number;
  uploaded: number;
  downloaded: number;
  left: number;
  event?: AnnounceEvent;
  /** Number of peers wanted (default 50). */
  numwant?: number;
  /** Random 32-bit value identifying this client across IP changes. */
  key: number;
}

export interface AnnounceResponse {
  intervalSec: number;
  minIntervalSec?: number;
  peers: PeerAddress[];
  /** Seeders. */
  complete?: number;
  /** Leechers. */
  incomplete?: number;
  trackerId?: string;
  warning?: string;
}

export interface ScrapeResponse {
  complete: number;
  incomplete: number;
  downloaded: number;
}

/** A single tracker endpoint (HTTP or UDP). */
export interface TrackerClient {
  readonly url: string;
  announce(params: AnnounceParams, signal?: AbortSignal): Promise<AnnounceResponse>;
  scrape(infoHash: Buffer, signal?: AbortSignal): Promise<ScrapeResponse>;
  close(): void;
}
