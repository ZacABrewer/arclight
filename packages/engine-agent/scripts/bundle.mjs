// Bundles the standalone engine agent (src/main.ts plus @arclight/torrent-engine and zod) into
// one ESM file with no runtime dependencies besides Node itself:
//
//   node scripts/bundle.mjs            -> packages/engine-agent/dist/agent.mjs
//   node scripts/bundle.mjs --outdir X -> X/agent.mjs (tests)
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--outdir');
const outDir = outIdx > 0 ? resolve(process.argv[outIdx + 1]) : join(root, 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(outDir, 'agent.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: { js: "import { createRequire as __agentCreateRequire } from 'node:module';\nconst require = __agentCreateRequire(import.meta.url);" },
  sourcemap: false,
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

const output = Object.entries(result.metafile.outputs).find(([k]) => k.endsWith('agent.mjs'))[1];
const external = [...new Set(output.imports.filter((i) => i.external && !i.path.startsWith('node:') && !builtinModules.includes(i.path)).map((i) => i.path))];
if (external.length > 0) {
  console.error(`agent bundle still imports ${external.join(', ')}`);
  process.exit(1);
}
console.log(`bundled ${join(outDir, 'agent.mjs')} (${(output.bytes / 1024).toFixed(0)} KiB)`);
