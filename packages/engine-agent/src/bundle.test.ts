import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freePort } from './test-ports.js';
import { Cleanup, TOKEN, waitFor } from './test-support.js';

vi.setConfig({ testTimeout: 60_000 });

const c = new Cleanup();
afterEach(() => c.run());

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('agent bundle', () => {
  it('builds a dependency-free agent.mjs that serves the API from the environment', async () => {
    const out = await c.tmp('mt-agent-bundle-');
    const build = spawnSync(process.execPath, [join(root, 'scripts', 'bundle.mjs'), '--outdir', out], { encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    const source = await readFile(join(out, 'agent.mjs'), 'utf8');
    expect(source).not.toMatch(/from ['"](zod|@arclight\/)/);

    const data = await c.tmp();
    const downloads = await c.tmp();
    const port = await freePort();
    const child = spawn(process.execPath, [join(out, 'agent.mjs')], {
      env: {
        ...process.env,
        AGENT_TOKEN: TOKEN,
        AGENT_PORT: String(port),
        AGENT_HOST: '127.0.0.1',
        AGENT_DATA: data,
        AGENT_DOWNLOADS: downloads,
        AGENT_LISTEN_ADDRESS: '127.0.0.1',
        AGENT_LISTEN_PORT: '0',
        AGENT_DHT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    c.add(async () => {
      if (child.exitCode === null) child.kill();
      await exited;
    });
    await waitFor(() => output.includes('engine agent listening'), 20_000).catch(() => {
      throw new Error(`agent did not start: ${output}`);
    });
    const res = await fetch(`http://127.0.0.1:${port}/status`, { headers: { 'x-agent-token': TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ protocolVersion: 1, kind: 'standalone', running: true });
    expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(401);
  });

  it('exits with code 2 and a message when the token is missing', async () => {
    const out = await c.tmp('mt-agent-bundle-');
    expect(spawnSync(process.execPath, [join(root, 'scripts', 'bundle.mjs'), '--outdir', out]).status).toBe(0);
    const run = spawnSync(process.execPath, [join(out, 'agent.mjs')], { env: { ...process.env, AGENT_TOKEN: '' }, encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stdout).toContain('AGENT_TOKEN');
  });
});
