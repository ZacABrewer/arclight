import type { HealthCheckDef } from '../types.js';
import { configDiskSpaceCheck, rootFolderFreeSpaceCheck } from './disk-space.js';
import {
  createStaleImportCheck,
  downloadClientCheck,
  downloadClientRemovesCompletedCheck,
  remotePathMappingCheck,
} from './download-clients.js';
import { indexerCheck, indexerLongTermStatusCheck, indexerRssCheck, indexerSearchCheck, indexerStatusCheck } from './indexers.js';
import { notificationConfigCheck, notificationStatusCheck } from './notifications.js';
import { mountReadOnlyCheck, recycleBinCheck, rootFolderCheck } from './root-folders.js';
import { flareSolverrUnreachableCheck } from './flaresolverr.js';
import { hardLinkCheck } from './hard-links.js';
import { feedStaleCheck, indexerCatalogueEmptyCheck } from './feeds.js';
import { torrentEngineCheck } from './torrent.js';
import { diskGuardCheck, downloadDiskSpaceCheck, killSwitchFlappingCheck, stalledDownloadsCheck, torrentLockdownCheck } from './downloads.js';
import { remoteEngineUnreachableCheck } from './remote-engine.js';
import { vpnDisconnectedCheck } from './vpn.js';
import { whisperUnreachableCheck } from '../../subtitles/whisper.js';
import { dockerPermissionsCheck, metadataSourceCheck, systemTimeCheck, updateCheck } from './system.js';

export * from './disk-space.js';
export * from './flaresolverr.js';
export * from './hard-links.js';
export * from './feeds.js';
export * from './download-clients.js';
export * from './downloads.js';
export * from './indexers.js';
export * from './notifications.js';
export * from './root-folders.js';
export * from './system.js';
export * from './torrent.js';
export * from './remote-engine.js';
export * from './vpn.js';

/** The Phase-1 catalogue, in display order. Fresh instances (some checks keep state). */
export function createChecks(): HealthCheckDef[] {
  return [
    configDiskSpaceCheck,
    dockerPermissionsCheck,
    systemTimeCheck,
    updateCheck,
    metadataSourceCheck,
    rootFolderCheck,
    rootFolderFreeSpaceCheck,
    mountReadOnlyCheck,
    recycleBinCheck,
    downloadClientCheck,
    downloadClientRemovesCompletedCheck,
    remotePathMappingCheck,
    hardLinkCheck,
    createStaleImportCheck(),
    downloadDiskSpaceCheck,
    diskGuardCheck,
    stalledDownloadsCheck,
    indexerCheck,
    indexerStatusCheck,
    indexerLongTermStatusCheck,
    indexerRssCheck,
    indexerSearchCheck,
    flareSolverrUnreachableCheck,
    notificationConfigCheck,
    notificationStatusCheck,
    vpnDisconnectedCheck,
    torrentEngineCheck,
    torrentLockdownCheck,
    killSwitchFlappingCheck,
    remoteEngineUnreachableCheck,
    feedStaleCheck,
    indexerCatalogueEmptyCheck,
    whisperUnreachableCheck,
  ];
}
