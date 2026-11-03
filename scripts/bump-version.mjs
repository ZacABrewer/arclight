#!/usr/bin/env node
// Usage: node scripts/bump-version.mjs <X.Y.Z>
// Sets "version" in the root, apps/api, apps/web and apps/player package.json files (the Android
// player's versionName/versionCode come from apps/player's), and rewrites the iOS player's
// apps/player/ios/App/version.xcconfig to match.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iosVersion, writeIosVersion } from '../apps/player/scripts/ios-version.mjs';

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/bump-version.mjs <X.Y.Z>');
  process.exit(1);
}
try {
  iosVersion(version); // fail before writing anything if iOS/Android can't derive a build number
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const rel of ['package.json', 'apps/api/package.json', 'apps/web/package.json', 'apps/player/package.json']) {
  const file = join(root, rel);
  const text = readFileSync(file, 'utf8');
  if (!/"version":\s*"[^"]*"/.test(text)) {
    console.error(`No version field found in ${rel}`);
    process.exit(1);
  }
  writeFileSync(file, text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));
  console.log(`${rel} -> ${version}`);
}
// The committed iOS values use the derived build number; CI overrides it at build time.
const ios = writeIosVersion({ pkgVersion: version, envCode: '' });
console.log(`apps/player/ios/App/version.xcconfig -> ${ios.version} (${ios.build})`);
