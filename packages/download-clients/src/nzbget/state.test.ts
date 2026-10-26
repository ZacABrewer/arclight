import { describe, expect, it } from 'vitest';
import historyFixture from '../../fixtures/nzbget/history.json' with { type: 'json' };
import groupsFixture from '../../fixtures/nzbget/listgroups.json' with { type: 'json' };
import { categoryDestDir, expandVariables, removesCompletedDownloads, toOptions } from './config.js';
import { NzbgetGroupList, NzbgetHistoryList } from './schemas.js';
import {
  combineSize,
  downloadRate,
  mapHistoryItem,
  mapHistoryStatus,
  mapQueueItem,
  mapQueueStatus,
  queueEtas,
} from './state.js';

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const groups = NzbgetGroupList.parse(groupsFixture);
const history = NzbgetHistoryList.parse(historyFixture);

describe('combineSize', () => {
  it('combines Lo/Hi pairs past 4 GiB and falls back to MB', () => {
    expect(combineSize(1073741824, 1, 5120)).toBe(5 * GiB);
    expect(combineSize(-1, 0, undefined)).toBe(4294967295); // signed Lo from old builds
    expect(combineSize(undefined, undefined, 700)).toBe(700 * MiB);
    expect(combineSize(undefined, undefined, undefined)).toBe(0);
    expect(downloadRate({ DownloadRate: 1000 })).toBe(1000);
    expect(downloadRate({ DownloadRate: 5, DownloadRateLo: 0, DownloadRateHi: 1 })).toBe(2 ** 32);
  });
});

describe('queue state mapping', () => {
  it.each([
    ['QUEUED', 'queued', undefined],
    ['PAUSED', 'paused', undefined],
    ['DOWNLOADING', 'downloading', undefined],
    ['FETCHING', 'queued', 'Fetching the NZB file'],
    ['PP_QUEUED', 'downloading', 'Queued for post-processing'],
    ['LOADING_PARS', 'downloading', 'Post-processing: loading par files'],
    ['VERIFYING_SOURCES', 'downloading', 'Post-processing: verifying files'],
    ['REPAIRING', 'downloading', 'Post-processing: repairing'],
    ['VERIFYING_REPAIRED', 'downloading', 'Post-processing: verifying repaired files'],
    ['RENAMING', 'downloading', 'Post-processing: renaming files'],
    ['UNPACKING', 'downloading', 'Post-processing: unpacking'],
    ['MOVING', 'downloading', 'Post-processing: moving files'],
    ['EXECUTING_SCRIPT', 'downloading', 'Post-processing: running scripts'],
    ['PP_FINISHED', 'downloading', 'Post-processing finished; waiting for NZBGet to move it to history'],
  ])('%s -> %s', (raw, status, message) => {
    expect(mapQueueStatus(raw, false)).toEqual(message === undefined ? { status } : { status, message });
  });

  it('reports queued and downloading items as paused when downloading is paused globally', () => {
    expect(mapQueueStatus('QUEUED', true).status).toBe('paused');
    expect(mapQueueStatus('DOWNLOADING', true)).toEqual({ status: 'paused', message: 'NZBGet downloading is paused' });
    expect(mapQueueStatus('UNPACKING', true).status).toBe('downloading');
  });

  it('never reports an unknown queue status as completed', () => {
    expect(mapQueueStatus('SOMETHING_NEW', false)).toEqual({
      status: 'downloading',
      message: 'Unknown NZBGet status "SOMETHING_NEW"',
    });
  });
});

describe('history state mapping', () => {
  it.each([
    ['SUCCESS/ALL', 'completed'],
    ['SUCCESS/UNPACK', 'completed'],
    ['SUCCESS/PAR', 'completed'],
    ['WARNING/SCRIPT', 'warning'],
    ['WARNING/SPACE', 'warning'],
    ['WARNING/PASSWORD', 'warning'],
    ['WARNING/DAMAGED', 'warning'],
    ['WARNING/REPAIRABLE', 'warning'],
    ['FAILURE/PAR', 'failed'],
    ['FAILURE/UNPACK', 'failed'],
    ['FAILURE/MOVE', 'failed'],
    ['FAILURE/HEALTH', 'failed'],
    ['FAILURE/FETCH', 'failed'],
    ['DELETED/MANUAL', 'warning'],
    ['DELETED/DUPE', 'warning'],
    ['DELETED/COPY', 'warning'],
    ['DELETED/GOOD', 'warning'],
    ['DELETED/HEALTH', 'failed'],
    ['DELETED/BAD', 'failed'],
    ['WHATEVER/NEW', 'warning'],
  ])('%s -> %s', (raw, status) => {
    expect(mapHistoryStatus({ Status: raw }).status).toBe(status);
  });

  it('names the failed step and treats MarkStatus BAD as failed', () => {
    expect(mapHistoryStatus({ Status: 'FAILURE/UNPACK' }).message).toBe('Unpacking failed');
    expect(mapHistoryStatus({ Status: 'FAILURE/PAR' }).message).toBe('Par check/repair failed');
    expect(mapHistoryStatus({ Status: 'SUCCESS/ALL', MarkStatus: 'BAD' })).toEqual({
      status: 'failed',
      message: 'Marked as bad in NZBGet',
    });
  });
});

