// Disk guard: keeps downloads from outrunning the disk. On a busy array (a 4-disk RAID5 NAS
// shared with a media server sustains well under what a fast VPN link delivers) received blocks
// piled up waiting for the disk: memory grew, the engine stalled on backpressure, and seeding
// reads queued behind the writes. Setting the download limit by hand to what the disk could
// take was the only cure. The guard does that on its own: while the write backlog builds up it
// lowers the session download limit to a little under what the disk actually completed, then
// raises it step by step while the disk keeps up, and lets go once the limit is well above what
// the swarm delivers anyway.

/** Floor: downloads keep moving even while the disk is badly behind. */
export const DISK_GUARD_MIN_DOWN = 1024 * 1024;
/** The limit is set to this share of the measured write rate, so the backlog can drain. */
const HEADROOM = 0.9;
/** Backlog share of the downloading torrents' limits that counts as behind, and as healthy. */
const BEHIND = 0.5;
const HEALTHY = 0.2;
/** Healthy samples in a row before the limit is raised one step. */
const HEALTHY_STEPS = 3;
const RAISE = 1.25;

export interface DiskSample {
  /** Sample time in ms. */
  at: number;
  /** Bytes written to disk since the engine started (a counter; a lower value means it restarted). */
  writtenBytes: number;
  /** Received bytes waiting for the disk, every torrent. */
  backlogBytes: number;
  /** Sum of the downloading torrents' write backlog limits. */
  backlogLimitBytes: number;
  /** Torrents that stopped requesting until their write backlog drains. */
  backpressured: number;
  /** Session download rate (bytes/s). */
  downloadRate: number;
}

export class DiskGuard {
  /** Bytes/s, null = not limited by the guard. */
  downloadLimit: number | null = null;
  /** Measured disk write throughput (bytes/s, smoothed). */
  writeRate = 0;
  backlogBytes = 0;
  backlogLimitBytes = 0;
  private last: { at: number; written: number } | null = null;
  private healthy = 0;

  get active(): boolean {
    return this.downloadLimit !== null;
  }

  /** One sample of the engine's write state. True when the limit changed. */
  observe(s: DiskSample): boolean {
    const last = this.last;
    this.last = { at: s.at, written: s.writtenBytes };
    this.backlogBytes = s.backlogBytes;
    this.backlogLimitBytes = s.backlogLimitBytes;
    if (!last || s.at <= last.at || s.writtenBytes < last.written) return false;
    const rate = ((s.writtenBytes - last.written) * 1000) / (s.at - last.at);
    this.writeRate = this.writeRate === 0 ? rate : this.writeRate * 0.5 + rate * 0.5;
    const limit = s.backlogLimitBytes;
    const behind = s.backpressured > 0 || (limit > 0 && s.backlogBytes >= limit * BEHIND);
    if (behind) {
      this.healthy = 0;
      // With a backlog the disk is the bottleneck, so what it completed is what it can take.
      const target = Math.max(DISK_GUARD_MIN_DOWN, Math.round(this.writeRate * HEADROOM));
      const next = this.downloadLimit === null ? target : Math.min(this.downloadLimit, target);
      if (next === this.downloadLimit) return false;
      this.downloadLimit = next;
      return true;
    }
    if (this.downloadLimit === null) return false;
    // Between behind and healthy: hold the limit.
    if (s.backpressured > 0 || (limit > 0 && s.backlogBytes > limit * HEALTHY)) {
      this.healthy = 0;
      return false;
    }
    if (++this.healthy < HEALTHY_STEPS) return false;
    this.healthy = 0;
    const next = Math.round(this.downloadLimit * RAISE);
    // Released once the limit is well above what downloads actually use (the swarm is the limit).
    this.downloadLimit = next > Math.max(s.downloadRate * 2, DISK_GUARD_MIN_DOWN * 2) ? null : next;
    return true;
  }

  reset(): void {
    this.downloadLimit = null;
    this.healthy = 0;
    this.last = null;
    this.writeRate = 0;
    this.backlogBytes = 0;
    this.backlogLimitBytes = 0;
  }
}
