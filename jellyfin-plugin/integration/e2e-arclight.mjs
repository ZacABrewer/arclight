#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// End-to-end test of the plugin against a REAL Arclight (image built from this repo) and a
// throwaway Jellyfin, both on a private Docker network. No indexers, trackers, download clients or
// VPN are configured; the only outside call Arclight may try is TMDB, which fails without a key.
//
//   docker build -f docker/Dockerfile -t arclight:e2e .          (repo root)
//   node integration/e2e-arclight.mjs --zip artifacts/arclight-jellyfin_1.0.0.12.zip
//        [--arclight-image arclight:e2e] [--jellyfin-image jellyfin/jellyfin:12.4]
//        [--jf-port 18096] [--al-port 27878] [--work <dir>] [--keep]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

const zipPath = resolve(String(args.zip ?? ''));
const AL_IMAGE = String(args['arclight-image'] ?? 'arclight:e2e');
const JF_IMAGE = String(args['jellyfin-image'] ?? 'jellyfin/jellyfin:12.4');
const JF_PORT = Number(args['jf-port'] ?? 18096);
const AL_PORT = Number(args['al-port'] ?? 27878);
const NET = 'arclight-e2e-net';
const AL = 'arclight-e2e-al';
const JFC = 'arclight-e2e-jf';
const work = resolve(String(args.work ?? mkdtempSync(join(tmpdir(), 'arclight-e2e-'))));
const JF = `http://localhost:${JF_PORT}`;
const ALU = `http://localhost:${AL_PORT}/api/v1`;
const PLUGIN_ID = 'a0751e21-86da-4afd-8e35-7da8b087febc';
const JF_ADMIN = { name: 'e2eadmin', pw: randomBytes(9).toString('base64url') };
const AL_ADMIN = { name: 'aladmin', pw: 'Al-' + randomBytes(9).toString('base64url') };
const AUTH_BASE = 'MediaBrowser Client="ArclightE2E", Device="e2e", DeviceId="arclight-e2e-1", Version="1.0.0"';

