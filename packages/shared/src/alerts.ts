import { z } from 'zod';
import { HealthCheck } from './system.js';

// Alert delivery settings (quiet hours, daily summary) and the stored daily summaries.
// Settings live in the `alerts` settings section; routes: GET/PUT /settings/alerts,
// GET /summary, GET /summary/latest, POST /summary.

/** "HH:MM", 24-hour, server local time. */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
export type LocalTime = z.infer<typeof LocalTime>;

/** 0 = Sunday ... 6 = Saturday (JavaScript `Date#getDay`). */
export const Weekday = z.number().int().min(0).max(6);
export type Weekday = z.infer<typeof Weekday>;

export const QuietHoursSettings = z.object({
  enabled: z.boolean().default(false),
  /** Quiet hours start at this local time... */
  start: LocalTime.default('22:00'),
  /** ...and end at this one (the next day when it is earlier than `start`). */
  end: LocalTime.default('07:00'),
  /** Days on which a quiet period starts. Empty means none. */
  days: z.array(Weekday).default([0, 1, 2, 3, 4, 5, 6]),
});
export type QuietHoursSettings = z.infer<typeof QuietHoursSettings>;

export const DailySummarySettings = z.object({
  enabled: z.boolean().default(true),
  /** When the summary is built and sent, server local time. */
  time: LocalTime.default('08:00'),
});
export type DailySummarySettings = z.infer<typeof DailySummarySettings>;

/** Settings section `alerts`. */
export const AlertSettings = z.object({
  quietHours: QuietHoursSettings.default(QuietHoursSettings.parse({})),
  dailySummary: DailySummarySettings.default(DailySummarySettings.parse({})),
});
export type AlertSettings = z.infer<typeof AlertSettings>;

/** GET /settings/alerts also says how many alerts quiet hours are holding right now. */
export const AlertSettingsResponse = AlertSettings.extend({
  heldAlerts: z.number().int(),
  /** Whether quiet hours are in effect at the time of the request. */
  quietNow: z.boolean(),
});
export type AlertSettingsResponse = z.infer<typeof AlertSettingsResponse>;

// ---- daily summary ----------------------------------------------------------------------

export const DailySummaryCounts = z.object({
  grabbed: z.number().int(),
  imported: z.number().int(),
  /** Import failures and download errors. */
  failed: z.number().int(),
  stalled: z.number().int(),
  recovered: z.number().int(),
  /** Downloads swapped for another release (self-healing). */
  replaced: z.number().int(),
});
export type DailySummaryCounts = z.infer<typeof DailySummaryCounts>;

export const DailySummaryDisk = z.object({
  path: z.string(),
  kind: z.enum(['rootFolder', 'download']),
  /** Bytes free now; null when the volume could not be read. */
  freeBytes: z.number().nullable(),
  /** Change since the previous summary (negative: less free); null when unknown. */
  changeBytes: z.number().nullable(),
});
export type DailySummaryDisk = z.infer<typeof DailySummaryDisk>;

export const DailySummaryProblem = z.object({
  title: z.string(),
  /** Timeline event type (importFailed, stalled, ...). */
  type: z.string(),
  message: z.string().optional(),
  /** ISO-8601 */
  time: z.string(),
});
export type DailySummaryProblem = z.infer<typeof DailySummaryProblem>;

export const DailySummaryDownload = z.object({
  id: z.number().int(),
  title: z.string(),
  /** 0..1 */
  progress: z.number(),
  /** Queue state code (downloading, stalled, killSwitch, ...), when known. */
  state: z.string().optional(),
});
export type DailySummaryDownload = z.infer<typeof DailySummaryDownload>;

export const DailySummary = z.object({
  id: z.number().int(),
  /** ISO-8601 */
  generatedAt: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  counts: DailySummaryCounts,
  killSwitch: z.object({
    pauses: z.number().int(),
    /** Milliseconds paused inside the period (an ongoing lockdown counts up to `periodEnd`). */
    totalMs: z.number().int(),
  }),
  disk: z.array(DailySummaryDisk),
  /** Failures, stalls and replacements of the period, newest first, at most 10. */
  problems: z.array(DailySummaryProblem),
  healthIssues: z.array(HealthCheck),
  downloading: z.object({
    count: z.number().int(),
    /** At most 10. */
    items: z.array(DailySummaryDownload),
  }),
});
export type DailySummary = z.infer<typeof DailySummary>;

export const DailySummaryListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type DailySummaryListQuery = z.infer<typeof DailySummaryListQuery>;

/** POST /summary: build one now. `notify` also sends it through the daily-summary trigger. */
export const DailySummaryGenerateRequest = z.object({
  notify: z.boolean().default(false),
});
export type DailySummaryGenerateRequest = z.infer<typeof DailySummaryGenerateRequest>;
