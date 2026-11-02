#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// End-to-end test against a throwaway Jellyfin container. Never point this at a real server.
//
//   node integration/run.mjs --zip artifacts/arclight-jellyfin_1.0.0.12.zip [--image jellyfin/jellyfin:12.4]
//                            [--work <temp dir>] [--port 18096] [--fake-port 18097] [--keep]
//                            [--install copy|repo]
//
// --install copy (default) copies the plugin folder into /config/plugins. --install repo instead
// serves a repository manifest + the zip from the fake server and installs through Jellyfin's
// own repository API (download, MD5 check, unzip), exactly like a user would.
//
// Steps: start the fake Arclight (records calls) -> start Jellyfin with a temp /config -> finish the
// setup wizard over the API -> copy the plugin into /config/plugins and restart -> configure it ->
// generate a tiny movie with the container's ffmpeg and add a library -> create/update/delete a user,
// mark played/favourite, report playback -> call every /Arclight proxy endpoint -> check index.html
// injection, the script and the config page -> assert what the fake Arclight received -> remove the
// container (unless --keep).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

const image = String(args.image ?? 'jellyfin/jellyfin:12.4');
const zipPath = resolve(String(args.zip ?? ''));
const port = Number(args.port ?? 18096);
const fakePort = Number(args['fake-port'] ?? 18097);
const container = String(args.name ?? 'arclight-jf-test');
const installMode = String(args.install ?? 'copy');
const work = resolve(String(args.work ?? mkdtempSync(join(tmpdir(), 'arclight-jf-'))));
const JF = `http://localhost:${port}`;
const FAKE = `http://localhost:${fakePort}`;
const PLUGIN_ID = 'a0751e21-86da-4afd-8e35-7da8b087febc';
const API_KEY = 'it-' + randomBytes(12).toString('hex');
const ADMIN = { name: 'itadmin', pw: randomBytes(9).toString('base64url') };
const AUTH_BASE = 'MediaBrowser Client="ArclightIT", Device="integration", DeviceId="arclight-it-1", Version="1.0.0"';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(...a) {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${a.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function http(method, url, { token, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (token !== undefined) h.Authorization = token ? `${AUTH_BASE}, Token="${token}"` : AUTH_BASE;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      break;
    } catch (e) {
      // Docker Desktop's port proxy resets connections while a container (re)starts.
      if (attempt >= 5) throw e;
      await sleep(1500);
    }
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, text: raw ? text : undefined, json, headers: res.headers, body: text };
}

async function waitFor(what, fn, timeoutMs = 60000, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e; }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

function unzip(buffer) {
  // Minimal reader for the archives scripts/package.mjs writes (deflate, no data descriptors).
  const files = {};
  let i = 0;
  while (buffer.readUInt32LE(i) === 0x04034b50) {
    const method = buffer.readUInt16LE(i + 8);
    const size = buffer.readUInt32LE(i + 18);
    const nameLen = buffer.readUInt16LE(i + 26);
    const extra = buffer.readUInt16LE(i + 28);
    const name = buffer.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const data = buffer.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    files[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    i += 30 + nameLen + extra + size;
  }
  return files;
}

async function fakeCalls() {
  return (await http('GET', `${FAKE}/__calls`)).json;
}

async function events() {
  return (await fakeCalls()).filter((c) => c.path === '/api/v1/jellyfin/events').flatMap((c) => c.body.events.map((e) => ({ ...e, __headers: c.headers, __serverId: c.body.serverId })));
}

async function main() {
  if (!zipPath.endsWith('.zip')) throw new Error('--zip <plugin zip> is required');
  console.log(`image ${image}, plugin ${zipPath}, work ${work}`);
  mkdirSync(join(work, 'config'), { recursive: true });

  // ---- fake Arclight
  const repoDir = join(work, 'repo');
  mkdirSync(repoDir, { recursive: true });
  const fake = spawn(process.execPath, [join(here, 'fake-arclight.mjs'), '--port', String(fakePort), '--key', API_KEY, '--repo-dir', repoDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => fake.kill());
  await waitFor('fake Arclight', async () => (await http('GET', `${FAKE}/__calls`)).status === 200, 10000, 200);

  // ---- Jellyfin
  spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  docker('run', '-d', '--name', container, '-p', `${port}:8096`,
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${join(work, 'config')}:/config`,
    image);
  const info = await waitFor('Jellyfin to answer', async () => (await http('GET', `${JF}/System/Info/Public`)).json?.Version, 180000, 2000)
    .then(() => waitFor('Jellyfin to stay up', async () => (await http('GET', `${JF}/System/Info/Public`)).json, 30000, 1000));
  console.log(`Jellyfin ${info.Version} (${info.Id}) up`);

  // ---- setup wizard
  await http('GET', `${JF}/Startup/Configuration`, { token: '' });
  let r = await http('POST', `${JF}/Startup/Configuration`, { token: '', body: { UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' } });
  check('wizard: configuration', r.status < 300, r.body);
  await waitFor('startup user', async () => (await http('GET', `${JF}/Startup/User`, { token: '' })).status === 200, 30000);
  r = await http('POST', `${JF}/Startup/User`, { token: '', body: { Name: ADMIN.name, Password: ADMIN.pw } });
  check('wizard: admin user', r.status < 300, r.body);
  r = await http('POST', `${JF}/Startup/RemoteAccess`, { token: '', body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false } });
  check('wizard: remote access', r.status < 300, r.body);
  r = await http('POST', `${JF}/Startup/Complete`, { token: '' });
  check('wizard: complete', r.status < 300, r.body);

  // ---- install the plugin, then restart
  const zipBytes = readFileSync(zipPath);
  const files = unzip(zipBytes);
  const meta = JSON.parse(files['meta.json'].toString('utf8'));
  const login = async () => waitFor('admin login', async () => {
    const a = await http('POST', `${JF}/Users/AuthenticateByName`, { token: '', body: { Username: ADMIN.name, Pw: ADMIN.pw } });
    return a.status === 200 ? a.json : null;
  }, 60000, 2000);
  if (installMode === 'repo') {
    const zipName = basename(zipPath);
    writeFileSync(join(repoDir, zipName), zipBytes);
    writeFileSync(join(repoDir, 'manifest.json'), JSON.stringify([{
      guid: PLUGIN_ID, name: meta.name, overview: meta.overview, description: meta.description, owner: meta.owner, category: meta.category,
      versions: [{ version: meta.version, changelog: meta.changelog, targetAbi: meta.targetAbi, sourceUrl: `http://host.docker.internal:${fakePort}/__repo/${zipName}`, checksum: createHash('md5').update(zipBytes).digest('hex'), timestamp: meta.timestamp }],
    }]));
    const pre = (await login()).AccessToken;
    r = await http('POST', `${JF}/Repositories`, { token: pre, body: [{ Name: 'Arclight test repo', Url: `http://host.docker.internal:${fakePort}/__repo/manifest.json`, Enabled: true }] });
    check('add plugin repository', r.status === 204, r.body);
    const pkg = await waitFor('package listed', async () => ((await http('GET', `${JF}/Packages`, { token: pre })).json ?? []).find((p) => p.name === meta.name), 30000, 2000).catch((e) => e);
    check('repository package visible in the catalog', pkg?.versions?.[0]?.version === meta.version, pkg);
    r = await http('POST', `${JF}/Packages/Installed/${encodeURIComponent(meta.name)}?assemblyGuid=${PLUGIN_ID}&version=${meta.version}&repositoryUrl=${encodeURIComponent(`http://host.docker.internal:${fakePort}/__repo/manifest.json`)}`, { token: pre });
    check('install from repository (download + checksum)', r.status === 204, r.body);
    await waitFor('plugin files installed', async () => spawnSync('docker', ['exec', container, 'sh', '-c', 'ls /config/plugins/*/Jellyfin.Plugin.Arclight.dll'], { encoding: 'utf8' }).status === 0, 60000, 2000);
  } else {
    const pluginDir = join(work, 'plugin', `Arclight_${meta.version}`);
    mkdirSync(pluginDir, { recursive: true });
    for (const [name, data] of Object.entries(files)) writeFileSync(join(pluginDir, name), data);
    docker('exec', container, 'mkdir', '-p', '/config/plugins');
    docker('cp', pluginDir, `${container}:/config/plugins/`);
  }
  docker('restart', container);
  await sleep(3000);
  await waitFor('Jellyfin after restart', async () => (await http('GET', `${JF}/System/Info/Public`)).json?.StartupWizardCompleted === true, 180000, 2000);

  const auth = await login();
  const token = auth.AccessToken;
  const adminId = auth.User.Id;
  const serverId = auth.ServerId;

  const plugins = (await http('GET', `${JF}/Plugins`, { token })).json ?? [];
  const mine = plugins.find((p) => p.Id.replace(/-/g, '') === PLUGIN_ID.replace(/-/g, ''));
  check(`plugin loaded by Jellyfin (${installMode} install)`, mine && mine.Status === 'Active' && mine.Version === meta.version, plugins.map((p) => `${p.Name} ${p.Version} ${p.Status}`));
  if (!mine || mine.Status !== 'Active') {
    console.log(docker('logs', '--tail', '80', container));
    throw new Error('plugin not active');
  }

  // ---- configure
  r = await http('POST', `${JF}/Arclight/Admin/TestConnection`, { token, body: { url: `http://host.docker.internal:${fakePort}`, apiKey: API_KEY } });
  check('test connection (unsaved values) reaches fake Arclight', r.json?.ok === true && r.json?.ping?.serverName === 'Fake Arclight', r.json);
  const cfg = (await http('GET', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { token })).json;
  Object.assign(cfg, { ArclightUrl: `http://host.docker.internal:${fakePort}`, BatchIntervalSeconds: 2, ProgressThrottleSeconds: 10 });
  r = await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { token, body: cfg });
  check('save plugin configuration', r.status === 204, r.body);
  r = await http('POST', `${JF}/Arclight/Admin/ApiKey`, { token, body: { apiKey: API_KEY } });
  check('save API key', r.status === 204, r.body);
  const cfgAfter = await http('GET', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { token });
  check('API key is not in the plugin configuration served to the dashboard', !cfgAfter.body.includes(API_KEY), cfgAfter.body.slice(0, 200));
  const adminStatus = await http('GET', `${JF}/Arclight/Admin/Status`, { token });
  check('admin status reports key without revealing it', adminStatus.json?.hasApiKey === true && !adminStatus.body.includes(API_KEY), adminStatus.json);
  await http('DELETE', `${FAKE}/__calls`);

  // ---- media + library
  docker('exec', container, 'mkdir', '-p', '/media/movies/Fight Club (1999) [tmdbid-550]');
  const ffmpeg = spawnSync('docker', ['exec', container, '/usr/lib/jellyfin-ffmpeg/ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '/media/movies/Fight Club (1999) [tmdbid-550]/Fight Club (1999) [tmdbid-550].mkv'], { encoding: 'utf8' });
  check('generate sample movie with ffmpeg', ffmpeg.status === 0, ffmpeg.stderr);
  r = await http('POST', `${JF}/Library/VirtualFolders?name=Movies&collectionType=movies&refreshLibrary=true&paths=${encodeURIComponent('/media/movies')}`, {
    token, body: { LibraryOptions: { EnableRealtimeMonitor: false, PathInfos: [{ Path: '/media/movies' }] } },
  });
  check('create movie library', r.status === 204, r.body);
  const ep = spawnSync('docker', ['exec', container, 'sh', '-c',
    'mkdir -p "/media/tv/Breaking Bad (2008) [tmdbid-1396]/Season 01" && /usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=duration=5:size=320x240:rate=24 -f lavfi -i sine=frequency=440:duration=5 -c:v libx264 -preset ultrafast -c:a aac -shortest "/media/tv/Breaking Bad (2008) [tmdbid-1396]/Season 01/Breaking Bad S01E01.mkv"'], { encoding: 'utf8' });
  check('generate sample episode', ep.status === 0, ep.stderr);
  r = await http('POST', `${JF}/Library/VirtualFolders?name=Shows&collectionType=tvshows&refreshLibrary=true&paths=${encodeURIComponent('/media/tv')}`, {
    token, body: { LibraryOptions: { EnableRealtimeMonitor: false, PathInfos: [{ Path: '/media/tv' }] } },
  });
  check('create TV library', r.status === 204, r.body);
  const movie = await waitFor('movie in library', async () => {
    const items = (await http('GET', `${JF}/Items?Recursive=true&IncludeItemTypes=Movie&Fields=ProviderIds&userId=${adminId}`, { token })).json;
    return items?.Items?.[0];
  }, 120000, 2000);
  check('movie scanned with Tmdb id from the folder name', movie?.ProviderIds?.Tmdb === '550', movie?.ProviderIds);

  // A second library's scan is skipped while the first one runs; ask for a full refresh.
  await http('POST', `${JF}/Library/Refresh`, { token });
  const episode = await waitFor('episode in library', async () => {
    const items = (await http('GET', `${JF}/Items?Recursive=true&IncludeItemTypes=Episode&Fields=ProviderIds&userId=${adminId}`, { token })).json?.Items ?? [];
    const series = (await http('GET', `${JF}/Items?Recursive=true&IncludeItemTypes=Series&Fields=ProviderIds&userId=${adminId}`, { token })).json?.Items ?? [];
    const real = items.find((i) => i.ParentIndexNumber === 1 && i.IndexNumber === 1 && i.LocationType !== 'Virtual');
    return real && series[0]?.ProviderIds?.Tmdb === '1396' ? real : null;
  }, 180000, 3000).catch((e) => e);
  check('sample episode scanned (series Tmdb 1396, S01E01)', !!episode?.Id, String(episode));
  const virtualE2 = ((await http('GET', `${JF}/Items?Recursive=true&IncludeItemTypes=Episode&userId=${adminId}&IsMissing=true`, { token })).json?.Items ?? [])
    .find((i) => i.ParentIndexNumber === 1 && i.IndexNumber === 2);
  console.log(`NOTE  S01E02 ${virtualE2 ? 'exists as a virtual (missing) episode' : 'is not in Jellyfin at all'}`);

  const added = await waitFor('itemAdded event', async () => (await events()).find((e) => e.type === 'itemAdded' && e.item?.type === 'Movie'), 90000, 1500).catch((e) => e);
  check('itemAdded event with provider ids', added?.item?.providerIds?.Tmdb === '550' && added?.item?.id === movie.Id.replace(/-/g, ''), added?.item ?? String(added));
  check('events carry the Jellyfin server id and API key', added?.__serverId === serverId.replace(/-/g, '') || added?.__serverId === serverId, { got: added?.__serverId, serverId });
  check('event batches send X-Api-Key and no user header', added?.__headers?.['x-api-key'] === API_KEY && !added?.__headers?.['x-arclight-jellyfin-user'], added?.__headers);

  // ---- users
  r = await http('POST', `${JF}/Users/New`, { token, body: { Name: 'ituser', Password: randomBytes(6).toString('hex') } });
  check('create Jellyfin user', r.status === 200, r.body);
  const newUserId = r.json?.Id;
  const created = await waitFor('userCreated event', async () => (await events()).find((e) => e.type === 'userCreated'), 30000).catch((e) => e);
  check('userCreated event', created?.jellyfinUserId === newUserId?.replace(/-/g, '') && created?.userName === 'ituser', created);

  // Rename (what Arclight cares about); a policy-only change raises no event on 10.11.
  const dto = (await http('GET', `${JF}/Users/${newUserId}`, { token })).json;
  r = await http('POST', `${JF}/Users?userId=${newUserId}`, { token, body: { ...dto, Name: 'ituser-renamed' } });
  if (r.status === 404 || r.status === 405) r = await http('POST', `${JF}/Users/${newUserId}`, { token, body: { ...dto, Name: 'ituser-renamed' } });
  check('rename Jellyfin user', r.status === 204, r.body);
  const updated = await waitFor('userUpdated event', async () => (await events()).find((e) => e.type === 'userUpdated' && e.jellyfinUserId === newUserId.replace(/-/g, '') && e.userName === 'ituser-renamed'), 30000).catch((e) => e);
  check('userUpdated event (rename)', updated?.type === 'userUpdated', updated);

  // ---- user data
  r = await http('POST', `${JF}/UserPlayedItems/${movie.Id}?userId=${adminId}`, { token });
  check('mark movie played', r.status === 200, r.body);
  const played = await waitFor('userDataSaved played', async () => (await events()).find((e) => e.type === 'userDataSaved' && e.played === true), 30000).catch((e) => e);
  check('userDataSaved event (played) for the right user and item', played?.jellyfinUserId === adminId.replace(/-/g, '') && played?.item?.providerIds?.Tmdb === '550' && played?.playCount >= 1, played);
  r = await http('POST', `${JF}/UserFavoriteItems/${movie.Id}?userId=${adminId}`, { token });
  const fav = await waitFor('userDataSaved favourite', async () => (await events()).find((e) => e.type === 'userDataSaved' && e.isFavorite === true), 30000).catch((e) => e);
  check('userDataSaved event (favourite)', fav?.isFavorite === true, fav);

  // ---- playback
  const playSession = randomBytes(8).toString('hex');
  r = await http('POST', `${JF}/Sessions/Playing`, { token, body: { ItemId: movie.Id, PlaySessionId: playSession, PositionTicks: 0, PlayMethod: 'DirectPlay', CanSeek: true } });
  check('report playback start', r.status === 204, r.body);
  for (let i = 1; i <= 3; i++) {
    await http('POST', `${JF}/Sessions/Playing/Progress`, { token, body: { ItemId: movie.Id, PlaySessionId: playSession, PositionTicks: i * 10_000_000, PlayMethod: 'DirectPlay', IsPaused: false } });
  }
  r = await http('POST', `${JF}/Sessions/Playing/Stopped`, { token, body: { ItemId: movie.Id, PlaySessionId: playSession, PositionTicks: 40_000_000 } });
  check('report playback stop', r.status === 204, r.body);
  const pbStart = await waitFor('playbackStart', async () => (await events()).find((e) => e.type === 'playbackStart'), 30000).catch((e) => e);
  check('playbackStart event with session details', pbStart?.jellyfinUserId === adminId.replace(/-/g, '') && pbStart?.client === 'ArclightIT' && pbStart?.deviceName === 'integration' && !!pbStart?.sessionId && pbStart?.playMethod === 'DirectPlay', pbStart);
  const pbStop = await waitFor('playbackStop', async () => (await events()).find((e) => e.type === 'playbackStop'), 30000).catch((e) => e);
  check('playbackStop event with position', pbStop?.positionTicks === 40_000_000 && pbStop?.item?.id === movie.Id.replace(/-/g, ''), pbStop);
  const progressCount = (await events()).filter((e) => e.type === 'playbackProgress').length;
  check('progress events throttled (3 reports within 10 s -> at most 1 forwarded)', progressCount <= 1, { progressCount });

  // ---- proxy endpoints (as the admin's own Jellyfin session)
  await http('DELETE', `${FAKE}/__calls`);
  const proxy = async (method, path, body) => http(method, `${JF}/Arclight/${path}`, { token, body });
  const lastCall = async (path) => (await fakeCalls()).filter((c) => c.path === path).at(-1);
  const N = adminId.replace(/-/g, '').toLowerCase();

  r = await http('GET', `${JF}/Arclight/Search?q=matrix`, {});
  check('proxy rejects calls without a Jellyfin token', r.status === 401, r.status);

  r = await proxy('GET', 'ClientConfig');
  check('GET /Arclight/ClientConfig', r.status === 200 && r.json?.configured === true && r.json?.features?.search === true && !r.body.includes(API_KEY), r.json);

  r = await proxy('GET', 'Search?q=the%20matrix&type=all&page=1');
  let c = await lastCall('/api/v1/jellyfin/search');
  check('GET /Arclight/Search forwards query + headers', r.status === 200 && r.json?.results?.length === 4 && c?.query.q === 'the matrix' && c?.headers['x-api-key'] === API_KEY && c?.headers['x-arclight-jellyfin-user'] === N, { status: r.status, call: c && { q: c.query, user: c.headers['x-arclight-jellyfin-user'] } });
  check('proxy responses never contain the API key', !r.body.includes(API_KEY));

  r = await proxy('GET', `Item/${movie.Id}`);
  c = await lastCall('/api/v1/jellyfin/status');
  check('GET /Arclight/Item/{id} -> POST /status with item descriptor', r.status === 200 && r.json?.item?.tmdbId === 550 && r.json?.item?.mediaType === 'movie' && r.json?.status?.download?.progress === 0.45
    && c?.body?.items?.[0]?.id === movie.Id.replace(/-/g, '') && c?.body?.items?.[0]?.type === 'Movie' && c?.body?.items?.[0]?.providerIds?.Tmdb === '550' && c?.headers['x-arclight-jellyfin-user'] === N, { resp: r.json, sent: c?.body });

  r = await proxy('POST', 'Status', { itemIds: [movie.Id] });
  check('POST /Arclight/Status', r.status === 200 && r.json?.items?.length === 1, r.json);

  r = await proxy('GET', 'Title/series/1396');
  c = await lastCall('/api/v1/jellyfin/title/series/1396');
  check('GET /Arclight/Title/series/1396', r.status === 200 && r.json?.seasons?.length === 3 && !!c, r.json);

  r = await proxy('POST', 'Request', { mediaType: 'series', tmdbId: 1396, seasons: [2], is4k: false, extra: 'dropped' });
  c = await lastCall('/api/v1/jellyfin/request');
  check('POST /Arclight/Request (body rebuilt)', r.status === 201 && JSON.stringify(c?.body) === JSON.stringify({ mediaType: 'series', tmdbId: 1396, seasons: [2] }), c?.body);

  r = await proxy('POST', 'Request', { mediaType: 'movie', tmdbId: -5 });
  check('invalid request rejected before reaching Arclight', r.status === 400 && r.json?.code === 'invalid_title', r.json);

  r = await proxy('POST', 'LanguageRequest', { kind: 'subtitle', mediaType: 'movie', tmdbId: 550, language: 'es' });
  c = await lastCall('/api/v1/jellyfin/language-request');
  check('POST /Arclight/LanguageRequest', r.status === 201 && c?.body?.language === 'es' && c?.body?.kind === 'subtitle', c?.body);

  r = await proxy('POST', 'Issue', { mediaType: 'movie', tmdbId: 550, type: 'audio', message: 'Audio out of sync' });
  c = await lastCall('/api/v1/jellyfin/issue');
  check('POST /Arclight/Issue', r.status === 201 && c?.body?.type === 'audio' && c?.body?.message === 'Audio out of sync', c?.body);

  r = await proxy('POST', 'Watchlist', { mediaType: 'movie', tmdbId: 603 });
  const wlAdd = r.status;
  r = await proxy('GET', 'Watchlist');
  const wlHas = (r.json?.items ?? []).some((w) => w.tmdbId === 603);
  r = await proxy('DELETE', 'Watchlist?mediaType=movie&tmdbId=603');
  const wlDel = r.status;
  c = await lastCall('/api/v1/jellyfin/watchlist');
  check('watchlist add / list / remove', wlAdd === 201 && wlHas && wlDel === 200 && c?.method === 'DELETE' && c?.query.tmdbId === '603', { wlAdd, wlHas, wlDel });

  // ---- new feature endpoints
  r = await proxy('GET', 'Discover?category=popularSeries&page=1');
  c = await lastCall('/api/v1/jellyfin/discover');
  check('GET /Arclight/Discover', r.status === 200 && r.json?.results?.length === 8 && c?.query.category === 'popularSeries' && c?.headers['x-arclight-jellyfin-user'] === N, { status: r.status, q: c?.query });
  r = await proxy('GET', 'Discover?category=hacked');
  check('Discover rejects unknown categories', r.status === 400, r.status);
  r = await proxy('GET', 'Upcoming?days=14');
  c = await lastCall('/api/v1/jellyfin/upcoming');
  const upKeys = (r.json?.items ?? []).map((i) => (i.kind === 'movie' ? `m${i.tmdbId}` : `e${i.tmdbId}-${i.seasonNumber}-${i.episodeNumber}`));
  check('GET /Arclight/Upcoming forwards days', r.status === 200 && c?.query.days === '14', r.status);
  check('Coming soon drops the library movie (550) and the episode on disk (S01E01)', !upKeys.includes('m550') && !upKeys.includes('e1396-1-1'), upKeys);
  check('Coming soon keeps the missing episode (S01E02) and the absent movie (603)', upKeys.includes('e1396-1-2') && upKeys.includes('m603'), upKeys);
  r = await proxy('GET', 'Providers/movie/550');
  c = await lastCall('/api/v1/jellyfin/providers/movie/550');
  check('GET /Arclight/Providers (region from settings, attribution kept)', r.status === 200 && r.json?.attribution === 'Data from JustWatch' && c?.query.region === 'US', r.json);
  r = await proxy('GET', 'Requests?take=10&skip=0');
  c = await lastCall('/api/v1/jellyfin/requests');
  check('GET /Arclight/Requests', r.status === 200 && r.json?.items?.length === 2 && c?.query.take === '10', r.json);
  r = await proxy('DELETE', 'Requests/42?kind=media');
  c = await lastCall('/api/v1/jellyfin/requests/42');
  check('DELETE /Arclight/Requests/{id}', r.status === 200 && c?.method === 'DELETE' && c?.query.kind === 'media', r.status);
  r = await proxy('GET', `Labels?ids=${movie.Id}`);
  const lbl = r.json?.items?.[0];
  check('GET /Arclight/Labels from Jellyfin media info (no Arclight call)', r.status === 200 && lbl?.resolution === 'SD' && lbl?.audio === 'AAC' && lbl?.size > 0, r.json);
  check('Labels make no Arclight call', !(await fakeCalls()).some((x) => /labels/i.test(x.path)));

  // themes
  r = await proxy('GET', 'Themes');
  check('GET /Arclight/Themes lists Arclight packs', r.status === 200 && r.json?.themes?.themes?.[0]?.id === 'fakepack' && r.json?.effective == null, r.json);
  r = await proxy('POST', 'Themes/Choice', { choice: 'follow' });
  check('save theme choice (follow)', r.status === 204, r.body);
  r = await proxy('GET', 'Themes');
  check('follow resolves the Arclight user theme via /userconfig', r.json?.choice === 'follow' && r.json?.effective === 'fakepack', r.json);
  r = await proxy('POST', 'Themes/Choice', { choice: '../etc' });
  check('invalid theme choice rejected', r.status === 400, r.status);
  const cssRes = await fetch(`${JF}/Arclight/Theme.css?theme=fakepack`);
  const cssText = await cssRes.text();
  const etag = cssRes.headers.get('etag');
  check('Theme.css served anonymously with ETag', cssRes.status === 200 && /text\/css/.test(cssRes.headers.get('content-type') ?? '') && cssText.includes('--arclight-accent') && !!etag, { status: cssRes.status, etag });
  const css304 = await fetch(`${JF}/Arclight/Theme.css?theme=fakepack`, { headers: { 'If-None-Match': etag ?? '' } });
  check('Theme.css answers 304 for a matching ETag', css304.status === 304, css304.status);
  const themeCalls = (await fakeCalls()).filter((x) => x.path === '/api/v1/jellyfin/theme/fakepack.css').length;
  check('Theme.css is cached (one Arclight fetch)', themeCalls === 1, themeCalls);
  const bad = await fetch(`${JF}/Arclight/Theme.css?theme=..%2Fsecret`);
  check('Theme.css rejects bad ids', bad.status === 404, bad.status);
  const missing = await fetch(`${JF}/Arclight/Theme.css?theme=nosuchpack`);
  check('Theme.css 404 for an unknown pack', missing.status === 404, missing.status);
  await proxy('POST', 'Themes/Choice', { choice: '' });

  // ---- plugin 1.2: title page data, genres, library links
  r = await proxy('GET', 'Search?q=fight&type=all&page=1');
  const fcHit = (r.json?.results ?? []).find((x) => x.tmdbId === 550);
  check('search marks library titles with jellyfinId (opens Jellyfin\'s own page)', fcHit?.jellyfinId === movie.Id.replace(/-/g, '') && !(r.json?.results ?? []).find((x) => x.tmdbId === 603)?.jellyfinId, fcHit);
  r = await proxy('GET', 'Title/movie/155');
  check('title page passes the new fields through', r.status === 200 && r.json?.cast?.[0]?.name === 'Actor One' && r.json?.trailer?.url?.startsWith('https://www.youtube.com/') && r.json?.directors?.[0] === 'Some Director', r.json && { cast: r.json.cast, trailer: r.json.trailer });
  check('title recommendations: library title gets jellyfinId, others not', r.json?.recommendations?.[0]?.jellyfinId === movie.Id.replace(/-/g, '') && !r.json?.recommendations?.[1]?.jellyfinId, r.json?.recommendations);
  r = await proxy('GET', 'Genres/movie');
  c = await lastCall('/api/v1/jellyfin/genres/movie');
  check('GET /Arclight/Genres/movie', r.status === 200 && r.json?.genres?.length === 2 && !!c, r.json);
  r = await proxy('GET', 'DiscoverGenre/movie/878?sort=rating&page=2');
  c = await lastCall('/api/v1/jellyfin/discover/genre/movie/878');
  check('GET /Arclight/DiscoverGenre forwards sort and page', r.status === 200 && r.json?.page === 2 && c?.query.sort === 'rating' && c?.query.page === '2', c?.query);
  r = await proxy('GET', 'DiscoverGenre/movie/878?sort=random');
  check('DiscoverGenre rejects unknown sorts', r.status === 400, r.status);
  r = await proxy('GET', 'Discover?category=airingToday&page=1');
  check('new discover categories accepted (airingToday)', r.status === 200, r.status);

  // ---- Cinema Mode intro
  const intros = async (id) => ((await http('GET', `${JF}/Items/${id}/Intros?userId=${adminId}`, { token })).json?.Items ?? []);
  const isOurs = (i) => /arclight-intro/i.test(`${i.Name ?? ''} ${i.Path ?? ''}`);
  check('intro off by default: none for the movie', !(await intros(movie.Id)).some(isOurs));
  const cfgIntro = (await http('GET', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { token })).json;
  await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { token, body: { ...cfgIntro, EnableIntro: true } });
  const movieIntros = await intros(movie.Id);
  const ours = movieIntros.find(isOurs);
  check('intro enabled: /Items/{movie}/Intros includes the Arclight intro', !!ours, movieIntros.map((i) => i.Name));
  check('intro is a playable video of about 6 s', ours && ours.MediaType === 'Video' && ours.RunTimeTicks > 50_000_000 && ours.RunTimeTicks < 80_000_000, ours && { MediaType: ours.MediaType, RunTimeTicks: ours.RunTimeTicks });
  if (episode?.Id) {
    check('episodes off by default: no intro for the episode', !(await intros(episode.Id)).some(isOurs));
    await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { token, body: { ...cfgIntro, EnableIntro: true, IntroBeforeEpisodes: true } });
    // The movie intro above already started this user's 3-hour session, so even the first episode is skipped.
    check('first-episode-only: no episode intro within 3 h of the last intro', !(await intros(episode.Id)).some(isOurs));
    await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { token, body: { ...cfgIntro, EnableIntro: true, IntroBeforeEpisodes: true, IntroFirstEpisodeOnly: false } });
    check('first-episode-only off: the episode gets the intro', (await intros(episode.Id)).some(isOurs));
  }
  const all = (await http('GET', `${JF}/Items?Recursive=true&userId=${adminId}&IncludeItemTypes=Movie,Video,Episode`, { token })).json?.Items ?? [];
  check('intro does not appear in the libraries', !all.some(isOurs), all.map((i) => i.Name));
  if (ours) {
    await http('DELETE', `${FAKE}/__calls`);
    const ps = randomBytes(6).toString('hex');
    await http('POST', `${JF}/Sessions/Playing`, { token, body: { ItemId: ours.Id, PlaySessionId: ps, PositionTicks: 0, PlayMethod: 'DirectPlay' } });
    await http('POST', `${JF}/Sessions/Playing/Stopped`, { token, body: { ItemId: ours.Id, PlaySessionId: ps, PositionTicks: 61_000_000 } });
    await sleep(4000);
    const evs = await events();
    check('intro playback is not forwarded to Arclight', !evs.some((e) => e.item?.id === ours.Id.replace(/-/g, '')), evs.map((e) => `${e.type}:${e.item?.name}`));
    const resume = (await http('GET', `${JF}/UserItems/Resume?userId=${adminId}`, { token })).json?.Items ?? [];
    check('intro not in Continue Watching', !resume.some(isOurs), resume.map((i) => i.Name));
  }
  await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { token, body: { ...cfgIntro, EnableIntro: false } });
  check('intro disabled again: absent', !(await intros(movie.Id)).some(isOurs));

  // not linked: log in as the second user and mark them unlinked in the fake
  await http('POST', `${JF}/Users/${newUserId}/Password`, { token, body: { NewPw: 'it-pass-2', ResetPassword: false } });
  const auth2 = await http('POST', `${JF}/Users/AuthenticateByName`, { token: '', body: { Username: 'ituser-renamed', Pw: 'it-pass-2' } });
  if (auth2.status === 200) {
    await http('POST', `${FAKE}/__unlinked`, { body: { users: [newUserId] } });
    r = await http('GET', `${JF}/Arclight/Watchlist`, { token: auth2.json.AccessToken });
    check('not_linked (403) is passed through for an unlinked Jellyfin user', r.status === 403 && r.json?.code === 'not_linked', r);
    r = await http('GET', `${JF}/Arclight/Admin/Status`, { token: auth2.json.AccessToken });
    check('admin endpoints refuse non-admin users', r.status === 403, r.status);
  } else {
    check('second user login', false, auth2.body);
  }

  // ---- web injection
  r = await http('GET', `${JF}/web/index.html`, { headers: { 'Accept-Encoding': 'gzip, br' } });
  check('index.html served with the Arclight script tag', r.status === 200 && r.body.includes('/Arclight/web/arclight.js?v='), r.body.slice(-300));
  r = await http('GET', `${JF}/web/`);
  check('/web/ also injected', r.status === 200 && r.body.includes('arclight-jellyfin:begin'), r.status);
  r = await http('GET', `${JF}/Arclight/web/arclight.js`);
  check('script served anonymously', r.status === 200 && r.body.includes('window.__arclight') && /javascript/.test(r.headers.get('content-type') ?? ''), r.status);
  check('script contains no API key', !r.body.includes(API_KEY));
  r = await http('GET', `${JF}/Arclight/web/arclight.css`);
  check('stylesheet served', r.status === 200 && r.body.includes('.arclight-chip'), r.status);
  r = await http('GET', `${JF}/web/ConfigurationPage?name=Arclight`, { token });
  check('config page served by Jellyfin', r.status === 200 && r.body.includes('ArclightConfigPage'), r.status);

  // ---- user deleted
  r = await http('DELETE', `${JF}/Users/${newUserId}`, { token });
  const deleted = await waitFor('userDeleted event', async () => (await events()).find((e) => e.type === 'userDeleted'), 30000).catch((e) => e);
  check('userDeleted event', deleted?.jellyfinUserId === newUserId.replace(/-/g, ''), deleted);

  const errors = docker('logs', container).split('\n').filter((l) => /Arclight/.test(l) && /(ERR|WRN|Exception)/.test(l));
  check('no Arclight warnings/errors in the Jellyfin log', errors.length === 0, errors.slice(0, 5));
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error('ERROR', e.stack ?? e.message, e.cause ?? '');
} finally {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed against ${image}`);
  writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2));
  if (!args.keep) {
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
    try { rmSync(work, { recursive: true, force: true }); } catch { /* files owned by the container user */ }
  } else {
    writeFileSync(join(work, 'test-login.json'), JSON.stringify({ url: JF, username: ADMIN.name, password: ADMIN.pw }, null, 2));
    console.log(`kept container ${container} on ${JF} (test login in ${join(work, 'test-login.json')}); remove with: docker rm -f ${container}`);
  }
  process.exit(failed || bad.length ? 1 : 0);
}
