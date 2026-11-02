// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers for the packaging and manifest scripts. Node 22+, no dependencies.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

export const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = join(pluginRoot, '..');

export function readPluginMeta() {
  return JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
}

/** Parses "--key value" / "--flag" arguments. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function md5(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

/** Release notes for a version from CHANGELOG.md ("## 1.2.3" sections). */
export function changelogFor(version) {
  const text = readFileSync(join(pluginRoot, 'CHANGELOG.md'), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return `Arclight for Jellyfin ${version}`;
  const body = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) body.push(lines[i]);
  return body.join('\n').trim();
}

/** Validates "1.2.3". */
export function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like 1.2.3, got "${version}"`);
}

/** Compares dotted numeric versions. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Minimal deterministic ZIP writer (deflate, no extra fields, fixed timestamp) so the same inputs
 * always give the same checksum.
 * @param {{ name: string, data: Buffer }[]} entries
 */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0; // 00:00:00
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
