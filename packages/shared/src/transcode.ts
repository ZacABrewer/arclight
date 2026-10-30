import { z } from 'zod';

// Transcode / remux policies. A rule says which library files it applies to (media type, a
// tag or quality-profile scope, and `when` conditions on the file's media info) and what to do
// with them (an ffmpeg action plus options). Matching files become jobs in a persisted queue
// that the TranscodeWorker drains one file at a time. See docs/API.md "Transcode".

export const TranscodeMediaType = z.enum(['series', 'movie', 'all']);
export type TranscodeMediaType = z.infer<typeof TranscodeMediaType>;

/** Which library items a rule looks at (by the file's parent series/movie). */
export const TranscodeScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  /** Items carrying any of these tag ids. */
  z.object({ kind: z.literal('tags'), tagIds: z.array(z.number().int()).min(1) }),
  /** Items using any of these quality profiles. */
  z.object({ kind: z.literal('profiles'), qualityProfileIds: z.array(z.number().int()).min(1) }),
]);
export type TranscodeScope = z.infer<typeof TranscodeScope>;

/**
 * Conditions on the file; every given one must hold, and an empty object matches every file.
 * Codec names accept probe ids or friendly aliases (`h264`/`avc`/`x264`, `hevc`/`h265`/`x265`).
 * Files without media info never match a rule that has conditions.
 */
export const TranscodeWhen = z.object({
  /** `mkv` (= `matroska`), `mp4` (= `mov`), `avi` ... */
  container: z.string().trim().min(1).optional(),
  videoCodec: z.string().trim().min(1).optional(),
  /** Matches when any audio track has this codec (`dts`, `truehd`, `eac3` ...). */
  audioCodec: z.string().trim().min(1).optional(),
  /** True: only HDR/DV files; false: only SDR files. */
  hdr: z.boolean().optional(),
  /** Video height in pixels strictly above this (e.g. 1080 matches 2160p). */
  resolutionAbove: z.number().int().min(1).optional(),
  /** Overall bitrate strictly above this many kbit/s. */
  bitrateAboveKbps: z.number().min(0).optional(),
  /** File size strictly above this many GiB. */
  sizeAboveGb: z.number().min(0).optional(),
});
export type TranscodeWhen = z.infer<typeof TranscodeWhen>;

/**
 * remux: copy every kept stream into `options.container`. transcode: re-encode video and/or
 * audio per the options. stripTracks: copy, dropping audio/subtitle tracks not in
 * `keepLanguages` (and subtitles when `dropSubtitles`). addAudioTrack: copy everything and add
 * one compatibility track (default AAC stereo) made from the first kept audio track.
 */
export const TranscodeAction = z.enum(['remux', 'transcode', 'stripTracks', 'addAudioTrack']);
export type TranscodeAction = z.infer<typeof TranscodeAction>;

export const TranscodeContainer = z.enum(['mkv', 'mp4']);
export type TranscodeContainer = z.infer<typeof TranscodeContainer>;

export const TranscodeVideoCodec = z.enum(['copy', 'h264', 'hevc', 'av1']);
export type TranscodeVideoCodec = z.infer<typeof TranscodeVideoCodec>;

export const TranscodeAudioCodec = z.enum(['copy', 'aac', 'eac3']);
export type TranscodeAudioCodec = z.infer<typeof TranscodeAudioCodec>;

export const TranscodeHwaccel = z.enum(['none', 'vaapi', 'qsv', 'nvenc', 'videotoolbox']);
export type TranscodeHwaccel = z.infer<typeof TranscodeHwaccel>;

export const TranscodeOptions = z.object({
  container: TranscodeContainer.default('mkv'),
  videoCodec: TranscodeVideoCodec.default('copy'),
  /**
   * Quality, x264-style constant rate factor (lower is better). Mapped per encoder: `-crf`
   * (software), `-qp` (VAAPI), `-global_quality` (QSV), `-cq` (NVENC), `-q:v` (VideoToolbox).
   */
  crf: z.number().int().min(0).max(63).optional(),
  /** x264-style preset (`ultrafast` ... `veryslow`) or an encoder-native one (`p5`, `8`). */
  preset: z
    .string()
    .regex(/^[a-z0-9]+$/, 'preset must be lower-case letters/digits')
    .optional(),
  audio: TranscodeAudioCodec.default('copy'),
  /** Output channels for encoded audio (2 = stereo, 6 = 5.1). */
  channels: z.number().int().min(1).max(8).optional(),
  /** Audio/subtitle languages to keep (ISO 639 codes, `eng` or `en`). Empty keeps all. */
  keepLanguages: z.array(z.string().trim().toLowerCase().min(2).max(3)).default([]),
  dropSubtitles: z.boolean().default(false),
  hwaccel: TranscodeHwaccel.default('none'),
});
export type TranscodeOptions = z.infer<typeof TranscodeOptions>;
export type TranscodeOptionsInput = z.input<typeof TranscodeOptions>;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');

/**
 * Server-local time window in which a rule's queued jobs may start. `end` before `start`
 * crosses midnight (`22:00`-`06:00`); `start` equal to `end` is open all day. A job that
 * started inside the window runs to completion.
 */
export const TranscodeWindow = z.object({ start: HHMM, end: HHMM });
export type TranscodeWindow = z.infer<typeof TranscodeWindow>;