const results = [];
const notes = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !ok ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}` : ''}`);
}
function note(text) {
  notes.push(text);
  console.log(`NOTE  ${text}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = (id) => String(id).replace(/-/g, '').toLowerCase();

function docker(...a) {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${a.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function http(method, url, { jf, al, body, headers = {} } = {}) {
  const h = { ...headers };
  if (jf !== undefined) h.Authorization = jf ? `${AUTH_BASE}, Token="${jf}"` : AUTH_BASE;
  if (al) h['X-Api-Key'] = al;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      break;
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(1500);
    }
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, body: text, headers: res.headers };
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

function cleanup() {
  for (const c of [AL, JFC]) spawnSync('docker', ['rm', '-f', c], { encoding: 'utf8' });
  spawnSync('docker', ['network', 'rm', NET], { encoding: 'utf8' });
}

async function jfLogin(username, pw) {
  return waitFor(`Jellyfin login ${username}`, async () => {
    const a = await http('POST', `${JF}/Users/AuthenticateByName`, { jf: '', body: { Username: username, Pw: pw } });
    return a.status === 200 ? a.json : null;
  }, 60000, 2000);
}

async function main() {
  if (!zipPath.endsWith('.zip')) throw new Error('--zip <plugin zip> is required');
  console.log(`Arclight ${AL_IMAGE}, Jellyfin ${JF_IMAGE}, plugin ${zipPath}, work ${work}`);
  cleanup();
  mkdirSync(join(work, 'al-config'), { recursive: true });
  mkdirSync(join(work, 'jf-config'), { recursive: true });
  docker('network', 'create', NET);

  // ------------------------------------------------------------------ containers
  docker('run', '-d', '--name', AL, '--network', NET, '-p', `${AL_PORT}:7878`, '-e', 'TZ=UTC', '-v', `${join(work, 'al-config')}:/config`, AL_IMAGE);
  docker('run', '-d', '--name', JFC, '--network', NET, '-p', `${JF_PORT}:8096`, '-v', `${join(work, 'jf-config')}:/config`, JF_IMAGE);

  await waitFor('Arclight ping', async () => (await http('GET', `${ALU}/system/ping`)).status === 200, 180000, 2000);
  await waitFor('Jellyfin', async () => (await http('GET', `${JF}/System/Info/Public`)).json?.Version, 180000, 2000);
  const jfInfo = await waitFor('Jellyfin stable', async () => (await http('GET', `${JF}/System/Info/Public`)).json, 30000);
  console.log(`Jellyfin ${jfInfo.Version} up; Arclight up`);

  // ------------------------------------------------------------------ Arclight first-run setup
  let r = await http('POST', `${ALU}/setup/complete`, { body: { username: AL_ADMIN.name, password: AL_ADMIN.pw, authMethod: 'forms' } });
  check('Arclight headless setup', r.status === 200, r.body);
  r = await http('POST', `${ALU}/auth/login`, { body: { username: AL_ADMIN.name, password: AL_ADMIN.pw } });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  check('Arclight admin login', r.status === 200 && cookie.startsWith('al_session='), r.body);
  r = await http('GET', `${ALU}/settings/security`, { headers: { Cookie: cookie } });
  const AL_KEY = r.json?.apiKey;
  check('Arclight API key read', typeof AL_KEY === 'string' && AL_KEY.length > 10, r.body);
  const themeSettings = (await http('GET', `${ALU}/settings/themes`, { al: AL_KEY })).json;
  r = await http('PUT', `${ALU}/settings/themes`, { al: AL_KEY, body: { ...themeSettings, syncEnabled: false, defaultTheme: 'abyss' } });
  check('Arclight theme sync off, default theme abyss (no GitHub fetches)', r.status === 200, r.body);

  // ------------------------------------------------------------------ Jellyfin setup + library
  await http('GET', `${JF}/Startup/Configuration`, { jf: '' });
  await http('POST', `${JF}/Startup/Configuration`, { jf: '', body: { UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' } });
  await waitFor('startup user', async () => (await http('GET', `${JF}/Startup/User`, { jf: '' })).status === 200, 30000);
  await http('POST', `${JF}/Startup/User`, { jf: '', body: { Name: JF_ADMIN.name, Password: JF_ADMIN.pw } });
  await http('POST', `${JF}/Startup/RemoteAccess`, { jf: '', body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false } });
  r = await http('POST', `${JF}/Startup/Complete`, { jf: '' });
  check('Jellyfin wizard', r.status < 300, r.body);

  // Plugin: copy into /config/plugins and restart.
  const files = unzip(readFileSync(zipPath));
  const meta = JSON.parse(files['meta.json'].toString('utf8'));
  const pluginDir = join(work, 'plugin', `Arclight_${meta.version}`);
  mkdirSync(pluginDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(pluginDir, name), data);
  docker('exec', JFC, 'mkdir', '-p', '/config/plugins');
  docker('cp', pluginDir, `${JFC}:/config/plugins/`);

  // Sample media (Tmdb ids from the folder names, no metadata download needed).
  const ffmpeg = (dir, file) => spawnSync('docker', ['exec', JFC, 'sh', '-c',
    `mkdir -p "/media/movies/${dir}" && /usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=duration=5:size=320x240:rate=24 -f lavfi -i sine=frequency=440:duration=5 -c:v libx264 -preset ultrafast -c:a aac -shortest "/media/movies/${dir}/${file}"`], { encoding: 'utf8' });
  check('sample movies generated', ffmpeg('Fight Club (1999) [tmdbid-550]', 'Fight Club (1999) [tmdbid-550].mkv').status === 0
    && ffmpeg('The Matrix (1999) [tmdbid-603]', 'The Matrix (1999) [tmdbid-603].mkv').status === 0);

  docker('restart', JFC);
  await sleep(3000);
  await waitFor('Jellyfin after restart', async () => (await http('GET', `${JF}/System/Info/Public`)).json?.StartupWizardCompleted === true, 180000, 2000);
  const jfAuth = await jfLogin(JF_ADMIN.name, JF_ADMIN.pw);
  const jfTok = jfAuth.AccessToken;
  const jfAdminId = jfAuth.User.Id;
  const jfServerId = jfAuth.ServerId;
  const plugins = (await http('GET', `${JF}/Plugins`, { jf: jfTok })).json ?? [];
  check('plugin active in Jellyfin', plugins.some((p) => N(p.Id) === N(PLUGIN_ID) && p.Status === 'Active'), plugins.map((p) => `${p.Name} ${p.Status}`));

  r = await http('POST', `${JF}/Library/VirtualFolders?name=Movies&collectionType=movies&refreshLibrary=true&paths=${encodeURIComponent('/media/movies')}`, {
    jf: jfTok, body: { LibraryOptions: { EnableRealtimeMonitor: false, PathInfos: [{ Path: '/media/movies' }] } },
  });
  check('Jellyfin library created', r.status === 204, r.body);
  const movies = await waitFor('two movies scanned', async () => {
    const items = (await http('GET', `${JF}/Items?Recursive=true&IncludeItemTypes=Movie&Fields=ProviderIds&userId=${jfAdminId}`, { jf: jfTok })).json?.Items ?? [];
    return items.length >= 2 && items.every((i) => i.ProviderIds?.Tmdb) ? items : null;
  }, 180000, 3000);
  const fightClub = movies.find((m) => m.ProviderIds.Tmdb === '550');
  const matrix = movies.find((m) => m.ProviderIds.Tmdb === '603');

  // Jellyfin API key for Arclight.
  await http('POST', `${JF}/Auth/Keys?app=ArclightE2E`, { jf: jfTok });
  const jfApiKey = ((await http('GET', `${JF}/Auth/Keys`, { jf: jfTok })).json?.Items ?? []).find((k) => k.AppName === 'ArclightE2E')?.AccessToken;
  check('Jellyfin API key created', !!jfApiKey);

  // ------------------------------------------------------------------ Arclight: media server, plugin key, user link
  r = await http('POST', `${ALU}/mediaserver`, { al: AL_KEY, body: { kind: 'jellyfin', name: 'E2E Jellyfin', url: `http://${JFC}:8096`, apiKey: jfApiKey, loginEnabled: true, createUsersOnLogin: false, syncWatchHistory: true } });
  const serverId = r.json?.id;
  check('Arclight: add Jellyfin media server', r.status === 201 && !!serverId, r.body);
  r = await http('POST', `${ALU}/mediaserver/${serverId}/test`, { al: AL_KEY });
  check('Arclight: media server connection test', r.json?.ok === true, r.body);
  r = await http('GET', `${ALU}/settings/jellyfinplugin`, { al: AL_KEY });
  const srv = r.json?.servers?.find((s) => s.serverId === serverId);
  check('Arclight learned the Jellyfin server id (remoteId)', srv && N(srv.remoteId) === N(jfServerId), { srv, jfServerId });

  r = await http('POST', `${ALU}/settings/jellyfinplugin/keys`, { al: AL_KEY, body: { name: 'E2E plugin' } });
  const PLUGIN_KEY = r.json?.key;
  check('Arclight: plugin key created (alj_...)', r.status === 201 && /^alj_/.test(PLUGIN_KEY ?? ''), r.body);

  r = await http('GET', `${ALU}/user/import/mediaserver`, { al: AL_KEY });
  check('Arclight lists Jellyfin users for import', (r.json ?? []).some((u) => N(u.externalId) === N(jfAdminId)), r.body);
  r = await http('POST', `${ALU}/user/import/mediaserver`, { al: AL_KEY, body: { externalIds: [jfAdminId] } });
  const linkedUser = r.json?.created?.[0];
  check('Arclight: Jellyfin admin imported + linked', r.status === 200 && !!linkedUser, r.body);
  const alUserId = linkedUser?.id;

  // ------------------------------------------------------------------ plugin config
  r = await http('POST', `${JF}/Arclight/Admin/TestConnection`, { jf: jfTok, body: { url: `http://${AL}:7878`, apiKey: PLUGIN_KEY } });
  check('plugin test connection against real Arclight', r.json?.ok === true && typeof r.json?.ping?.version === 'string', r.body);
  note(`ping: ${JSON.stringify(r.json?.ping)}`);
  const cfg = (await http('GET', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { jf: jfTok })).json;
  Object.assign(cfg, { ArclightUrl: `http://${AL}:7878`, BatchIntervalSeconds: 2, ProgressThrottleSeconds: 10 });
  r = await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { jf: jfTok, body: cfg });
  const r2 = await http('POST', `${JF}/Arclight/Admin/ApiKey`, { jf: jfTok, body: { apiKey: PLUGIN_KEY } });
  check('plugin configured', r.status === 204 && r2.status === 204, [r.body, r2.body]);
  r = await http('GET', `${ALU}/settings/jellyfinplugin`, { al: AL_KEY });
  check('Arclight recorded the plugin ping', !!r.json?.lastPingAt, r.json);

  // Jellyfin renames items once metadata is refreshed; read the current names when needed.
  const nameOf = async (id) => (await http('GET', `${JF}/Items/${id}?userId=${jfAdminId}`, { jf: jfTok })).json?.Name;

  // ------------------------------------------------------------------ playback + played
  const playSession = randomBytes(8).toString('hex');
  await http('POST', `${JF}/Sessions/Playing`, { jf: jfTok, body: { ItemId: fightClub.Id, PlaySessionId: playSession, PositionTicks: 0, PlayMethod: 'DirectPlay', CanSeek: true } });
  await sleep(1200);
  await http('POST', `${JF}/Sessions/Playing/Progress`, { jf: jfTok, body: { ItemId: fightClub.Id, PlaySessionId: playSession, PositionTicks: 20_000_000, PlayMethod: 'DirectPlay', IsPaused: true } });
  await sleep(1200);
  await http('POST', `${JF}/Sessions/Playing/Stopped`, { jf: jfTok, body: { ItemId: fightClub.Id, PlaySessionId: playSession, PositionTicks: 40_000_000 } });
  await http('POST', `${JF}/UserPlayedItems/${fightClub.Id}?userId=${jfAdminId}`, { jf: jfTok });

  const fcName = await nameOf(fightClub.Id);
  const history = await waitFor('watch history rows', async () => {
    const page = (await http('GET', `${ALU}/watchhistory?includeProgress=true&pageSize=200&userId=${alUserId}`, { al: AL_KEY })).json;
    const recs = page?.records ?? [];
    const types = new Set(recs.filter((x) => x.title === fcName).map((x) => x.type));
    return types.has('start') && types.has('stop') && types.has('played') ? recs : null;
  }, 60000, 2000).catch(async (e) => (await http('GET', `${ALU}/watchhistory?includeProgress=true&pageSize=200`, { al: AL_KEY })).json ?? String(e));
  const fc = Array.isArray(history) ? history.filter((x) => x.title === fcName) : [];
  const start = fc.find((x) => x.type === 'start');
  check('watch history: start/stop/played for the linked user (source plugin)', Array.isArray(history) && !!start && fc.some((x) => x.type === 'stop') && fc.some((x) => x.type === 'played'), history);
  check('watch history: start carries client, device, play method, session', start?.client === 'ArclightE2E' && start?.device === 'e2e' && start?.playMethod === 'DirectPlay' && !!start?.sessionId && start?.source === 'plugin' && start?.user?.arclightUserId === alUserId, start);
  // Arclight stores at most one progress event per session per minute (the resume point still moves).
  check('watch history: progress within the first minute not stored (Arclight throttle)', !fc.some((x) => x.type === 'progress'), fc.map((x) => x.type));
  const stop = fc.find((x) => x.type === 'stop');
  check('watch history: stop position 4 s', stop?.positionMs === 4000, stop);

  // ------------------------------------------------------------------ favourite -> watchlist sync
  await http('POST', `${JF}/UserFavoriteItems/${fightClub.Id}?userId=${jfAdminId}`, { jf: jfTok });
  await sleep(3000);
  r = await http('POST', `${ALU}/watchlist/sync`, { al: AL_KEY });
  check('WatchlistSync ran', r.status === 200, r.body);
  note(`WatchlistSync result: ${r.body}`);
  r = await http('GET', `${ALU}/watchlist?userId=${alUserId}`, { al: AL_KEY });
  const wlFav = (r.json ?? []).find((w) => w.tmdbId === 550);
  check('favourite mirrored to the Arclight watchlist (source jellyfin)', wlFav?.source === 'jellyfin', r.body);

  // ------------------------------------------------------------------ catch-up sync (plugin user-data events off)
  cfg.EnableUserDataEvents = false;
  await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { jf: jfTok, body: cfg });
  await sleep(1000);
  await http('POST', `${JF}/UserPlayedItems/${matrix.Id}?userId=${jfAdminId}`, { jf: jfTok });
  await sleep(3000);
  r = await http('POST', `${ALU}/mediaserver/${serverId}/sync`, { al: AL_KEY, body: { full: true } });
  check('MediaServerWatchSync (Sync now)', r.status === 200 && r.json?.status === 'ok', r.body);
  note(`watch sync result: ${r.body}`);
  r = await http('GET', `${ALU}/watchhistory?pageSize=200&userId=${alUserId}`, { al: AL_KEY });
  const mxName = await nameOf(matrix.Id);
  const syncPlayed = (r.json?.records ?? []).find((x) => x.title === mxName && x.type === 'played');
  check('catch-up sync imported the played state (event source sync)', syncPlayed?.source === 'sync', (r.json?.records ?? []).map((x) => `${x.title}:${x.type}:${x.source}`));
  cfg.EnableUserDataEvents = true;
  await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { jf: jfTok, body: cfg });

  // ------------------------------------------------------------------ Jellyfin users -> media_server_users
  r = await http('POST', `${JF}/Users/New`, { jf: jfTok, body: { Name: 'e2euser', Password: 'e2e-pass-2' } });
  const jfUser2 = r.json?.Id;
  check('Jellyfin user created', r.status === 200 && !!jfUser2, r.body);
  const acc = await waitFor('account row', async () => ((await http('GET', `${ALU}/mediaserver/${serverId}/accounts`, { al: AL_KEY })).json ?? []).find((a) => N(a.externalId) === N(jfUser2)), 30000, 2000).catch((e) => e);
  check('userCreated -> media_server_users row', acc?.name === 'e2euser', acc);
  const dto = (await http('GET', `${JF}/Users/${jfUser2}`, { jf: jfTok })).json;
  r = await http('POST', `${JF}/Users?userId=${jfUser2}`, { jf: jfTok, body: { ...dto, Name: 'e2euser-renamed' } });
  const renamed = await waitFor('rename', async () => ((await http('GET', `${ALU}/mediaserver/${serverId}/accounts`, { al: AL_KEY })).json ?? []).find((a) => N(a.externalId) === N(jfUser2) && a.name === 'e2euser-renamed'), 30000, 2000).catch((e) => e);
  check('userUpdated (rename) -> media_server_users name updated', renamed?.name === 'e2euser-renamed', renamed);

  // ------------------------------------------------------------------ /Arclight proxy with the real backend
  const proxy = (method, path, body, tok = jfTok) => http(method, `${JF}/Arclight/${path}`, { jf: tok, body });

  r = await proxy('GET', `Item/${fightClub.Id}`);
  check('status badge for a library movie (GET /Arclight/Item)', r.status === 200 && r.json?.item?.tmdbId === 550 && r.json?.status && N(r.json.status.id) === N(fightClub.Id), r.body);
  note(`status for Fight Club: ${JSON.stringify(r.json?.status)}`);

  r = await proxy('GET', 'Search?q=matrix&type=all&page=1');
  note(`search -> HTTP ${r.status} ${r.body.slice(0, 300)}`);
  check('search reaches Arclight and returns JSON (results or a clean error)', r.status === 200 ? Array.isArray(r.json?.results) : (r.status >= 400 && typeof r.json?.code === 'string'), r.body);

  r = await proxy('GET', 'Title/movie/550');
  note(`title -> HTTP ${r.status} ${r.body.slice(0, 300)}`);

  r = await proxy('POST', 'Request', { mediaType: 'movie', tmdbId: 603 });
  note(`request -> HTTP ${r.status} ${r.body.slice(0, 400)}`);
  check('request call reaches Arclight (created, accepted, or a clean JSON error)', [201, 202].includes(r.status) || (r.status >= 400 && typeof r.json?.code === 'string'), r.body);

  r = await proxy('POST', 'Watchlist', { mediaType: 'movie', tmdbId: 603 });
  note(`watchlist add -> HTTP ${r.status} ${r.body.slice(0, 300)}`);
  const wlAdded = r.status === 201;
  const wlStatus = r.status;
  const wlCode = r.json?.code;
  r = await proxy('GET', 'Watchlist');
  const wlHas = (r.json?.items ?? []).some((w) => w.tmdbId === 603);
  r = await proxy('DELETE', 'Watchlist?mediaType=movie&tmdbId=603');
  const wlDel = r.status;
  const wlAfter = ((await proxy('GET', 'Watchlist')).json?.items ?? []).some((w) => w.tmdbId === 603);
  if (!wlAdded && wlStatus === 503) {
    check('watchlist add without TMDB fails cleanly (503 NOT_CONFIGURED passed through)', wlCode === 'NOT_CONFIGURED', wlCode);
  } else {
    check('watchlist add / list / remove through the proxy', wlAdded && wlHas && wlDel === 200 && !wlAfter, { wlAdded, wlHas, wlDel, wlAfter });
  }
  r = await proxy('DELETE', 'Watchlist?mediaType=movie&tmdbId=550');
  check('removing a Jellyfin favourite via the plugin is refused (409)', r.status === 409, r.body);

  r = await proxy('POST', 'Issue', { mediaType: 'movie', tmdbId: 550, type: 'audio', message: 'E2E: audio out of sync' });
  note(`issue -> HTTP ${r.status} ${r.body.slice(0, 300)}`);
  check('issue created', r.status === 201 && !!r.json?.id, r.body);
  if (r.status === 201) {
    const issues = (await http('GET', `${ALU}/issue`, { al: AL_KEY })).json;
    const list = Array.isArray(issues) ? issues : issues?.results ?? issues?.records ?? [];
    check('issue visible in Arclight', JSON.stringify(list).includes('E2E: audio out of sync') || list.some((i) => i.id === r.json.id), issues);
  }

  r = await proxy('POST', 'LanguageRequest', { kind: 'subtitle', mediaType: 'movie', tmdbId: 550, language: 'es' });
  note(`language request -> HTTP ${r.status} ${r.body.slice(0, 300)}`);

  // ------------------------------------------------------------------ new endpoints against the real backend
  r = await proxy('GET', 'Upcoming?days=30');
  check('upcoming: 200 with items[] (empty library)', r.status === 200 && Array.isArray(r.json?.items), r.body);
  r = await proxy('GET', 'Requests?take=20&skip=0');
  check('my requests: 200 with total/items', r.status === 200 && typeof r.json?.total === 'number' && Array.isArray(r.json?.items), r.body);
  note(`my requests -> ${r.body.slice(0, 200)}`);
  r = await proxy('GET', 'Discover?category=trending&page=1');
  check('discover without TMDB: clean 503 NOT_CONFIGURED', r.status === 503 && r.json?.code === 'NOT_CONFIGURED', r.body);
  r = await proxy('GET', 'Providers/movie/550');
  check('providers without TMDB: clean JSON error', r.status >= 400 && typeof r.json?.code === 'string', r.body);
  note(`providers -> HTTP ${r.status} ${r.body.slice(0, 160)}`);
  r = await proxy('GET', `Labels?ids=${fightClub.Id}`);
  check('labels from Jellyfin media info', r.status === 200 && r.json?.items?.[0]?.resolution === 'SD', r.body);

  // themes (real packs from the image)
  r = await proxy('GET', 'Themes');
  const packs = r.json?.themes?.themes ?? [];
  check('real Arclight packs listed through the plugin', packs.length >= 2 && packs.some((p) => p.id === 'abyss') && r.json?.themes?.defaultTheme === 'abyss', r.json);
  note(`packs: ${packs.map((p) => `${p.id}${p.dark ? '' : '(light)'}`).join(', ')}`);
  const lightPack = packs.find((p) => !p.dark)?.id;
  for (const id of ['abyss', lightPack].filter(Boolean)) {
    const res = await fetch(`${JF}/Arclight/Theme.css?theme=${id}`);
    const css = await res.text();
    const fontUrl = /url\("?(theme-fonts\/[^")]+)"?\)/.exec(css)?.[1];
    const banned = /(^|[;{\s])(display|visibility|position|width|height|margin|padding|content)\s*:/m.test(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    check(`Theme.css for ${id}: generated Jellyfin CSS, colours only`, res.status === 200 && css.includes('.skinHeader') && css.includes('--arclight-accent') && !banned && !/https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), { status: res.status, len: css.length, banned });
    if (fontUrl) {
      const f = await fetch(`${JF}/Arclight/${fontUrl}`);
      check(`pack font served through the plugin (${fontUrl})`, f.status === 200 && /font\/woff2/.test(f.headers.get('content-type') ?? '') && (await f.arrayBuffer()).byteLength > 1000, f.status);
    }
  }
  await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { jf: jfTok, body: { ...cfg, DefaultTheme: 'follow' } });
  r = await proxy('GET', 'Themes');
  check('"follow" resolves the Arclight account theme (server default abyss) via /userconfig', r.json?.effective === 'abyss', r.json);
  await http('POST', `${JF}/Plugins/${PLUGIN_ID}/Configuration`, { jf: jfTok, body: cfg });

  // ------------------------------------------------------------------ account_disabled + parental mirroring
  r = await http('POST', `${JF}/Users/New`, { jf: jfTok, body: { Name: 'e2ekid', Password: 'e2e-kid-1' } });
  const kidId = r.json?.Id;
  r = await http('POST', `${ALU}/user/import/mediaserver`, { al: AL_KEY, body: { externalIds: [kidId] } });
  const kidUser = r.json?.created?.[0]?.id;
  check('second Jellyfin user imported + linked', !!kidUser, r.body);
  const kidPolicy = (await http('GET', `${JF}/Users/${kidId}`, { jf: jfTok })).json.Policy;
  r = await http('POST', `${JF}/Users/${kidId}/Policy`, { jf: jfTok, body: { ...kidPolicy, MaxParentalRating: 10 } });
  check('Jellyfin parental limit set (score 10 = PG / TV-PG)', r.status === 204, r.body);
  const server = (await http('GET', `${ALU}/mediaserver/${serverId}`, { al: AL_KEY })).json;
  r = await http('PUT', `${ALU}/mediaserver/${serverId}`, { al: AL_KEY, body: { ...server, mirrorParentalControls: true } });
  check('mirrorParentalControls enabled on the media server', r.status === 200 && r.json?.mirrorParentalControls === true, r.body);
  r = await http('POST', `${ALU}/mediaserver/${serverId}/usersync`, { al: AL_KEY });
  note(`user sync: ${r.body}`);
  const kidRow = (await http('GET', `${ALU}/user/${kidUser}`, { al: AL_KEY })).json;
  const caps = kidRow?.settings?.contentRestrictions?.maxCertification;
  check('parental limit mirrored into Arclight content restrictions (PG / TV-PG)', caps?.movie === 'PG' && caps?.tv === 'TV-PG', kidRow?.settings);
  const kidLogin = await jfLogin('e2ekid', 'e2e-kid-1');
  r = await proxy('GET', 'Watchlist', undefined, kidLogin.AccessToken);
  check('linked kid account works through the proxy before disabling', r.status === 200, r.body);
  r = await http('POST', `${JF}/Users/${kidId}/Policy`, { jf: jfTok, body: { ...kidPolicy, MaxParentalRating: 10, IsDisabled: true } });
  await http('POST', `${ALU}/mediaserver/${serverId}/usersync`, { al: AL_KEY });
  r = await http('GET', `${ALU}/jellyfin/watchlist`, { al: PLUGIN_KEY, headers: { 'X-Arclight-Jellyfin-User': N(kidId) } });
  check('disabled Jellyfin account -> 403 account_disabled (even though linked)', r.status === 403 && r.json?.code === 'account_disabled', r.body);

  // Unlinked Jellyfin user.
  const auth2 = await jfLogin('e2euser-renamed', 'e2e-pass-2');
  r = await proxy('GET', 'Watchlist', undefined, auth2.AccessToken);
  check('unlinked Jellyfin user gets 403 not_linked', r.status === 403 && r.json?.code === 'not_linked', r.body);
  r = await proxy('GET', 'Search?q=matrix', undefined, auth2.AccessToken);
  check('unlinked user: search also not_linked', r.status === 403 && r.json?.code === 'not_linked', r.body);

  // Plugin key confinement.
  r = await http('GET', `${ALU}/system/status`, { al: PLUGIN_KEY });
  check('alj_ key cannot call a normal Arclight route (403)', r.status === 403, `${r.status} ${r.body}`);
  r = await http('GET', `${ALU}/settings/jellyfinplugin`, { al: PLUGIN_KEY });
  check('alj_ key cannot call plugin admin routes (403)', r.status === 403, `${r.status} ${r.body}`);
  r = await http('GET', `${ALU}/jellyfin/ping`, { al: PLUGIN_KEY });
  check('alj_ key can call /jellyfin/ping', r.status === 200, r.body);

  // Plugin health: no Arclight errors, events delivered.
  r = await http('GET', `${JF}/Arclight/Admin/Status`, { jf: jfTok });
  check('plugin delivered events without errors', (r.json?.queue?.delivered ?? 0) > 0 && !r.json?.lastError, r.json);
  const jfErrors = docker('logs', JFC).split('\n').filter((l) => /Arclight/.test(l) && /(ERR|WRN|Exception)/.test(l));
  check('no Arclight warnings in the Jellyfin log', jfErrors.length === 0, jfErrors.slice(0, 5));
  const alLog = spawnSync('docker', ['logs', AL], { encoding: 'utf8' });
  const alErrors = (alLog.stdout + alLog.stderr).split('\n').filter((l) => /jellyfin/i.test(l) && /"level":(50|60)|error/i.test(l));
  if (alErrors.length) note(`Arclight log lines mentioning jellyfin + error:\n  ${alErrors.slice(0, 8).join('\n  ')}`);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error('ERROR', e.stack ?? e.message);
} finally {
  const bad = results.filter((x) => !x.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  try { writeFileSync(join(work, '..', `e2e-results-${Date.now()}.json`), JSON.stringify({ results, notes }, null, 2)); } catch { /* ignore */ }
  if (!args.keep) {
    cleanup();
    try { rmSync(work, { recursive: true, force: true }); } catch { /* container-owned files */ }
  } else {
    console.log(`kept ${AL} (:${AL_PORT}) and ${JFC} (:${JF_PORT}); clean up: docker rm -f ${AL} ${JFC} && docker network rm ${NET}`);
  }
  process.exit(failed || bad.length ? 1 : 0);
}
