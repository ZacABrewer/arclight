import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs scripts/bundle.mjs into a temp folder and checks the artifact statically: the Docker
// image runs this file with no TypeScript sources around, so nothing may resolve into src/.
const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let out: string;
let code: string;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'arclight-bundle-'));
  execFileSync(process.execPath, [join(apiRoot, 'scripts', 'bundle.mjs'), '--outdir', out], { stdio: 'pipe' });
  code = readFileSync(join(out, 'server.mjs'), 'utf8');
}, 120_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('api bundle', () => {
  it('writes dist/server.mjs as an ESM bundle', () => {
    expect(existsSync(join(out, 'server.mjs'))).toBe(true);
    expect(code.length).toBeGreaterThan(100_000);
    expect(code.startsWith("import { createRequire as __arclightCreateRequire } from 'node:module';")).toBe(true);
  });

  it('points asset lookups at the bundle folder and defaults to production', () => {
    expect(code).toContain('process.env.ARCLIGHT_ASSET_ROOT ??= __dirname;');
    expect(code).toContain("process.env.NODE_ENV ??= 'production';");
  });

  it('has no import.meta.url-relative path into src/ and no absolute source paths', () => {
    expect(code).not.toMatch(/new URL\(\s*["'`][^"'`]*\bsrc\//);
    expect(code).not.toMatch(/import\.meta\.url[^;]{0,200}["'`][^"'`]*\/src\//);
    expect(code).not.toContain(apiRoot.split(sep).join('/'));
    expect(code).not.toContain(JSON.stringify(apiRoot).slice(1, -1));
  });

  it('keeps only native packages external and never imports pino-pretty', () => {
    const meta = JSON.parse(readFileSync(join(out, 'bundle-meta.json'), 'utf8')) as {
      externals: string[];
      optional: string[];
      externalImports: string[];
    };
    expect(meta.externals).toEqual(['better-sqlite3']);
    expect(meta.externalImports).toContain('better-sqlite3');
    for (const name of meta.externalImports) expect([...meta.externals, ...meta.optional]).toContain(name);
    // The optional ws accelerators must only ever be reached through require (try/catch).
    expect(code).not.toMatch(/from\s*["'](?:bufferutil|utf-8-validate)["']/);
    expect(code).not.toMatch(/(?:require|import)\(\s*["']pino-pretty["']\)/);
  });

  it('copies migrations, builtin definitions and an externals manifest next to the bundle', () => {
    const sql = readdirSync(join(out, 'drizzle')).filter((f) => f.endsWith('.sql'));
    expect(sql.length).toBe(readdirSync(join(apiRoot, 'drizzle')).filter((f) => f.endsWith('.sql')).length);
    expect(existsSync(join(out, 'drizzle', 'meta', '_journal.json'))).toBe(true);
    expect(readdirSync(join(out, 'definitions', 'builtin')).filter((f) => f.endsWith('.yml'))).toHaveLength(8);
    const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).toEqual(['better-sqlite3']);
  });
});
