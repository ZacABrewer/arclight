import { describe, expect, it } from 'vitest';
import { execFileRunner } from './runner.js';

describe('execFileRunner', () => {
  it('gives the post-processing command a stripped environment plus its own variables', async () => {
    process.env['ARCLIGHT_TEST_SECRET'] = 'hunter2';
    try {
      const r = await execFileRunner(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
        timeoutMs: 20_000,
        env: { ARCLIGHT_SUBTITLE_PATH: '/x.srt' },
      });
      expect(r.ok).toBe(true);
      const env = JSON.parse(r.stdout.toString('utf8')) as Record<string, string>;
      expect(env['ARCLIGHT_SUBTITLE_PATH']).toBe('/x.srt');
      expect(env['ARCLIGHT_TEST_SECRET']).toBeUndefined();
      expect(env['PATH'] ?? env['Path']).toBeDefined();
    } finally {
      delete process.env['ARCLIGHT_TEST_SECRET'];
    }
  });
});
