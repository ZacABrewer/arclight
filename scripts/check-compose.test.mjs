// node --test scripts/check-compose.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandDefaults, imageProblem, lintCompose, portHostIp } from './check-compose.mjs';

test('expandDefaults uses the default of ${VAR:-x} and gives up on bare variables', () => {
  assert.equal(expandDefaults('${BIND:-127.0.0.1:7879}:7879'), '127.0.0.1:7879:7879');
  assert.equal(expandDefaults('${BIND-10.0.0.5:1}:1'), '10.0.0.5:1:1');
  assert.equal(expandDefaults('${BIND}:7879'), null);
  assert.equal(expandDefaults('${BIND:?required}:7879'), null);
});

test('portHostIp', () => {
  assert.equal(portHostIp('"7878:7878"'), 'no-ip');
  assert.equal(portHostIp('7878'), 'no-ip');
  assert.equal(portHostIp('"6881:6881/udp"'), 'no-ip');
  assert.equal(portHostIp('"127.0.0.1:7879:7879"'), 'ok');
  assert.equal(portHostIp('"127.0.0.1::7879"'), 'ok');
  assert.equal(portHostIp('"[::1]:7879:7879"'), 'ok');
  assert.equal(portHostIp('"[::1]:7879"'), 'ok');
  assert.equal(portHostIp('"${AGENT_API_BIND:-127.0.0.1:7879}:7879"'), 'ok');
  assert.equal(portHostIp('"${AGENT_API_BIND:-7879}:7879"'), 'no-ip');
  assert.equal(portHostIp('"${AGENT_API_BIND}:7879"'), 'unresolved');
});

test('imageProblem', () => {
  assert.equal(imageProblem('qmcgaw/gluetun:v3.41.3'), null);
  assert.equal(imageProblem('debian:bookworm-slim@sha256:abc'), null);
  assert.match(imageProblem('qmcgaw/gluetun:latest'), /latest/);
  assert.match(imageProblem('whisper:latest-gpu'), /latest-gpu/);
  assert.match(imageProblem('qmcgaw/gluetun'), /no tag/);
  assert.match(imageProblem('localhost:5000/gluetun'), /no tag/);
  assert.equal(imageProblem('${ARCLIGHT_IMAGE:-ghcr.io/zacabrewer/arclight:latest}'), null);
  assert.match(imageProblem('${OTHER:-ghcr.io/x/y:latest}'), /latest/);
});

test('lintCompose flags unpinned images (commented ones too) and IP-less ports', () => {
  const text = [
    'services:',
    '  a:',
    '    image: x/a:latest',
    '    # image: x/a:latest-gpu',
    '    ports:',
    '      # a comment inside the list',
    '      - "7878:7878"',
    '      - "8080:8080" # web UI; publish: all-interfaces (LAN)',
    '      - "${BIND:-127.0.0.1:9}:9"',
    '      - target: 80',
    '        published: "8081"',
    '      - target: 81',
    '        published: "8082"',
    '        host_ip: 127.0.0.1',
    '    environment:',
    '      - "NOT_A_PORT=1:2"',
  ].join('\n');
  const problems = lintCompose(text);
  assert.deepEqual(
    problems.map((p) => Number(p.split(':')[0])),
    [3, 4, 7, 10],
  );
});

test('lintCompose accepts a clean file', () => {
  const text = ['services:', '  a:', '    image: x/a:1.2.3', '    ports:', '      - "127.0.0.1:1:1"', '    restart: always'].join('\n');
  assert.deepEqual(lintCompose(text), []);
});
