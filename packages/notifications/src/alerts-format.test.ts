import { describe, expect, it } from 'vitest';
import { DiscordAgent } from './agents/discord.js';
import { eventToEnv } from './agents/custom-script.js';
import { formatDuration, formatEvent, timelineTypeLabel } from './format.js';
import type { DailySummary, NotificationEvent } from './types.js';

const base = { instanceName: 'Arclight', timestamp: '2026-10-26T08:00:00.000Z', applicationUrl: 'https://arclight.example/' };
const download = { trackedDownloadId: 4, downloadId: 'abcdef', title: 'Show.S01E01.1080p' };

const summary: DailySummary = {
  id: 1,
  generatedAt: '2026-10-26T08:00:00.000Z',
  periodStart: '2026-10-25T08:00:00.000Z',
  periodEnd: '2026-10-26T08:00:00.000Z',
  counts: { grabbed: 5, imported: 4, failed: 1, stalled: 2, recovered: 1, replaced: 1 },
  killSwitch: { pauses: 2, totalMs: 65 * 60_000 },
  disk: [
    { path: '/tv', kind: 'rootFolder', freeBytes: 500 * 1024 ** 3, changeBytes: -20 * 1024 ** 3 },
    { path: '/downloads', kind: 'download', freeBytes: null, changeBytes: null },
  ],
  problems: [{ title: 'Broken.Movie', type: 'importFailed', message: 'No video files', time: '2026-10-25T13:00:00.000Z' }],
  healthIssues: [{ source: 'IndexerStatus', status: 'warning', message: 'An indexer is failing' }],
  downloading: { count: 12, items: [{ id: 1, title: 'Busy.Download', progress: 0.42 }] },
};

describe('download alert formatting', () => {
  it('describes stalled downloads and import problems by download title with a queue link', () => {
    const stalled = formatEvent({ ...base, type: 'downloadStalled', download, message: 'No new data for 30 minutes' });
    expect(stalled).toMatchObject({ subject: 'Download Stalled', title: download.title, severity: 'warning', link: 'https://arclight.example/activity/queue' });
    expect(stalled.body).toContain('Message: No new data for 30 minutes');

    const failed = formatEvent({ ...base, type: 'importProblem', problem: 'failed', download, message: 'Disk error' });
    expect(failed).toMatchObject({ subject: 'Import Failed', severity: 'error' });
    expect(formatEvent({ ...base, type: 'importProblem', problem: 'blocked', download }).subject).toBe('Import Blocked');
  });

  it('labels unknown timeline entries from their type and keeps their message', () => {
    const update = formatEvent({ ...base, type: 'downloadUpdate', download, timelineType: 'releaseReplaced', severity: 'info', message: 'Swapped for 720p' });
    expect(update.subject).toBe('Download Release Replaced');
    expect(update.body).toContain('Swapped for 720p');
    expect(formatEvent({ ...base, type: 'downloadUpdate', download, timelineType: 'recovered', severity: 'ok' }).severity).toBe('success');
    expect(timelineTypeLabel('grab_held')).toBe('Grab Held');
  });

  it('describes kill-switch lockdowns, reminders and resumes', () => {
    const paused = formatEvent({ ...base, type: 'killSwitch', reason: 'VPN down', since: base.timestamp, pausedCount: 3, titles: ['A', 'B'] });
    expect(paused).toMatchObject({ subject: 'Downloads Paused by Kill Switch', title: '3 downloads paused', severity: 'warning' });
    expect(paused.body).toContain('Reason: VPN down');
    expect(paused.body).toContain('...and 1 more');
    const reminder = formatEvent({ ...base, type: 'killSwitch', since: base.timestamp, pausedCount: 1, titles: [], pausedMinutes: 31, urgent: true });
    expect(reminder).toMatchObject({ subject: 'Downloads Still Paused by Kill Switch', severity: 'error' });
    expect(reminder.body).toContain('Paused For: 31 min');
    const resumed = formatEvent({ ...base, type: 'killSwitchResumed', resumedCount: 1, durationMs: 3_900_000 });
    expect(resumed).toMatchObject({ title: '1 download resumed', severity: 'success' });
    expect(resumed.body).toContain('Paused For: 1 h 5 min');
    expect(formatDuration(45_000)).toBe('45 s');
  });

  it('describes disk space by level', () => {
    const full = formatEvent({ ...base, type: 'diskSpaceLow', urgent: true, health: { source: 'DownloadDiskSpace', status: 'error', message: '2 download(s) cannot finish' } });
    expect(full).toMatchObject({ subject: 'Disk Full', title: '2 download(s) cannot finish', severity: 'error' });
  });

  it('lays out the daily summary', () => {
    const f = formatEvent({ ...base, type: 'dailySummary', summary });
    expect(f.title).toBe('5 grabbed, 4 imported, 1 failed');
    expect(f.severity).toBe('warning');
    const byName = new Map(f.fields.map((x) => [x.name, x.value]));
    expect(byName.get('Kill Switch')).toBe('2 pauses, 1 h 5 min in total');
    expect(byName.get('Disk Free')).toBe('/tv: 500 GB (-20.0 GB)\n/downloads: unknown');
    expect(byName.get('Problems')).toBe('Import Failed: Broken.Movie (No video files)');
    expect(byName.get('Downloading')).toBe('Busy.Download (42%)\n...and 11 more');
    expect(f.link).toBe('https://arclight.example/activity/history');
  });

  it('batches held alerts into one message at the worst severity', () => {
    const inner: NotificationEvent[] = [
      { ...base, type: 'downloadStalled', download },
      { ...base, type: 'importProblem', problem: 'failed', download: { ...download, title: 'Other' } },
    ];
    const f = formatEvent({ ...base, type: 'heldAlerts', events: inner, heldSince: base.timestamp });
    expect(f).toMatchObject({ subject: 'Alerts From Quiet Hours', title: '2 alerts held during quiet hours', severity: 'error' });
    expect(f.fields[0]?.value).toBe(`Download Stalled: ${download.title}\nImport Failed: Other`);
  });

  it('builds a Discord embed and script environment for the new events', () => {
    const agent = new DiscordAgent({ webhookUrl: 'https://discord.example/api/webhooks/1/x', grabFields: [], importFields: [], manualInteractionFields: [] } as never);
    const payload = agent.buildPayload({ ...base, type: 'dailySummary', summary });
    expect(payload.embeds[0]).toMatchObject({ title: '5 grabbed, 4 imported, 1 failed', description: 'Daily Summary' });
    const env = eventToEnv({ ...base, type: 'killSwitch', since: base.timestamp, pausedCount: 2, titles: ['A', 'B'] });
    expect(env).toMatchObject({ ARCLIGHT_EVENT_TYPE: 'killSwitch', ARCLIGHT_PAUSED_COUNT: '2', ARCLIGHT_TITLES: 'A|B' });
  });
});