export const TranscodeRule = z.object({
  id: z.number().int(),
  name: z.string(),
  enabled: z.boolean(),
  mediaType: TranscodeMediaType,
  scope: TranscodeScope,
  when: TranscodeWhen,
  action: TranscodeAction,
  options: TranscodeOptions,
  /** Keep the original file next to the result instead of sending it to the recycle bin. */
  keepOriginal: z.boolean(),
  /** Queue matching files automatically after each import. */
  runAfterImport: z.boolean(),
  schedule: TranscodeWindow.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TranscodeRule = z.infer<typeof TranscodeRule>;

/** POST /transcoderule and PUT /transcoderule/:id body. */
export const TranscodeRuleInput = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  mediaType: TranscodeMediaType.default('all'),
  scope: TranscodeScope.default({ kind: 'all' }),
  when: TranscodeWhen.default({}),
  action: TranscodeAction,
  options: TranscodeOptions.prefault({}),
  keepOriginal: z.boolean().default(false),
  runAfterImport: z.boolean().default(false),
  schedule: TranscodeWindow.nullable().default(null),
});
export type TranscodeRuleInput = z.infer<typeof TranscodeRuleInput>;
export type TranscodeRuleInputRaw = z.input<typeof TranscodeRuleInput>;

export const TranscodeJobStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type TranscodeJobStatus = z.infer<typeof TranscodeJobStatus>;

/** What queued the job: `manual` (POST /transcode/run with mediaFileId) ignores the rule's window. */
export const TranscodeJobTrigger = z.enum(['manual', 'rule', 'import']);
export type TranscodeJobTrigger = z.infer<typeof TranscodeJobTrigger>;

export const TranscodeJob = z.object({
  id: z.number().int(),
  mediaFileId: z.number().int(),
  /** Null once the rule is deleted. */
  ruleId: z.number().int().nullable(),
  ruleName: z.string().nullable(),
  trigger: TranscodeJobTrigger,
  status: TranscodeJobStatus,
  /** 0-100. */
  progress: z.number(),
  /** Source path when queued. */
  path: z.string(),
  /** The ffmpeg command line (display only); empty until the job starts. */
  command: z.string(),
  message: z.string().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** Bytes. */
  sizeBefore: z.number().int().nullable(),
  sizeAfter: z.number().int().nullable(),
});
export type TranscodeJob = z.infer<typeof TranscodeJob>;

export const TranscodeJobsQuery = z.object({ status: TranscodeJobStatus.optional() });
export type TranscodeJobsQuery = z.infer<typeof TranscodeJobsQuery>;

/**
 * POST /transcode/run: `mediaFileId` queues that file for the first enabled rule matching it
 * (manual: starts regardless of the rule's window); `ruleId` queues every matching file of the
 * library for that rule (gated by its window).
 */
export const TranscodeRunRequest = z
  .object({ mediaFileId: z.number().int().min(1).optional(), ruleId: z.number().int().min(1).optional() })
  .refine((r) => (r.mediaFileId === undefined) !== (r.ruleId === undefined), { message: 'exactly one of mediaFileId or ruleId is required' });
export type TranscodeRunRequest = z.infer<typeof TranscodeRunRequest>;

export const TranscodeRunResult = z.object({ queued: z.number().int(), jobs: z.array(TranscodeJob) });
export type TranscodeRunResult = z.infer<typeof TranscodeRunResult>;

/**
 * One backend's capability test: a 1-frame lavfi encode through the backend's real init args
 * and H.264 encoder (the same flags a job uses).
 */
export const TranscodeBackendStatus = z.object({
  backend: TranscodeHwaccel,
  available: z.boolean(),
  /** ffmpeg's line saying why the test failed (device/driver errors); null when available. */
  reason: z.string().nullable(),
});
export type TranscodeBackendStatus = z.infer<typeof TranscodeBackendStatus>;

export const TranscodeHwaccelResponse = z.object({
  /** Resolved ffmpeg binary; null when ffmpeg was not found. */
  ffmpegPath: z.string().nullable(),
  /** Raw `ffmpeg -hwaccels` list (`vaapi`, `cuda`, `qsv`, `videotoolbox` ...): what the build has, not what works. */
  methods: z.array(z.string()),
  /** The rule `hwaccel` backends whose capability test passed (`none` is always listed when ffmpeg exists). */
  backends: z.array(TranscodeHwaccel),
  /** Every backend with its test result, in `TranscodeHwaccel` order. Empty when ffmpeg is missing. */
  results: z.array(TranscodeBackendStatus),
  /** When the cached results were measured (GET ?refresh=true tests again); null without ffmpeg. */
  testedAt: z.string().nullable(),
});
export type TranscodeHwaccelResponse = z.infer<typeof TranscodeHwaccelResponse>;

export const TranscodeHwaccelQuery = z.object({
  /** Run the capability tests again instead of returning the cached results. */
  refresh: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
});
export type TranscodeHwaccelQuery = z.infer<typeof TranscodeHwaccelQuery>;

/**
 * `transcode` settings section (GET/PUT /settings/transcode). `fallbackToSoftware`: a job whose
 * hardware backend fails to initialise (no GPU passed through, no access to it, missing driver)
 * is retried once with software encoding instead of failing.
 */
export const TranscodeSettings = z.object({
  fallbackToSoftware: z.boolean().default(true),
});
export type TranscodeSettings = z.infer<typeof TranscodeSettings>;
export type TranscodeSettingsInput = z.input<typeof TranscodeSettings>;

export const TranscodeErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type TranscodeErrorResponse = z.infer<typeof TranscodeErrorResponse>;
