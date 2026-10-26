import type { MediaManagementSettings, MigratePathMapping } from '@media-tron/shared';
import { bool, int, str } from '../foreign-db.js';
import { remapPath } from '../paths.js';

// The arr `Config` table (Key/Value rows, keys lower-case, values strings) → the
// mediaManagement settings section. Only keys present upstream are carried over.

export function mapMediaManagement(config: Record<string, string>, mappings: readonly MigratePathMapping[]): Partial<MediaManagementSettings> {
  const out: Partial<MediaManagementSettings> = {};
  const has = (k: string) => config[k] !== undefined;
  const flag = (k: string) => bool(config[k]);

  if (has('enablecompleteddownloadhandling')) out.enableCompletedDownloadHandling = flag('enablecompleteddownloadhandling');
  if (has('autoredownloadfailed')) out.autoRedownloadFailed = flag('autoredownloadfailed');
  const recycle = str(config['recyclebin']);
  if (recycle) out.recycleBinPath = remapPath(recycle, mappings).path;
  const cleanup = int(config['recyclebincleanupdays']);
  if (cleanup !== null && cleanup >= 0 && cleanup <= 365) out.recycleBinCleanupDays = cleanup;
  if (has('importextrafiles')) out.importExtraFiles = flag('importextrafiles');
  if (has('extrafileextensions')) {
    out.extraFileExtensions = (config['extrafileextensions'] ?? '')
      .split(',')
      .map((e) => e.trim().replace(/^\./, ''))
      .filter(Boolean);
  }
  if (has('copyusinghardlinks')) out.useHardlinks = flag('copyusinghardlinks');
  if (has('skipfreespacecheckwhenimporting')) out.skipFreeSpaceCheck = flag('skipfreespacecheckwhenimporting');
  const minFree = int(config['minimumfreespacewhenimporting']);
  if (minFree !== null && minFree >= 0) out.minimumFreeSpaceMb = minFree;
  const createEmpty = config['createemptyseriesfolders'] ?? config['createemptymoviefolders'];
  if (createEmpty !== undefined) out.createEmptySeriesFolders = bool(createEmpty);
  if (has('deleteemptyfolders')) out.deleteEmptyFolders = flag('deleteemptyfolders');
  if (has('setpermissionslinux')) out.setPermissions = flag('setpermissionslinux');
  const chmod = str(config['chmodfolder']);
  if (chmod && /^[0-7]{3,4}$/.test(chmod)) out.chmodFolder = chmod;
  if (has('chowngroup')) out.chownGroup = config['chowngroup'] ?? '';
  if (has('enablemediainfo')) out.enableMediaInfo = flag('enablemediainfo');

  const lower = (k: string) => (config[k] ?? '').toLowerCase();
  const rescan = lower('rescanafterrefresh');
  if (rescan === 'always' || rescan === '0') out.rescanAfterRefresh = 'always';
  else if (rescan === 'aftermanual' || rescan === '1') out.rescanAfterRefresh = 'afterManual';
  else if (rescan === 'never' || rescan === '2') out.rescanAfterRefresh = 'never';

  const title = lower('episodetitlerequired');
  if (title === 'always' || title === '0') out.episodeTitleRequired = 'always';
  else if (title === 'bulkseasonreleases' || title === '1') out.episodeTitleRequired = 'bulkSeasonReleases';
  else if (title === 'never' || title === '2') out.episodeTitleRequired = 'never';

  const propers = lower('downloadpropersandrepacks');
  if (propers === 'preferandupgrade' || propers === '0') out.downloadPropersAndRepacks = 'preferAndUpgrade';
  else if (propers === 'donotupgrade' || propers === '1') out.downloadPropersAndRepacks = 'doNotUpgrade';
  else if (propers === 'donotprefer' || propers === '2') out.downloadPropersAndRepacks = 'doNotPrefer';

  const fileDate = lower('filedate');
  if (fileDate === 'none') out.fileDateMode = 'none';
  else if (fileDate === 'localairdate') out.fileDateMode = 'localAirDate';
  else if (fileDate === 'utcairdate') out.fileDateMode = 'utcAirDate';
  else if (fileDate === 'cinemas' || fileDate === 'release') out.fileDateMode = 'releaseDate';
  return out;
}
