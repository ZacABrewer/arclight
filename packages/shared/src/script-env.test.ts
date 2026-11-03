import { describe, expect, it } from 'vitest';
import { scriptEnvironment } from './script-env.js';

describe('scriptEnvironment', () => {
  const base = {
    PATH: '/usr/bin',
    Path: 'C:/Windows',
    HOME: '/config',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    TZ: 'UTC',
    TEMP: '/tmp',
    SystemRoot: 'C:/Windows',
    ComSpec: 'cmd.exe',
    PATHEXT: '.EXE',
    ARCLIGHT_API_KEY: 'secret',
    ARCLIGHT_FFMPEG: '/usr/bin/ffmpeg',
    POSTGRES_PASSWORD: 'secret',
    MY_TOKEN: 'mine',
    UNSET: undefined,
  };

  it('keeps standard variables, drops the rest and adds the event variables', () => {
    const env = scriptEnvironment(base, { ARCLIGHT_EVENT_TYPE: 'grab' });
    expect(env).toEqual({
      PATH: '/usr/bin',
      Path: 'C:/Windows',
      HOME: '/config',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      TZ: 'UTC',
      TEMP: '/tmp',
      SystemRoot: 'C:/Windows',
      ComSpec: 'cmd.exe',
      PATHEXT: '.EXE',
      ARCLIGHT_FFMPEG: '/usr/bin/ffmpeg',
      ARCLIGHT_EVENT_TYPE: 'grab',
    });
  });

  it('passes extra names listed in ARCLIGHT_SCRIPT_ENV, or everything with *', () => {
    expect(scriptEnvironment({ ...base, ARCLIGHT_SCRIPT_ENV: 'my_token, OTHER' })['MY_TOKEN']).toBe('mine');
    const all = scriptEnvironment({ ...base, ARCLIGHT_SCRIPT_ENV: '*' });
    expect(all['POSTGRES_PASSWORD']).toBe('secret');
    expect(all['ARCLIGHT_SCRIPT_ENV']).toBeUndefined();
  });

  it('lets event variables win over inherited ones', () => {
    expect(scriptEnvironment({ ARCLIGHT_VERSION: 'x' }, { ARCLIGHT_VERSION: 'y' })).toEqual({ ARCLIGHT_VERSION: 'y' });
  });
});
