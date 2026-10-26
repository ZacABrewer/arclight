import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE, IMPORT, UPGRADE } from '../../fixtures/events.js';
import { createAgent } from '../index.js';
import { fakeSpawn } from '../test-utils.js';
import { eventToEnv, splitArguments } from './custom-script.js';

describe('eventToEnv', () => {
  it('flattens a grab event into MEDIATRON_* variables', () => {
    const env = eventToEnv(GRAB);
    expect(env).toMatchObject({
      MEDIATRON_EVENT_TYPE: 'grab',
      MEDIATRON_INSTANCE_NAME: 'Media-Tron',
      MEDIATRON_APPLICATION_URL: 'https://mt.example.com',
      MEDIATRON_MEDIA_ID: '7',
      MEDIATRON_MEDIA_MEDIA_TYPE: 'series',
      MEDIATRON_MEDIA_TITLE: 'Signal Lost',
      MEDIATRON_MEDIA_YEAR: '2023',
      MEDIATRON_MEDIA_TMDB_ID: '123456',
      MEDIATRON_MEDIA_IMDB_ID: 'tt1234567',
      MEDIATRON_MEDIA_PATH: '/tv/Signal Lost (2023)',
      MEDIATRON_MEDIA_GENRES: 'Drama|Mystery|Sci-Fi',
      MEDIATRON_MEDIA_IMAGES_COVER_TYPE: 'poster|fanart',
      MEDIATRON_EPISODES_COUNT: '2',
      MEDIATRON_EPISODES_SEASON_NUMBER: '2|2',
      MEDIATRON_EPISODES_EPISODE_NUMBER: '3|4',
      MEDIATRON_EPISODES_TITLE: 'Dead Air|Carrier Wave',
      MEDIATRON_EPISODES_AIR_DATE: '2026-10-24|2026-10-24',
      MEDIATRON_RELEASE_TITLE: 'Signal.Lost.S02E03E04.1080p.WEB.H264-GRP',
      MEDIATRON_RELEASE_QUALITY: 'WEBDL-1080p',
      MEDIATRON_RELEASE_QUALITY_VERSION: '1',
      MEDIATRON_RELEASE_SIZE: '3221225472',
      MEDIATRON_RELEASE_INDEXER: 'Example Indexer',
      MEDIATRON_RELEASE_RELEASE_GROUP: 'GRP',
      MEDIATRON_RELEASE_CUSTOM_FORMATS: 'x264|Streaming Service',
      MEDIATRON_RELEASE_CUSTOM_FORMAT_SCORE: '150',
      MEDIATRON_DOWNLOAD_CLIENT: 'qBittorrent',
      MEDIATRON_DOWNLOAD_ID: 'abc123def456',
    });
    expect(Object.keys(env).every((k) => k.startsWith('MEDIATRON_'))).toBe(true);
  });

  it('describes imports, upgrades and health issues', () => {
    expect(eventToEnv(IMPORT)).toMatchObject({
      MEDIATRON_EVENT_TYPE: 'import',
      MEDIATRON_MEDIA_MEDIA_TYPE: 'movie',
      MEDIATRON_FILE_PATH: IMPORT.file.path,
      MEDIATRON_FILE_RELATIVE_PATH: IMPORT.file.relativePath,
      MEDIATRON_FILE_QUALITY: 'Bluray-1080p',
      MEDIATRON_FILE_SIZE: '8589934592',
      MEDIATRON_FILE_SOURCE_PATH: IMPORT.file.sourcePath,
      MEDIATRON_FILE_MEDIA_INFO_VIDEO_CODEC: 'x264',
      MEDIATRON_FILE_MEDIA_INFO_AUDIO_CHANNELS: '5.1',
      MEDIATRON_FILE_MEDIA_INFO_SUBTITLE_LANGUAGES: 'English|French',
    });
    expect(eventToEnv(IMPORT)).not.toHaveProperty('MEDIATRON_EPISODES_COUNT');

    expect(eventToEnv(UPGRADE)).toMatchObject({
      MEDIATRON_EVENT_TYPE: 'upgrade',
      MEDIATRON_OLD_FILES_COUNT: '1',
      MEDIATRON_OLD_FILES_RELATIVE_PATH: 'Harbour Lights (2021) WEBDL-720p.mkv',
      MEDIATRON_OLD_FILES_RECYCLE_BIN_PATH: '/recycle/Harbour Lights (2021) WEBDL-720p.mkv',
    });

    expect(eventToEnv(HEALTH_ISSUE)).toEqual({
      MEDIATRON_EVENT_TYPE: 'healthIssue',
      MEDIATRON_INSTANCE_NAME: 'Media-Tron',
      MEDIATRON_APPLICATION_URL: 'https://mt.example.com',
      MEDIATRON_TIMESTAMP: '2026-10-25T12:00:00.000Z',
      MEDIATRON_HEALTH_SOURCE: 'downloadClients',
      MEDIATRON_HEALTH_STATUS: 'error',
      MEDIATRON_HEALTH_MESSAGE: 'Unable to communicate with qBittorrent.',
      MEDIATRON_HEALTH_WIKI_URL: 'https://mt.example.com/wiki/health#download-clients',
    });
  });
});

