import { beforeEach, describe, expect, it } from 'vitest';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import { remoteBaseName, remoteDirName, SlskdClient, transferPhase } from './client.js';
import { FakeSlskd } from './fake-slskd.js';
import { SlskdSettings, type SlskdSettingsInput } from './settings.js';

let fake: FakeSlskd;
let clock: number;

function runtime(): ClientRuntime {
  return {
    fetch: fake.fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    requestTimeoutMs: 1000,
  };
}

function client(overrides: Partial<SlskdSettingsInput> = {}): SlskdClient {
  return new SlskdClient(SlskdSettings.parse({ host: 'slskd.example.com', apiKey: 'test-api-key', ...overrides }), runtime());
}

async function expectError(promise: Promise<unknown>, code: DownloadClientError['code']): Promise<DownloadClientError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DownloadClientError);
  expect((error as DownloadClientError).code).toBe(code);
  return error as DownloadClientError;
}

const ALBUM_DIR = 'music\\Example Artist\\2001 - Example Album [FLAC]';

beforeEach(() => {
  fake = new FakeSlskd();
  clock = 1_761_400_000_000;
  fake.peers = [
    {
      username: 'peer-one',
      files: [
        { filename: `${ALBUM_DIR}\\01 - First Song.flac`, size: 30_000_000, bitDepth: 16, sampleRate: 44100, length: 200 },
        { filename: `${ALBUM_DIR}\\02 - Second Song.flac`, size: 32_000_000, bitDepth: 16, sampleRate: 44100, length: 210 },
        { filename: 'music\\Other\\unrelated.mp3', size: 5_000_000, bitRate: 320 },
      ],
    },
  ];
});

describe('SlskdClient', () => {
  it('tests the connection and reports the login state', async () => {
    expect(await client().test()).toMatchObject({ version: '0.22.0', loggedIn: true });
    fake.loggedIn = false;
    const result = await client().test();
    expect(result.loggedIn).toBe(false);
    expect(result.message).toMatch(/not logged in/);
    expect(fake.requests[0]!.headers.get('X-API-Key')).toBe('test-api-key');
  });

  it('maps a wrong API key to an auth error and a dead host to unreachable', async () => {
    await expectError(client({ apiKey: 'wrong' }).test(), 'auth');
    fake.networkError = new Error('connect ECONNREFUSED');
    await expectError(client().test(), 'unreachable');
  });

  it('honours a URL base', async () => {
    fake.stripPrefix = '/slskd';
    await client({ urlBase: '/slskd' }).test();
    expect(fake.urls[0]).toBe('http://slskd.example.com:5030/slskd/api/v0/application');
  });

  it('runs a search to completion, returns the responses and deletes the search', async () => {
    fake.pollsUntilComplete = 3;
    const responses = await client().search('s-1', 'example album', { pollMs: 500 });
    expect(responses).toHaveLength(1);
    expect(responses[0]!.username).toBe('peer-one');
    expect(responses[0]!.files.map((f) => remoteBaseName(f.filename))).toEqual(['01 - First Song.flac', '02 - Second Song.flac']);
    expect(responses[0]!.files[0]).toMatchObject({ bitDepth: 16, sampleRate: 44100, length: 200, extension: 'flac' });
    expect(fake.calls('/api/v0/searches/s-1')).toHaveLength(4); // 3 polls + delete
    expect(fake.searches.size).toBe(0);
    const started = JSON.parse(fake.calls('/api/v0/searches')[0]!.bodyText) as Record<string, unknown>;
    expect(started).toMatchObject({ id: 's-1', searchText: 'example album', searchTimeout: 15_000 });
  });

  it('stops polling at the deadline', async () => {
    fake.pollsUntilComplete = 1_000_000;
    const responses = await client().search('s-2', 'example', { searchTimeoutMs: 2000, pollMs: 1000 });
    expect(responses).toHaveLength(1);
    expect(fake.calls('/api/v0/searches/s-2').length).toBeLessThan(20);
  });

  it('enqueues files, lists them with phases, and cancels', async () => {
    const c = client();
    await c.enqueue('peer-one', [{ filename: `${ALBUM_DIR}\\01 - First Song.flac`, size: 30_000_000 }]);
    let downloads = await c.listDownloads();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({ username: 'peer-one', directory: ALBUM_DIR, phase: 'queued' });
    fake.setTransferState(`${ALBUM_DIR}\\01 - First Song.flac`, 'Completed, Succeeded');
    downloads = await c.listDownloads();
    expect(downloads[0]!.phase).toBe('completed');
    await c.cancelDownload('peer-one', downloads[0]!.id);
    expect(fake.transfers).toHaveLength(0);
    await c.cancelDownload('peer-one', 'missing'); // ignored
  });

  it('rejects an empty enqueue and surfaces peer failures', async () => {
    await expectError(client().enqueue('peer-one', []), 'rejected');
    await expectError(client().enqueue('nobody', [{ filename: 'x.flac', size: 1 }]), 'bad-response');
  });
});

describe('slskd helpers', () => {
  it('normalises transfer states', () => {
    expect(transferPhase('Queued, Remotely')).toBe('queued');
    expect(transferPhase('Requested')).toBe('queued');
    expect(transferPhase('InProgress')).toBe('downloading');
    expect(transferPhase('Completed, Succeeded')).toBe('completed');
    expect(transferPhase('Completed, Cancelled')).toBe('cancelled');
    expect(transferPhase('Completed, Errored')).toBe('failed');
    expect(transferPhase('Completed, TimedOut')).toBe('failed');
    expect(transferPhase('Completed, Rejected')).toBe('failed');
  });

  it('splits Soulseek paths with either separator', () => {
    expect(remoteBaseName('a\\b\\c.flac')).toBe('c.flac');
    expect(remoteBaseName('a/b/c.flac')).toBe('c.flac');
    expect(remoteDirName('a\\b\\c.flac')).toBe('a\\b');
    expect(remoteDirName('c.flac')).toBe('');
  });
});
