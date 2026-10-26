// The container swap, as a standalone Node script with no imports beyond node:http. It runs
// either as a child process of the api (updates that do not touch the Arclight container) or
// inside a short-lived helper container started from the Arclight image (updates that do,
// because stopping our own container ends this process). Input: ARCLIGHT_UPDATE_PLAN =
// { delayMs, items: [{ name, oldId, newId }] } with parents before dependents; the new
// containers already exist under temporary names.
//
// Sequence: stop old (dependents first) -> rename old to <name>-arclight-old -> rename new to
// <name> -> start new (parents first) -> remove old. Any failure after the stop rolls back:
// remove the new containers, give the old ones their names back and start them.
//
// Socket: ARCLIGHT_DOCKER_TCP=host:port (tests) or ARCLIGHT_DOCKER_SOCKET (default
// /var/run/docker.sock).

export const SWAP_SCRIPT = [
  "'use strict';",
  "const http = require('node:http');",
  'const plan = JSON.parse(process.env.ARCLIGHT_UPDATE_PLAN || "{}");',
  'const tcp = process.env.ARCLIGHT_DOCKER_TCP;',
  "const target = tcp ? { host: tcp.split(':')[0], port: Number(tcp.split(':')[1]) } : { socketPath: process.env.ARCLIGHT_DOCKER_SOCKET || '/var/run/docker.sock' };",
  'function call(method, path) {',
  '  return new Promise(function (resolve, reject) {',
  "    const req = http.request(Object.assign({ method: method, path: path, headers: { host: 'docker' } }, target), function (res) {",
  "      let body = '';",
  "      res.on('data', function (c) { body += c; });",
  "      res.on('end', function () {",
  '        if ((res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 304) resolve(body);',
  "        else reject(new Error(method + ' ' + path + ' -> ' + res.statusCode + ' ' + body));",
  '      });',
  '    });',
  "    req.on('error', reject);",
  '    req.end();',
  '  });',
  '}',
  'function quiet(p) { return p.catch(function () {}); }',
  'function q(s) { return encodeURIComponent(s); }',
  'async function main() {',
  '  const items = plan.items || [];',
  '  const reversed = items.slice().reverse();',
  '  if (plan.delayMs) await new Promise(function (r) { setTimeout(r, plan.delayMs); });',
  "  for (const i of reversed) await quiet(call('POST', '/containers/' + i.oldId + '/stop?t=30'));",
  '  try {',
  "    for (const i of reversed) await call('POST', '/containers/' + i.oldId + '/rename?name=' + q(i.name + '-arclight-old'));",
  "    for (const i of items) await call('POST', '/containers/' + i.newId + '/rename?name=' + q(i.name));",
  "    for (const i of items) await call('POST', '/containers/' + i.newId + '/start');",
  '  } catch (err) {',
  "    process.stderr.write('update failed, rolling back: ' + err.message + '\\n');",
  "    for (const i of reversed) await quiet(call('DELETE', '/containers/' + i.newId + '?force=1'));",
  '    for (const i of items) {',
  "      await quiet(call('POST', '/containers/' + i.oldId + '/rename?name=' + q(i.name)));",
  "      await quiet(call('POST', '/containers/' + i.oldId + '/start'));",
  '    }',
  '    process.exit(1);',
  '  }',
  "  for (const i of items) await quiet(call('DELETE', '/containers/' + i.oldId + '?force=1'));",
  "  process.stdout.write('updated ' + items.map(function (i) { return i.name; }).join(', ') + '\\n');",
  '}',
  "main().catch(function (err) { process.stderr.write(String(err && err.message || err) + '\\n'); process.exit(1); });",
].join('\n');

export interface SwapItem {
  name: string;
  oldId: string;
  newId: string;
}

export interface SwapPlan {
  delayMs: number;
  items: SwapItem[];
}