describe('item mapping', () => {
  it('maps a downloading queue group with sizes, progress and eta', () => {
    const group = groups.find((g) => g.NZBID === 11)!;
    const item = mapQueueItem(group, false, 205);
    expect(item).toEqual({
      id: '11',
      title: 'Show.S01E05.1080p.WEB.h264-GRP',
      category: 'arclight',
      totalBytes: 5 * GiB,
      remainingBytes: 2 * GiB,
      downloadedBytes: 3 * GiB,
      progress: 0.6,
      status: 'downloading',
      outputPath: '',
      etaSeconds: 205,
      isReadOnly: false,
      canMoveFiles: false,
      canBeRemoved: false,
    });
  });

  it('excludes paused par volumes from remaining bytes', () => {
    const group = groups.find((g) => g.NZBID === 12)!;
    const item = mapQueueItem(group, false, undefined);
    expect(item.remainingBytes).toBe(GiB);
    expect(item.progress).toBe(0);
    expect(item.etaSeconds).toBeUndefined();
  });

  it('computes cumulative queue etas from the download rate', () => {
    const etas = queueEtas(groups, 10 * MiB, false);
    expect(etas.get(11)).toBe(204); // 2 GiB / 10 MiB/s = 204.8
    expect(etas.get(12)).toBe(307); // + 1 GiB
    expect(etas.get(13)).toBeUndefined(); // paused
    expect(etas.get(14)).toBe(0); // post-processing
    expect(queueEtas(groups, 10 * MiB, true).get(11)).toBeUndefined();
    expect(queueEtas(groups, 0, false).get(11)).toBeUndefined();
  });

  it('maps history records: FinalDir preferred over DestDir, removable and movable', () => {
    const done = mapHistoryItem(history.find((h) => h.NZBID === 21)!);
    expect(done).toMatchObject({
      id: '21',
      status: 'completed',
      outputPath: '/downloads/completed/arclight/Show.S01E01.1080p.WEB.h264-GRP',
      totalBytes: GiB + 512 * MiB,
      remainingBytes: 0,
      progress: 1,
      etaSeconds: 0,
      isReadOnly: false,
      canMoveFiles: true,
      canBeRemoved: true,
    });
    expect(mapHistoryItem(history.find((h) => h.NZBID === 22)!).outputPath).toBe('/mnt/tv-staging/Show.S01E02');
  });
});

describe('config helpers', () => {
  const options = toOptions([
    { Name: 'MainDir', Value: '/downloads' },
    { Name: 'DestDir', Value: '${MainDir}/completed' },
    { Name: 'Category1.Name', Value: 'Movies' },
    { Name: 'Category1.DestDir', Value: '${MainDir}/movies' },
    { Name: 'Category2.Name', Value: 'arclight' },
    { Name: 'Category2.DestDir', Value: '' },
    { Name: 'Category3.Name', Value: 'relative' },
    { Name: 'Category3.DestDir', Value: 'rel' },
    { Name: 'KeepHistory', Value: '0' },
  ]);

  it('expands ${Option} variables and resolves category destinations', () => {
    expect(expandVariables('${maindir}/x/${Unknown}', options)).toBe('/downloads/x/${Unknown}');
    expect(categoryDestDir(options, 'movies')).toBe('/downloads/movies');
    expect(categoryDestDir(options, 'arclight')).toBe('/downloads/completed/arclight');
    expect(categoryDestDir(options, 'relative')).toBe('/downloads/completed/rel');
    expect(categoryDestDir(options, '')).toBe('/downloads/completed');
    expect(removesCompletedDownloads(options)).toBe(true);
  });

  it('honours AppendCategoryDir = no', () => {
    const noAppend = toOptions([
      { Name: 'DestDir', Value: 'C:\\nzbget\\complete' },
      { Name: 'AppendCategoryDir', Value: 'no' },
    ]);
    expect(categoryDestDir(noAppend, 'arclight')).toBe('C:\\nzbget\\complete');
    expect(removesCompletedDownloads(noAppend)).toBe(false);
  });
});
