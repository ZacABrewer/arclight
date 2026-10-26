// Bundles the api and every workspace package into one ESM file, dist/server.mjs, so the
// Docker image ships plain JavaScript instead of TypeScript sources + tsx. Only packages
// that cannot be inlined stay external (native addons); they are installed next to the
// bundle in the image. Runtime-read assets (drizzle migrations, builtin indexer
// definitions) are copied into dist/ and found through ARCLIGHT_ASSET_ROOT, which the
// banner points at the bundle's own folder.
//
//   node scripts/bundle.mjs            -> apps/api/dist/server.mjs (+ drizzle/, definitions/)
//   node scripts/bundle.mjs --outdir X -> same layout under X (tests)
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(apiRoot, '..', '..');

/** Packages left out of the bundle; the image installs exactly these. */
export const EXTERNALS = ['better-sqlite3'];
/**
 * Optional native accelerators `ws` require()s inside try/catch; esbuild leaves them as
 * runtime requires, they are not installed and ws falls back to its JavaScript paths.
 */
export const OPTIONAL_RUNTIME_REQUIRES = ['bufferutil', 'utf-8-validate'];

const outIdx = process.argv.indexOf('--outdir');
const outDir = outIdx > 0 ? resolve(process.argv[outIdx + 1]) : join(apiRoot, 'dist');

// The bundle is a production artifact: default NODE_ENV so the logger never reaches for the
// pino-pretty worker transport, provide require/__dirname for inlined CommonJS, and point
// asset lookups at the folder the bundle lives in.
const banner = [
  "import { createRequire as __arclightCreateRequire } from 'node:module';",
  "import { fileURLToPath as __arclightFileURLToPath } from 'node:url';",
  "import { dirname as __arclightDirname } from 'node:path';",
  'const require = __arclightCreateRequire(import.meta.url);',
  'const __filename = __arclightFileURLToPath(import.meta.url);',
  'const __dirname = __arclightDirname(__filename);',
  "process.env.NODE_ENV ??= 'production';",
  'process.env.ARCLIGHT_ASSET_ROOT ??= __dirname;',
].join('\n');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(apiRoot, 'src', 'index.ts')],
  outfile: join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: EXTERNALS,
  banner: { js: banner },
  // pino-pretty is a dev-only transport target resolved by name at runtime, never imported.
  sourcemap: false,
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

cpSync(join(apiRoot, 'drizzle'), join(outDir, 'drizzle'), { recursive: true });
cpSync(join(repoRoot, 'packages', 'indexers', 'src', 'definitions', 'builtin'), join(outDir, 'definitions', 'builtin'), {
  recursive: true,
});

// Minimal manifest for installing the externals next to the bundle (Dockerfile).
const apiPkg = JSON.parse(
  await import('node:fs/promises').then((fs) => fs.readFile(join(apiRoot, 'package.json'), 'utf8')),
);
const deps = Object.fromEntries(EXTERNALS.map((name) => [name, apiPkg.dependencies[name]]));
writeFileSync(
  join(outDir, 'package.json'),
  `${JSON.stringify({ name: 'arclight-server', private: true, type: 'module', dependencies: deps }, null, 2)}\n`,
);

// What the bundle still imports at runtime besides node builtins (checked by bundle.test.ts).
const output = result.metafile.outputs[Object.keys(result.metafile.outputs).find((k) => k.endsWith('server.mjs'))];
const externalImports = [...new Set(output.imports.filter((i) => i.external && !i.path.startsWith('node:') && !builtinModules.includes(i.path)).map((i) => i.path))].sort();
writeFileSync(join(outDir, 'bundle-meta.json'), `${JSON.stringify({ externals: EXTERNALS, optional: OPTIONAL_RUNTIME_REQUIRES, externalImports }, null, 2)}
`);
const bytes = output.bytes;
console.log(`bundled ${join(outDir, 'server.mjs')} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
