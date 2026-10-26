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
import { vpnDisconnectedCheck } from './vpn.js';
import { dockerPermissionsCheck, metadataSourceCheck, systemTimeCheck, updateCheck } from './system.js';

export * from './disk-space.js';
export * from './download-clients.js';
export * from './indexers.js';
export * from './notifications.js';
export * from './root-folders.js';
export * from './system.js';
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
    createStaleImportCheck(),
    indexerCheck,
    indexerStatusCheck,
    indexerLongTermStatusCheck,
    indexerRssCheck,
    indexerSearchCheck,
    notificationConfigCheck,
    notificationStatusCheck,
    vpnDisconnectedCheck,
  ];
}
