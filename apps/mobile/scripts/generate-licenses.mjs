#!/usr/bin/env node
// Writes src/generated/licenses.json: every production JavaScript dependency of the app (direct
// and transitive) with its version and license, plus the native libraries the Capacitor plugins
// pull in through Gradle / Swift Package Manager. Shown on the app's Licenses screen.
// Run after changing dependencies: pnpm --filter @arclight/mobile licenses
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function resolveFrom(dir, name) {
  for (let d = dir; ; d = dirname(d)) {
    const candidate = join(d, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(d) === d) return null;
  }
}

const seen = new Map();
function visit(dir, name) {
  const pkgDir = resolveFrom(dir, name);
  if (!pkgDir) return;
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  let repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (repo) repo = repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/');
  if (repo && !/^https?:\/\//.test(repo)) repo = /^[\w-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}` : undefined;
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN');
  seen.set(key, { name: pkg.name, version: pkg.version, license, ...(repo ? { repository: repo } : {}) });
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(pkgDir, dep);
}

for (const dep of Object.keys(own.dependencies ?? {})) visit(root, dep);

const packages = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const native = [
  { name: 'Capacitor runtime (iOS, Android)', license: 'MIT' },
  { name: 'AndroidX libraries (AppCompat, WebKit, Biometric, CameraX, Core Splashscreen...)', license: 'Apache-2.0' },
  { name: 'Firebase Cloud Messaging (Android, push only)', license: 'Apache-2.0' },
  { name: 'Google ML Kit Barcode Scanning (Android)', license: 'ML Kit Terms of Service' },
  { name: 'ZXing (Android barcode scanning)', license: 'Apache-2.0' },
  { name: 'Kotlin standard library and coroutines', license: 'Apache-2.0' },
  { name: 'Material Components for Android', license: 'Apache-2.0' },
  { name: 'OutSystems / Ionic barcode libraries (ionbarcode)', license: 'MIT' },
];
writeFileSync(join(root, 'src/generated/licenses.json'), `${JSON.stringify({ packages, native }, null, 2)}\n`);
console.log(`licenses.json: ${packages.length} packages`);
