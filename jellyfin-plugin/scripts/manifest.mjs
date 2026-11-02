#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Adds a release to the Jellyfin plugin repository manifest served at
// https://arclight.moviemethat.com/jellyfin/manifest.json (site/public/jellyfin/manifest.json).
//
//   node scripts/manifest.mjs [--release artifacts/release.json] [--manifest ../site/public/jellyfin/manifest.json]
//                             [--tag-prefix jellyfin-plugin-v] [--check]
//
// Each Jellyfin ABI build becomes its own version entry (1.0.0.12 for Jellyfin 12, 1.0.0.11 for
// 10.11). Jellyfin picks the newest entry whose targetAbi it supports. Re-running for the same
// release replaces its entries, so the script is idempotent. --check validates the manifest only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { compareVersions, parseArgs, pluginRoot, readPluginMeta, repoRoot } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const manifestPath = resolve(repoRoot, String(args.manifest ?? 'site/public/jellyfin/manifest.json'));
const meta = readPluginMeta();
const MAX_VERSIONS = 40; // keep the file small; old builds stay downloadable from GitHub Releases

function load() {
  if (!existsSync(manifestPath)) return [];
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${manifestPath} is not a JSON array`);
  return parsed;
}

function validate(manifest) {
  const problems = [];
  for (const plugin of manifest) {
    for (const key of ['guid', 'name', 'overview', 'description', 'owner', 'category', 'versions']) {
      if (plugin[key] === undefined) problems.push(`${plugin.name ?? '?'}: missing ${key}`);
    }
    const seen = new Set();
    for (const v of plugin.versions ?? []) {
      for (const key of ['version', 'changelog', 'targetAbi', 'sourceUrl', 'checksum', 'timestamp']) {
        if (!v[key]) problems.push(`${plugin.name} ${v.version ?? '?'}: missing ${key}`);
      }
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(v.version ?? '')) problems.push(`${plugin.name}: version ${v.version} is not 4-part`);
      if (!/^[0-9a-f]{32}$/.test(v.checksum ?? '')) problems.push(`${plugin.name} ${v.version}: checksum is not an MD5 hex string`);
      if (!/^https:\/\//.test(v.sourceUrl ?? '')) problems.push(`${plugin.name} ${v.version}: sourceUrl must be https`);
      if (seen.has(v.version)) problems.push(`${plugin.name}: duplicate version ${v.version}`);
      seen.add(v.version);
    }
  }
  return problems;
}

let manifest = load();

if (!args.check) {
  const releasePath = resolve(pluginRoot, String(args.release ?? 'artifacts/release.json'));
  const release = JSON.parse(readFileSync(releasePath, 'utf8'));
  const tag = `${args['tag-prefix'] ?? 'jellyfin-plugin-v'}${release.version}`;
  let plugin = manifest.find((p) => p.guid === meta.guid);
  if (!plugin) {
    plugin = { guid: meta.guid, versions: [] };
    manifest.push(plugin);
  }
  Object.assign(plugin, {
    guid: meta.guid,
    name: meta.name,
    overview: meta.overview,
    description: meta.description,
    owner: meta.owner,
    category: meta.category,
    imageUrl: meta.imageUrl,
  });
  const fresh = release.files.map((f) => ({
    version: f.version,
    changelog: release.changelog,
    targetAbi: f.targetAbi,
    sourceUrl: `${meta.repository}/releases/download/${tag}/${f.file}`,
    checksum: f.checksum,
    timestamp: release.timestamp,
  }));
  const replaced = new Set(fresh.map((v) => v.version));
  plugin.versions = [...fresh, ...(plugin.versions ?? []).filter((v) => !replaced.has(v.version))]
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, MAX_VERSIONS);
  // Stable key order for clean diffs.
  manifest = manifest.map((p) => ({
    guid: p.guid, name: p.name, overview: p.overview, description: p.description, owner: p.owner,
    category: p.category, imageUrl: p.imageUrl, versions: p.versions,
  }));
}

const problems = validate(manifest);
if (problems.length) {
  console.error('manifest problems:\n  ' + problems.join('\n  '));
  process.exit(1);
}

if (!args.check) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${manifestPath}`);
} else {
  console.log(`${manifestPath}: ok (${manifest.reduce((n, p) => n + (p.versions?.length ?? 0), 0)} versions)`);
}