describe('splitArguments', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitArguments('')).toEqual([]);
    expect(splitArguments('--flag  value "two words" \'single q\'')).toEqual(['--flag', 'value', 'two words', 'single q']);
  });
});

describe('CustomScriptAgent', () => {
  it('spawns the script with arguments and event environment, resolving on exit 0', async () => {
    const spawner = fakeSpawn(({ child }) => child.emit('close', 0, null));
    const agent = createAgent('custom-script', { path: '/scripts/notify.sh', arguments: '--json "a b"' }, { spawn: spawner.spawn });
    await agent.send(GRAB);

    const record = spawner.records[0]!;
    expect(record.command).toBe('/scripts/notify.sh');
    expect(record.args).toEqual(['--json', 'a b']);
    expect(record.env.MEDIATRON_EVENT_TYPE).toBe('grab');
    expect(record.env.MEDIATRON_MEDIA_TITLE).toBe('Signal Lost');
    expect(record.env.PATH ?? record.env.Path).toBeDefined(); // inherits the parent environment
  });

  it('fails with scriptFailed on a non-zero exit, including stderr', async () => {
    const spawner = fakeSpawn(({ child }) => {
      child.stderr.emit('data', Buffer.from('disk full\n'));
      child.emit('close', 3, null);
    });
    const agent = createAgent('custom-script', { path: 'C:\\scripts\\notify.cmd' }, { spawn: spawner.spawn });
    await expect(agent.send(IMPORT)).rejects.toMatchObject({
      agent: 'custom-script',
      code: 'scriptFailed',
      message: 'C:\\scripts\\notify.cmd exited with code 3: disk full',
    });
  });

  it('fails with scriptFailed when the process cannot start', async () => {
    const spawner = fakeSpawn(({ child }) => child.emit('error', new Error('ENOENT')));
    const agent = createAgent('custom-script', { path: '/missing.sh' }, { spawn: spawner.spawn });
    await expect(agent.test()).rejects.toMatchObject({ code: 'scriptFailed', message: expect.stringContaining('ENOENT') });
  });

  it('kills the script and reports a timeout when it runs too long', async () => {
    const spawner = fakeSpawn(() => undefined); // never exits
    const agent = createAgent('custom-script', { path: '/hang.sh', timeoutMs: 1000 }, { spawn: spawner.spawn });
    const pending = agent.send(HEALTH_ISSUE);
    // The schema floor is 1 s; wait slightly past it rather than faking timers across the microtask boundary.
    await expect(pending).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('1000 ms') });
    expect(spawner.records[0]!.child.killedWith).toBe('SIGKILL');
  }, 5000);
});
