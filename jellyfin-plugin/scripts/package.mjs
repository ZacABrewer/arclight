#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Zips built plugin DLLs the way Jellyfin installs them (DLL + meta.json at the zip root) and
// records their MD5 checksums.
//
//   node scripts/package.mjs --version 1.0.0 [--timestamp 2026-11-01T00:00:00Z] [--out artifacts]
//
// Expects build output at artifacts/build/<abiTag>/Jellyfin.Plugin.Arclight.dll (see scripts/build.sh).
// Writes artifacts/arclight-jellyfin_<version>.<abiTag>.zip and artifacts/release.json:
//   { version, timestamp, files: [{ file, version, targetAbi, checksum }] }
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertSemver, changelogFor, md5, parseArgs, pluginRoot, readPluginMeta, zip } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const version = String(args.version ?? '');
assertSemver(version);
const timestamp = String(args.timestamp ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
const outDir = resolve(pluginRoot, String(args.out ?? 'artifacts'));
const meta = readPluginMeta();
const changelog = changelogFor(version);

mkdirSync(outDir, { recursive: true });
const files = [];
for (const target of meta.targets) {
  const dll = join(outDir, 'build', target.abiTag, meta.assembly);
  if (!existsSync(dll)) {
    console.error(`missing ${dll} (build for Jellyfin ${target.jellyfin} first)`);
    process.exit(1);
  }
  const fullVersion = `${version}.${target.abiTag}`;
  const metaJson = {
    category: meta.category,
    changelog,
    description: meta.description,
    guid: meta.guid,
    name: meta.name,
    overview: meta.overview,
    owner: meta.owner,
    targetAbi: target.targetAbi,
    timestamp,
    version: fullVersion,
    status: 'Active',
    autoUpdate: true,
    imagePath: '',
    assemblies: [meta.assembly],
  };
  const archive = zip([
    { name: meta.assembly, data: readFileSync(dll) },
    { name: 'meta.json', data: Buffer.from(JSON.stringify(metaJson, null, 2) + '\n', 'utf8') },
  ]);
  const file = `arclight-jellyfin_${fullVersion}.zip`;
  writeFileSync(join(outDir, file), archive);
  const checksum = md5(archive);
  writeFileSync(join(outDir, file + '.md5'), `${checksum}  ${file}\n`);
  files.push({ file, version: fullVersion, targetAbi: target.targetAbi, checksum, jellyfin: target.jellyfin });
  console.log(`${file}  md5 ${checksum}  (Jellyfin ${target.jellyfin}, targetAbi ${target.targetAbi})`);
}

writeFileSync(join(outDir, 'release.json'), JSON.stringify({ version, timestamp, changelog, files }, null, 2) + '\n');
