import { z } from 'zod';
import { ARCLIGHT_GITHUB_SLUG } from './project.js';

// Update checks (System -> Updates): settings section `updates`, the cached result of the last
// check served by GET /system/update, and the per-version changelog panes. Versions come from
// the GitHub releases of `repo`; image tags follow docs/RELEASING.md (`vX.Y.Z`, `develop`).

export const UpdateChannel = z.enum(['stable', 'develop']);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

export const DEFAULT_UPDATE_REPO = ARCLIGHT_GITHUB_SLUG;

/** notify = report only; auto = pull and recreate labelled containers through the Docker socket. */
export const UpdateMode = z.enum(['notify', 'auto']);
export type UpdateMode = z.infer<typeof UpdateMode>;

/** Local hours [startHour, endHour) in which automatic container updates may run; wraps past midnight. */
export const UpdateWindow = z.object({
  startHour: z.number().int().min(0).max(23).default(3),
  endHour: z.number().int().min(0).max(23).default(6),
});
export type UpdateWindow = z.infer<typeof UpdateWindow>;

export const UpdateSettings = z.object({
  /** Check for new versions at all (GitHub API + GHCR, no other data leaves the server). */
  enabled: z.boolean().default(true),
  /** GitHub `owner/name`; the image is `ghcr.io/<owner/name>`. */
  repo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name')
    .default(DEFAULT_UPDATE_REPO),
  /** stable = tagged releases; develop = pre-releases too, image tag `develop`. */
  channel: UpdateChannel.default('stable'),
  checkIntervalHours: z.number().int().min(1).max(168).default(24),
  /** Raise the UpdateAvailable health warning when a newer version exists. */
  notifyOnUpdate: z.boolean().default(true),
  mode: UpdateMode.default('notify'),
  autoUpdateWindow: UpdateWindow.default({ startHour: 3, endHour: 6 }),
});
export type UpdateSettings = z.infer<typeof UpdateSettings>;

/** PUT /settings/updates: any subset; omitted keys keep their stored value. */
export const UpdateSettingsUpdate = UpdateSettings.partial();
export type UpdateSettingsUpdate = z.infer<typeof UpdateSettingsUpdate>;

/** One release (a changelog pane). */
export const UpdateRelease = z.object({
  /** Normalised version without the leading `v`, e.g. `0.2.0`. */
  version: z.string(),
  /** Git tag, e.g. `v0.2.0`. */
  tag: z.string(),
  name: z.string().optional(),
  publishedAt: z.string().optional(),
  /** Release notes (GitHub Markdown). */
  notes: z.string(),
  url: z.string().optional(),
  prerelease: z.boolean(),
  /** Container image tag that carries this release. */
  imageTag: z.string(),
});
export type UpdateRelease = z.infer<typeof UpdateRelease>;

/** GET /system/update and POST /system/update/check. */
export const UpdateInfo = z.object({
  currentVersion: z.string(),
  latestVersion: z.string().optional(),
  /** Notes of the latest version. */
  releaseNotes: z.string().optional(),
  /** Image tag to pull for the latest version (`vX.Y.Z`, or `develop` on that channel). */
  imageTag: z.string().optional(),
  /** Image reference without tag, e.g. `ghcr.io/zacheryabrewer/arclight`. */
  image: z.string().optional(),
  /** ISO-8601 of the last completed check; null = never checked. */
  checkedAt: z.string().nullable(),
  updateAvailable: z.boolean(),
  channel: UpdateChannel,
  repo: z.string(),
  enabled: z.boolean(),
  isDocker: z.boolean(),
  /** Releases newer than the running version (newest first; the latest few when up to date). */
  releases: z.array(UpdateRelease),
  /** Why the last check failed, if it did (the previous result is kept). */
  error: z.string().optional(),
});
export type UpdateInfo = z.infer<typeof UpdateInfo>;

// ---- container updates (Docker Engine API over /var/run/docker.sock) ----------------------

/** Containers opt in with this label (compose `labels: [arclight.autoupdate=true]`). */
export const AUTOUPDATE_LABEL = 'arclight.autoupdate';

export const ContainerUpdateItem = z.object({
  id: z.string(),
  name: z.string(),
  /** Image reference the container was created from, e.g. `qmcgaw/gluetun:latest`. */
  image: z.string(),
  /** This is the Arclight container itself. */
  isSelf: z.boolean(),
  /** Shares this container's network namespace (`network_mode: service:gluetun`). */
  networkParent: z.string().optional(),
  /**
   * The container's labels (Docker inspect `Config.Labels`). The api always sends it; optional so
   * caches written before it existed (and older clients' fixtures) still parse.
   */
  labels: z.record(z.string(), z.string()).optional(),
  currentDigest: z.string().optional(),
  latestDigest: z.string().optional(),
  updateAvailable: z.boolean(),
  checkedAt: z.string().optional(),
  error: z.string().optional(),
});
export type ContainerUpdateItem = z.infer<typeof ContainerUpdateItem>;

export const ContainerUpdateRun = z.object({
  at: z.string(),
  ok: z.boolean(),
  /** Container names recreated (dependents included). */
  updated: z.array(z.string()),
  message: z.string(),
  /** Arclight itself was involved: a helper container finishes the swap after this process stops. */
  handedOff: z.boolean(),
});
export type ContainerUpdateRun = z.infer<typeof ContainerUpdateRun>;

/** GET /system/update/containers. */
export const ContainerUpdatesInfo = z.object({
  /** The Docker socket is mounted and answers. */
  dockerAvailable: z.boolean(),
  socketPath: z.string(),
  /** Why container updates are unavailable ("notify only; update by pulling the image"). */
  reason: z.string().optional(),
  mode: UpdateMode,
  checkedAt: z.string().nullable(),
  containers: z.array(ContainerUpdateItem),
  lastRun: ContainerUpdateRun.optional(),
});
export type ContainerUpdatesInfo = z.infer<typeof ContainerUpdatesInfo>;
