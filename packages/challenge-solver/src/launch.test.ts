import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { browserArgs, launchBrowser, parseDevToolsActivePort, parseDevToolsListening } from './launch.js';

class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  pid = 4242;
  killed: string[] = [];
  kill(signal = 'SIGTERM'): boolean {
    this.killed.push(signal);
    setImmediate(() => this.emit('exit', 0));
    return true;
  }
}

const tempProfile = () => mkdtempSync(path.join(tmpdir(), 'arclight-solver-'));
const spawnOf = (child: FakeChild) => () => child as unknown as ChildProcess;

describe('launch', () => {
  it('parses the DevTools line and the DevToolsActivePort file', () => {
    expect(parseDevToolsListening('\nDevTools listening on ws://127.0.0.1:53211/devtools/browser/ab-cd\n')).toBe('ws://127.0.0.1:53211/devtools/browser/ab-cd');
    expect(parseDevToolsActivePort('53211\r\n/devtools/browser/ab-cd\r\n')).toBe('ws://127.0.0.1:53211/devtools/browser/ab-cd');
    expect(parseDevToolsActivePort('nope\n/devtools/browser/x')).toBeUndefined();
  });

  it('builds headless-new args with an ephemeral debugging port and the dedicated profile', () => {
    const args = browserArgs({ userDataDir: 'C:\\cfg\\solver-profile' });
    expect(args).toContain('--headless=new');
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).toContain('--user-data-dir=C:\\cfg\\solver-profile');
    expect(args.at(-1)).toBe('about:blank');
    expect(browserArgs({ userDataDir: 'x', headless: false })).not.toContain('--headless=new');
  });

  it('resolves the endpoint from stderr', async () => {
    const child = new FakeChild();
    const p = launchBrowser({ executablePath: 'msedge.exe', userDataDir: tempProfile(), spawnImpl: spawnOf(child) });
    child.stderr.write('[1:2:INFO] starting\nDevTools listening on ws://127.0.0.1:9333/devtools/browser/xyz\n');
    const launched = await p;
    expect(launched.wsEndpoint).toBe('ws://127.0.0.1:9333/devtools/browser/xyz');
    await launched.kill();
    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('resolves the endpoint from the DevToolsActivePort file when stderr is silent', async () => {
    const child = new FakeChild();
    const dir = tempProfile();
    const p = launchBrowser({ executablePath: 'chrome', userDataDir: dir, spawnImpl: spawnOf(child) });
    setTimeout(() => writeFileSync(path.join(dir, 'DevToolsActivePort'), '61000\n/devtools/browser/from-file'), 50);
    expect((await p).wsEndpoint).toBe('ws://127.0.0.1:61000/devtools/browser/from-file');
  });

  it('fails with a launch error when the browser exits early', async () => {
    const child = new FakeChild();
    const p = launchBrowser({ executablePath: 'chrome', userDataDir: tempProfile(), spawnImpl: spawnOf(child) });
    child.stderr.write('profile in use');
    setTimeout(() => child.emit('exit', 21), 20);
    await expect(p).rejects.toMatchObject({ code: 'launch' });
  });

  it('times out when no endpoint appears and kills the process', async () => {
    const child = new FakeChild();
    const p = launchBrowser({ executablePath: 'chrome', userDataDir: tempProfile(), timeoutMs: 150, spawnImpl: spawnOf(child) });
    await expect(p).rejects.toThrow(/DevTools endpoint within 150 ms/);
    expect(child.killed.length).toBe(1);
  });
});
