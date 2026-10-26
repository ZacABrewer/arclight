import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE, IMPORT } from '../../fixtures/events.js';
import { createAgent } from '../index.js';
import { fakeFetch } from '../test-utils.js';
import { escapeMarkdownV2, type TelegramPayload } from './telegram.js';

const SETTINGS = { botToken: '123:ABC-secret', chatId: '-100987', topicId: 55, sendSilently: true };

describe('TelegramAgent', () => {
  it('escapes every MarkdownV2 special character', () => {
    expect(escapeMarkdownV2('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s\\t')).toBe(
      'a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s\\\\t',
    );
    expect(escapeMarkdownV2('plain words 123')).toBe('plain words 123');
  });

  it('sends a grab message to the chat topic, silently, with escaped text', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { ok: true } }));
    const agent = createAgent('telegram', SETTINGS, { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.telegram.org/bot123:ABC-secret/sendMessage');
    const payload = call.json() as TelegramPayload;
    expect(payload).toMatchObject({ chat_id: '-100987', parse_mode: 'MarkdownV2', disable_notification: true, message_thread_id: 55 });
    expect(payload.text.split('\n')[0]).toBe('*Signal Lost \\(2023\\) \\- S02E03\\-E04 \\- Dead Air \\+ Carrier Wave*');
    expect(payload.text).toContain('Quality: WEBDL\\-1080p');
    expect(payload.text).toContain('Release: Signal\\.Lost\\.S02E03E04\\.1080p\\.WEB\\.H264\\-GRP');
    expect(payload.text).toContain('[Open](https://mt.example.com/series/7)');
  });

  it('describes imports and health issues', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { ok: true } }));
    const agent = createAgent('telegram', { botToken: 't', chatId: '1', includeLink: false }, { fetch: http.fetch });
    await agent.send(IMPORT);
    await agent.send(HEALTH_ISSUE);

    const imported = http.calls[0]!.json() as TelegramPayload;
    expect(imported.message_thread_id).toBeUndefined();
    expect(imported.disable_notification).toBe(false);
    expect(imported.text).toContain('Movie Imported');
    expect(imported.text).toContain('Codecs: x264 / DTS 5\\.1');
    expect(imported.text).not.toContain('[Open]');
    expect(imported.link_preview_options).toEqual({ is_disabled: true });

    const health = http.calls[1]!.json() as TelegramPayload;
    expect(health.text.startsWith('*Health Issue: Error*')).toBe(true);
    expect(health.text).toContain('Message: Unable to communicate with qBittorrent\\.');
  });

  it('maps HTTP failures and "ok: false" bodies to errors that hide the token', async () => {
    const forbidden = createAgent('telegram', SETTINGS, { fetch: fakeFetch(() => ({ status: 403, json: { ok: false, description: 'Forbidden' } })).fetch });
    const forbiddenError = (await forbidden.send(GRAB).catch((e: unknown) => e)) as Error;
    expect(forbiddenError).toMatchObject({ code: 'unauthorized', status: 403 });
    expect(forbiddenError.message).not.toContain('ABC-secret');

    const rejected = createAgent('telegram', SETTINGS, { fetch: fakeFetch(() => ({ status: 200, json: { ok: false, description: 'Bad Request: chat not found' } })).fetch });
    await expect(rejected.send(GRAB)).rejects.toMatchObject({ code: 'remoteError', message: expect.stringContaining('chat not found') });
  });
});
