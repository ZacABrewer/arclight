// Health check docs: one entry per `wikiUrl` anchor the api's health checks emit
// (apps/api/src/modules/health/checks/*.ts, apps/api/src/modules/updates/health.ts). The
// health docs page renders this table so every "How to fix" link resolves in-app.
// health-docs.test.ts fails when a check gains an anchor that is missing here.
import { t } from '../../i18n/index.js';

export interface HealthDoc {
  /** Anchor in /docs/system/health#<anchor>. */
  anchor: string;
  /** Check id(s) (`source` of the finding). */
  sources: string[];
  title: string;
  /** What the finding means. */
  cause: string;
  /** What to do, in order. */
  fix: string[];
  /** In-app page that fixes it. */
  link?: { label: string; to: string };
}

export const HEALTH_DOCS: readonly HealthDoc[] = [
  {
    anchor: 'config-disk-space-low',
    sources: ['ConfigDiskSpace'],
    get title() {
      return t('docs.healthDocs.configVolumeIsLowOn');
    },
    get cause() {
      return t('docs.healthDocs.lessThan1GibIs');
    },
    get fix() {
      return [t('docs.healthDocs.freeSpaceOnTheConfig'), t('docs.healthDocs.lowerLogAndBackupRetention')];
    },
    link: { get label() { return t('common.backups'); }, to: '/system/backup' },
  },
  {
    anchor: 'root-folder-low-free-space',
    sources: ['RootFolderFreeSpace'],
    get title() {
      return t('docs.healthDocs.rootFolderIsLowOn');
    },
    get cause() {
      return t('docs.healthDocs.aLibraryRootFolderHas');
    },
    get fix() {
      return [t('docs.healthDocs.freeSpaceOnThatDisk')];
    },
    link: { get label() { return t('common.mediaManagement'); }, to: '/settings/mediamanagement' },
  },
  {
    anchor: 'no-download-client-is-available',
    sources: ['DownloadClientCheck'],
    get title() {
      return t('docs.healthDocs.noDownloadClientIsAvailable');
    },
    get cause() {
      return t('docs.healthDocs.noDownloadClientIsEnabled');
    },
    get fix() {
      return [t('docs.healthDocs.enableTheBuiltInTorrent')];
    },
    link: { get label() { return t('common.downloadClients'); }, to: '/settings/downloadclients' },
  },
  {
    anchor: 'remote-engine-unreachable',
    sources: ['RemoteEngineUnreachable'],
    get title() {
      return t('docs.healthDocs.remoteEngineIsUnreachable');
    },
    get cause() {
      return t('docs.healthDocs.remoteEngineCause');
    },
    get fix() {
      return [t('docs.healthDocs.remoteEngineFixRunning'), t('docs.healthDocs.remoteEngineFixTest')];
    },
    link: { get label() { return t('common.downloadClients'); }, to: '/settings/downloadclients' },
  },
  {
    anchor: 'unable-to-communicate-with-download-client',
    sources: ['DownloadClientCheck'],
    get title() {
      return t('docs.healthDocs.downloadClientDoesNotAnswer');
    },
    get cause() {
      return t('docs.healthDocs.theLastConnectionToThe');
    },
    get fix() {
      return [t('docs.healthDocs.checkTheClientIsRunning'), t('docs.healthDocs.openTheClientInSettings')];
    },
    link: { get label() { return t('common.downloadClients'); }, to: '/settings/downloadclients' },
  },
  {
    anchor: 'download-client-removes-completed-downloads',
    sources: ['DownloadClientRemovesCompletedCheck'],
    get title() {
      return t('docs.healthDocs.downloadClientRemovesCompletedDownloads');
    },
    get cause() {
      return t('docs.healthDocs.theClientDeletesFinishedDownloads');
    },
    get fix() {
      return [t('docs.healthDocs.turnOffRemoveWhenFinished'), t('docs.healthDocs.letArclightRemoveDownloadsAfter')];
    },
  },
  {
    anchor: 'bad-remote-path-mapping',
    sources: ['RemotePathMappingCheck'],
    get title() {
      return t('docs.healthDocs.remotePathMappingIsWrong');
    },
    get cause() {
      return t('docs.healthDocs.theClientReportsADownload');
    },
    get fix() {
      return [t('docs.healthDocs.addARemotePathMapping'), t('docs.healthDocs.orMakeBothContainersMount')];
    },
    link: { get label() { return t('common.downloadClients'); }, to: '/settings/downloadclients' },
  },
  {
    anchor: 'hard-links-not-possible',
    sources: ['HardLinkCheck'],
    get title() {
      return t('docs.healthDocs.hardLinksAreNotPossible');
    },
    get cause() {
      return t('docs.healthDocs.theDownloadFolderAndThe');
    },
    get fix() {
      return [t('docs.healthDocs.mountOneSharedFolderFor'), t('docs.healthDocs.pointRootFoldersAndThe')];
    },
    link: { get label() { return t('common.downloadClients'); }, to: '/settings/downloadclients' },
  },
  {
    anchor: 'docker-bad-remote-path-mapping',
    sources: ['RemotePathMappingCheck'],
    get title() {
      return t('docs.healthDocs.downloadFolderIsNotMounted');
    },
    get cause() {
      return t('docs.healthDocs.arclightRunsInDockerAnd');
    },
    get fix() {
      return [t('docs.healthDocs.mountTheDownloadsFolderInto'), t('docs.healthDocs.orAddARemotePath')];
    },
  },
  {
    anchor: 'bad-download-client-settings',
    sources: ['RemotePathMappingCheck'],
    get title() {
      return t('docs.healthDocs.localDownloadClientReportsAn');
    },
    get cause() {
      return t('docs.healthDocs.aClientOnThisMachine');
    },
    get fix() {
      return [t('docs.healthDocs.fixTheDownloadFolderIn')];
    },
  },
  {
    anchor: 'permissions-error',
    sources: ['RemotePathMappingCheck'],
    get title() {
      return t('docs.healthDocs.downloadFolderIsNotReadable');
    },
    get cause() {
      return t('docs.healthDocs.theFolderExistsButThe');
    },
    get fix() {
      return [t('docs.healthDocs.giveTheArclightUserPuid')];
    },
  },
  {
    anchor: 'downloads-awaiting-manual-import',
    sources: ['ImportPendingCheck'],
    get title() {
      return t('docs.healthDocs.downloadsWaitForManualImport');
    },
    get cause() {
      return t('docs.healthDocs.finishedDownloadsCouldNotBe');
    },
    get fix() {
      return [t('docs.healthDocs.openManualImportPickThe')];
    },
    link: { get label() { return t('common.manualImport'); }, to: '/activity/manual-import' },
  },
  {
    anchor: 'flaresolverr-unreachable',
    sources: ['FlareSolverrUnreachable'],
    get title() {
      return t('docs.healthDocs.challengeSolverIsUnreachable');
    },
    get cause() {
      return t('docs.healthDocs.aFlaresolverrTypeIndexerProxy');
    },
    get fix() {
      return [
      t('docs.healthDocs.dockerCheckTheFlaresolverrContainer'),
      t('docs.healthDocs.nativeOpenSettingsChallengeSolver'),
      t('docs.healthDocs.deleteStaleSolverProxiesUnder'),
    ];
    },
    link: { get label() { return t('common.challengeSolver'); }, to: '/settings/solver' },
  },
  {
    anchor: 'notifications-misconfigured',
    sources: ['NotificationConfigCheck'],
    get title() {
      return t('docs.healthDocs.notificationsAreMisconfigured');
    },
    get cause() {
      return t('docs.healthDocs.storedNotificationSettingsNoLonger');
    },
    get fix() {
      return [t('docs.healthDocs.openEachListedNotificationFix')];
    },
    link: { get label() { return t('common.notifications'); }, to: '/settings/notifications' },
  },
  {
    anchor: 'notifications-are-unavailable-due-to-failures',
    sources: ['NotificationStatusCheck'],
    get title() {
      return t('docs.healthDocs.notificationsKeepFailing');
    },
    get cause() {
      return t('docs.healthDocs.deliveriesFailedSeveralTimesIn');
    },
    get fix() {
      return [t('docs.healthDocs.pressTestOnTheNotification')];
    },
    link: { get label() { return t('common.notifications'); }, to: '/settings/notifications' },
  },
  {
    anchor: 'no-root-folders',
    sources: ['RootFolderCheck'],
    get title() {
      return t('docs.healthDocs.noRootFolders');
    },
    get cause() {
      return t('docs.healthDocs.seriesAndMoviesNeedA');
    },
    get fix() {
      return [t('docs.healthDocs.addAtLeastOneRoot')];
    },
    link: { get label() { return t('common.mediaManagement'); }, to: '/settings/mediamanagement' },
  },
  {
    anchor: 'missing-root-folder',
    sources: ['RootFolderCheck'],
    get title() {
      return t('docs.healthDocs.rootFolderIsMissing');
    },
    get cause() {
      return t('docs.healthDocs.aRootFolderPathDoes');
    },
    get fix() {
      return [t('docs.healthDocs.mountTheDriveOrFix')];
    },
    link: { get label() { return t('common.mediaManagement'); }, to: '/settings/mediamanagement' },
  },
  {
    anchor: 'root-folder-not-writable',
    sources: ['RootFolderCheck'],
    get title() {
      return t('docs.healthDocs.rootFolderIsNotWritable');
    },
    get cause() {
      return t('docs.healthDocs.arclightCannotCreateFilesIn');
    },
    get fix() {
      return [t('docs.healthDocs.giveTheArclightUserPuid2')];
    },
  },
  {
    anchor: 'empty-root-folder',
    sources: ['RootFolderCheck'],
    get title() {
      return t('docs.healthDocs.rootFolderIsEmpty');
    },
    get cause() {
      return t('docs.healthDocs.aRootFolderThatHas');
    },
    get fix() {
      return [t('docs.healthDocs.checkTheDriveOrNetwork')];
    },
  },
  {
    anchor: 'library-mount-ro',
    sources: ['MountCheck'],
    get title() {
      return t('docs.healthDocs.libraryMountIsReadOnly');
    },
    get cause() {
      return t('docs.healthDocs.theFilesystemHoldingALibrary');
    },
    get fix() {
      return [t('docs.healthDocs.remountItReadWriteOr')];
    },
  },
  {
    anchor: 'cannot-write-recycle-bin',
    sources: ['RecyclingBinCheck'],
    get title() {
      return t('docs.healthDocs.recycleBinIsNotWritable');
    },
    get cause() {
      return t('docs.healthDocs.deletedFilesAreMovedTo');
    },
    get fix() {
      return [t('docs.healthDocs.createTheFolderWithWrite')];
    },
    link: { get label() { return t('common.mediaManagement'); }, to: '/settings/mediamanagement' },
  },
  {
    anchor: 'tmdb-api-key-missing',
    sources: ['MetadataSourceCheck'],
    get title() {
      return t('docs.healthDocs.tmdbApiKeyIsMissing');
    },
    get cause() {
      return t('docs.healthDocs.withoutATmdbKeyArclight');
    },
    get fix() {
      return [t('docs.healthDocs.createAFreeApiKey')];
    },
    link: { get label() { return t('common.general'); }, to: '/settings/general' },
  },
  {
    anchor: 'docker-puid-pgid-mismatch',
    sources: ['DockerPermissionsCheck'],
    get title() {
      return t('docs.healthDocs.containerUserCannotWriteThe');
    },
    get cause() {
      return t('docs.healthDocs.puidPgidDoNotOwn');
    },
    get fix() {
      return [t('docs.healthDocs.setPuidAndPgidIn')];
    },
  },
  {
    anchor: 'torrent-engine-failed',
    sources: ['TorrentEngine'],
    get title() {
      return t('docs.healthDocs.builtInTorrentEngineFailed');
    },
    get cause() {
      return t('docs.healthDocs.theEngineCouldNotStart');
    },
    get fix() {
      return [t('docs.healthDocs.pickAnotherListeningPortOr')];
    },
    link: { get label() { return t('common.torrentEngine'); }, to: '/settings/torrent' },
  },
  {
    anchor: 'torrent-engine-not-listening',
    sources: ['TorrentEngine'],
    get title() {
      return t('docs.healthDocs.torrentEngineIsNotListening');
    },
    get cause() {
      return t('docs.healthDocs.noIncomingConnectionsArePossible');
    },
    get fix() {
      return [t('docs.healthDocs.checkTheListeningPortAnd')];
    },
    link: { get label() { return t('common.torrentEngine'); }, to: '/settings/torrent' },
  },
  {
    anchor: 'torrent-engine-not-on-vpn',
    sources: ['TorrentEngine'],
    get title() {
      return t('docs.healthDocs.torrentEngineIsNotBound');
    },
    get cause() {
      return t('docs.healthDocs.torrentTrafficCanLeaveOutside');
    },
    get fix() {
      return [t('docs.healthDocs.turnOnBindToVpn')];
    },
    link: { get label() { return t('common.torrentEngine'); }, to: '/settings/torrent' },
  },
  {
    anchor: 'vpn-disconnected',
    sources: ['VpnDisconnected'],
    get title() {
      return t('docs.healthDocs.vpnIsDown');
    },
    get cause() {
      return t('docs.healthDocs.vpnMonitoringIsOnAnd');
    },
    get fix() {
      return [t('docs.healthDocs.checkGluetunWireguardLogsAnd')];
    },
    link: { get label() { return t('common.vpn'); }, to: '/settings/vpn' },
  },
  {
    anchor: 'vpn-leak',
    sources: ['VpnDisconnected'],
    get title() {
      return t('docs.healthDocs.trafficIsNotGoingThrough');
    },
    get cause() {
      return t('docs.healthDocs.thePublicIpEqualsYour');
    },
    get fix() {
      return [t('docs.healthDocs.makeArclightAndTheDownload')];
    },
    link: { get label() { return t('common.vpn'); }, to: '/settings/vpn' },
  },
  {
    anchor: 'no-indexers-enabled',
    sources: ['IndexerCheck'],
    get title() {
      return t('docs.healthDocs.noIndexersEnabled');
    },
    get cause() {
      return t('docs.healthDocs.searchesAndRssHaveNowhere');
    },
    get fix() {
      return [t('docs.healthDocs.addAnIndexerFromThe')];
    },
    link: { get label() { return t('common.indexers'); }, to: '/settings/indexers' },
  },
  {
    anchor: 'indexers-are-unavailable-due-to-failures',
    sources: ['IndexerStatusCheck', 'IndexerLongTermStatusCheck', 'IndexerRssCheck', 'IndexerSearchCheck'],
    get title() {
      return t('docs.healthDocs.indexersAreBackingOffAfter');
    },
    get cause() {
      return t('docs.healthDocs.indexersFailedRepeatedlyAndAre');
    },
    get fix() {
      return [t('docs.healthDocs.pressTestOnTheIndexer'), t('docs.healthDocs.sitesBehindCloudflareNeedA')];
    },
    link: { get label() { return t('common.indexers'); }, to: '/settings/indexers' },
  },
  {
    anchor: 'no-indexers-available-with-rss-sync-enabled',
    sources: ['IndexerRssCheck'],
    get title() {
      return t('docs.healthDocs.noIndexerHasRssEnabled');
    },
    get cause() {
      return t('docs.healthDocs.newReleasesAreNotGrabbed');
    },
    get fix() {
      return [t('docs.healthDocs.enableRssOnAtLeast')];
    },
    link: { get label() { return t('common.indexers'); }, to: '/settings/indexers' },
  },
  {
    anchor: 'no-indexers-available-with-automatic-search-enabled',
    sources: ['IndexerSearchCheck'],
    get title() {
      return t('docs.healthDocs.noIndexerHasAutomaticSearch');
    },
    get cause() {
      return t('docs.healthDocs.missingEpisodesAndMoviesAre');
    },
    get fix() {
      return [t('docs.healthDocs.enableAutomaticSearchOnAt')];
    },
    link: { get label() { return t('common.indexers'); }, to: '/settings/indexers' },
  },
  {
    anchor: 'no-indexers-available-with-interactive-search-enabled',
    sources: ['IndexerSearchCheck'],
    get title() {
      return t('docs.healthDocs.noIndexerHasInteractiveSearch');
    },
    get cause() {
      return t('docs.healthDocs.interactiveSearchReturnsNothing');
    },
    get fix() {
      return [t('docs.healthDocs.enableInteractiveSearchOnAt')];
    },
    link: { get label() { return t('common.indexers'); }, to: '/settings/indexers' },
  },
  {
    anchor: 'feed-stale',
    sources: ['FeedStale'],
    get title() {
      return t('docs.healthDocs.aDataFeedStoppedUpdating');
    },
    get cause() {
      return t('docs.healthDocs.anEnabledDataFeedGuides');
    },
    get fix() {
      return [t('docs.healthDocs.checkTheLastErrorIn'), t('docs.healthDocs.openSystemFeedsToSee')];
    },
    link: { get label() { return t('common.feeds'); }, to: '/system/feeds' },
  },
  {
    anchor: 'update-available',
    sources: ['UpdateAvailable'],
    get title() {
      return t('docs.healthDocs.aNewArclightVersionIs');
    },
    get cause() {
      return t('docs.healthDocs.aNewerReleaseIsPublished');
    },
    get fix() {
      return [t('docs.healthDocs.dockerDockerComposePullDocker'), t('docs.healthDocs.windowsNativeDownloadTheNew')];
    },
    link: { get label() { return t('common.updates'); }, to: '/system/updates' },
  },
  {
    anchor: 'container-updates-available',
    sources: ['ContainerUpdatesAvailable'],
    get title() {
      return t('docs.healthDocs.containerUpdatesAreAvailable');
    },
    get cause() {
      return t('docs.healthDocs.aContainerLabelledArclightAutoupdate');
    },
    get fix() {
      return [t('docs.healthDocs.pressUpdateNowUnderSettings'), t('docs.healthDocs.withoutTheDockerSocketDocker')];
    },
    link: { get label() { return t('common.updates'); }, to: '/settings/updates' },
  },
  {
    anchor: 'ffprobe-missing',
    sources: ['FfprobeMissing'],
    get title() {
      return t('docs.healthDocs.ffprobeWasNotFound');
    },
    get cause() {
      return t('docs.healthDocs.mediaAnalysisNeedsFfprobePart');
    },
    get fix() {
      return [t('docs.healthDocs.dockerTheImageShipsFfmpeg'), t('docs.healthDocs.nativeInstallFfmpegAndPut'), t('docs.healthDocs.restartArclightThenPressAnalyze')];
    },
    link: { get label() { return t('common.tasks'); }, to: '/system/tasks' },
  },
  {
    anchor: 'orphan-files-found',
    sources: ['OrphanFilesFound'],
    get title() {
      return t('docs.healthDocs.videoFilesAreNotIn');
    },
    get cause() {
      return t('docs.healthDocs.theLastOrphanScanFound');
    },
    get fix() {
      return [t('docs.healthDocs.openLibraryHygieneAndMap'), t('docs.healthDocs.runScanNowAfterwardsTo')];
    },
    link: { get label() { return t('common.hygiene'); }, to: '/library/hygiene' },
  },
  {
    anchor: 'download-disk-space-full',
    sources: ['DownloadDiskSpace'],
    get title() {
      return t('docs.healthDocs.downloadDiskFullTitle');
    },
    get cause() {
      return t('docs.healthDocs.downloadDiskFullCause');
    },
    get fix() {
      return [t('docs.healthDocs.downloadDiskFullFix1'), t('docs.healthDocs.downloadDiskFullFix2')];
    },
    link: { get label() { return t('common.queue'); }, to: '/activity/queue' },
  },
  {
    anchor: 'download-disk-space-low',
    sources: ['DownloadDiskSpace'],
    get title() {
      return t('docs.healthDocs.downloadDiskLowTitle');
    },
    get cause() {
      return t('docs.healthDocs.downloadDiskLowCause');
    },
    get fix() {
      return [t('docs.healthDocs.downloadDiskLowFix1')];
    },
    link: { get label() { return t('common.mediaManagement'); }, to: '/settings/mediamanagement' },
  },
  {
    anchor: 'download-stalled',
    sources: ['DownloadStalled'],
    get title() {
      return t('docs.healthDocs.downloadStalledTitle');
    },
    get cause() {
      return t('docs.healthDocs.downloadStalledCause');
    },
    get fix() {
      return [t('docs.healthDocs.downloadStalledFix1'), t('docs.healthDocs.downloadStalledFix2')];
    },
    link: { get label() { return t('common.queue'); }, to: '/activity/queue' },
  },
  {
    anchor: 'download-disk-guard-paused',
    sources: ['DownloadDiskGuard'],
    get title() {
      return t('docs.healthDocs.diskGuardPausedTitle');
    },
    get cause() {
      return t('docs.healthDocs.diskGuardPausedCause');
    },
    get fix() {
      return [t('docs.healthDocs.diskGuardFix1'), t('docs.healthDocs.diskGuardFix2')];
    },
    link: { get label() { return t('common.queue'); }, to: '/activity/queue' },
  },
  {
    anchor: 'download-disk-guard-held',
    sources: ['DownloadDiskGuard'],
    get title() {
      return t('docs.healthDocs.diskGuardHeldTitle');
    },
    get cause() {
      return t('docs.healthDocs.diskGuardHeldCause');
    },
    get fix() {
      return [t('docs.healthDocs.diskGuardFix1'), t('docs.healthDocs.diskGuardHeldFix2')];
    },
    link: { get label() { return t('common.mediaManagement'); }, to: '/settings/mediamanagement' },
  },
  {
    anchor: 'torrent-engine-lockdown',
    sources: ['TorrentEngineLockdown'],
    get title() {
      return t('docs.healthDocs.torrentLockdownTitle');
    },
    get cause() {
      return t('docs.healthDocs.torrentLockdownCause');
    },
    get fix() {
      return [t('docs.healthDocs.torrentLockdownFix1'), t('docs.healthDocs.torrentLockdownFix2')];
    },
    link: { get label() { return t('common.vpn'); }, to: '/settings/vpn' },
  },
  {
    anchor: 'vpn-kill-switch-flapping',
    sources: ['VpnKillSwitchFlapping'],
    get title() {
      return t('docs.healthDocs.killSwitchFlappingTitle');
    },
    get cause() {
      return t('docs.healthDocs.killSwitchFlappingCause');
    },
    get fix() {
      return [t('docs.healthDocs.killSwitchFlappingFix1'), t('docs.healthDocs.killSwitchFlappingFix2')];
    },
    link: { get label() { return t('common.vpn'); }, to: '/settings/vpn' },
  },
  {
    anchor: 'hard-links-not-possible',
    sources: ['HardLinkCheck'],
    get title() {
      return t('docs.healthDocs.hardLinksTitle');
    },
    get cause() {
      return t('docs.healthDocs.hardLinksCause');
    },
    get fix() {
      return [t('docs.healthDocs.hardLinksFix1'), t('docs.healthDocs.hardLinksFix2')];
    },
    link: { get label() { return t('common.mediaManagement'); }, to: '/settings/mediamanagement' },
  },
];
