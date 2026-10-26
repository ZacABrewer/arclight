import { posix, win32 } from 'node:path';
import type { HealthCheck } from '@arclight/shared';
import { finding, formatMiB, type HealthCheckDef, type HealthDeps } from '../types.js';

// Checks over the downloads in flight: will they fit on disk, are any of them stuck, and is
// the built-in engine's VPN kill switch holding them (or flapping).

/** Lockdowns within an hour from which the kill switch counts as flapping. */
export const KILL_SWITCH_FLAP_THRESHOLD = 3;

/** Free space on a folder that may not exist yet: tries it and up to two parents. */
async function freeSpaceNear(deps: HealthDeps, dir: string): Promise<number | null> {
  const dirname = deps.platform === 'win32' ? win32.dirname : posix.dirname;
  let current = dir;
  for (let i = 0; i < 3; i++) {
    const free = await deps.fs.freeSpace(current);
    if (free !== null) return free;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Bytes still to download against free space, per download folder: error when the active
 * downloads will not fit, warning when finishing them leaves less than the minimum free space
 * (Settings > Media Management).
 */
export const downloadDiskSpaceCheck: HealthCheckDef = {
  id: 'DownloadDiskSpace',
  async run(deps) {
    if (!deps.activeDownloads) return [];
    const dirname = deps.platform === 'win32' ? win32.dirname : posix.dirname;
    const groups = new Map<string, { left: number; titles: string[] }>();
    for (const d of await deps.activeDownloads()) {
      if (!d.path || d.sizeLeft <= 0) continue;
      const dir = dirname(d.path);
      const group = groups.get(dir) ?? { left: 0, titles: [] };
      group.left += d.sizeLeft;
      group.titles.push(d.title);
      groups.set(dir, group);
    }
    const minFree = deps.minimumFreeSpaceBytes?.() ?? 0;
    const out: HealthCheck[] = [];
    for (const [dir, group] of groups) {
      const free = await freeSpaceNear(deps, dir);
      if (free === null) continue;
      const count = `${group.titles.length} download(s)`;
      if (group.left > free) {
        out.push(
          finding(
            this.id,
            'error',
            `${count} in ${dir} still need ${formatMiB(group.left)} but only ${formatMiB(free)} is free: they cannot finish.`,
            'download-disk-space-full',
          ),
        );
      } else if (free - group.left < minFree) {
        out.push(
          finding(
            this.id,
            'warning',
            `${count} in ${dir} will leave ${formatMiB(free - group.left)} free when finished, below the ${formatMiB(minFree)} minimum.`,
            'download-disk-space-low',
          ),
        );
      }
    }
    return out;
  },
};

/**
 * The disk-space guard is holding things: downloads paused because their volume fell below the
 * minimum free space, grabs held until there is room. Clears itself once both are back.
 */
export const diskGuardCheck: HealthCheckDef = {
  id: 'DownloadDiskGuard',
  async run(deps) {
    if (!deps.diskGuard) return [];
    const g = await deps.diskGuard();
    const out: HealthCheck[] = [];
    const min = formatMiB(g.minimumFreeBytes);
    if (g.pausedTitles.length > 0) {
      const where = g.volumes.map((v) => `${v.path} (${formatMiB(v.freeBytes)} free)`).join(', ');
      out.push(
        finding(
          this.id,
          'error',
          `Paused ${g.pausedTitles.length} download(s) because the download volume is below the ${min} minimum free space${where ? `: ${where}` : ''}. They resume automatically when space is freed.`,
          'download-disk-guard-paused',
        ),
      );
    }
    if (g.heldTitles.length > 0) {
      const names = g.heldTitles.slice(0, 3).join(' | ');
      const more = g.heldTitles.length > 3 ? ` and ${g.heldTitles.length - 3} more` : '';
      out.push(
        finding(
          this.id,
          'warning',
          `${g.heldTitles.length} grab(s) are held until the download volume has room (minimum free space ${min}): ${names}${more}`,
          'download-disk-guard-held',
        ),
      );
    }
    return out;
  },
};

/** Downloads without new data for longer than the stall threshold. */
export const stalledDownloadsCheck: HealthCheckDef = {
  id: 'DownloadStalled',
  async run(deps) {
    if (!deps.activeDownloads) return [];
    const stalled = (await deps.activeDownloads()).filter((d) => d.stalledSince !== undefined);
    if (stalled.length === 0) return [];
    const names = stalled
      .slice(0, 5)
      .map((d) => `${d.title} (since ${d.stalledSince})`)
      .join(' | ');
    const more = stalled.length > 5 ? ` and ${stalled.length - 5} more` : '';
    return [finding(this.id, 'warning', `${stalled.length} download(s) stopped receiving data: ${names}${more}`, 'download-stalled')];
  },
};

/** The built-in engine is locked down (VPN down or not checked yet): its torrents are paused. */
export const torrentLockdownCheck: HealthCheckDef = {
  id: 'TorrentEngineLockdown',
  async run(deps) {
    if (!deps.torrent) return [];
    const st = await deps.torrent();
    if (st.state !== 'lockdown') return [];
    const since = st.lockdownSince ? ` since ${st.lockdownSince}` : '';
    const reason = (st.lockdownReason ?? 'VPN down').replace(/[.\s]+$/, '');
    const paused = st.killSwitchPaused ? ` ${st.killSwitchPaused} torrent(s) are paused and resume when the VPN reconnects.` : '';
    return [
      finding(
        this.id,
        'warning',
        `The built-in torrent engine is locked down by the VPN kill switch${since}: ${reason}.${paused}`,
        'torrent-engine-lockdown',
      ),
    ];
  },
};

/** The kill switch engaged repeatedly within an hour: the VPN (or its status checks) is unstable. */
export const killSwitchFlappingCheck: HealthCheckDef = {
  id: 'VpnKillSwitchFlapping',
  async run(deps) {
    if (!deps.torrent) return [];
    const count = (await deps.torrent()).lockdownsLastHour ?? 0;
    if (count < KILL_SWITCH_FLAP_THRESHOLD) return [];
    return [
      finding(
        this.id,
        'warning',
        `The VPN kill switch paused the built-in engine's downloads ${count} times in the last hour. The VPN connection or its status checks are unstable.`,
        'vpn-kill-switch-flapping',
      ),
    ];
  },
};
