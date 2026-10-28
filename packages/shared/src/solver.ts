import { z } from 'zod';

// Built-in Cloudflare challenge solver (docs/CLOUDFLARE.md): settings section `solver`, the
// status route and the proxy auto-detection result.

export const SolverSettings = z.object({
  enabled: z.boolean().default(true).describe('Use a locally installed Edge/Chrome/Brave/Chromium to solve browser challenges.'),
  browserPath: z
    .string()
    .trim()
    .optional()
    .describe('Browser executable; empty = auto-detect (Edge, Chrome, Brave, Chromium in that order).'),
  timeoutSeconds: z.number().int().min(5).max(300).default(60).describe('Give up on a challenge after this many seconds.'),
  idleCloseSeconds: z.number().int().min(0).max(86_400).default(300).describe('Close the browser after this long without work (0 = keep it open).'),
});
export type SolverSettings = z.infer<typeof SolverSettings>;

/** PUT /settings/solver: any subset; omitted keys keep their stored value. */
export const SolverSettingsUpdate = SolverSettings.partial();
export type SolverSettingsUpdate = z.infer<typeof SolverSettingsUpdate>;

export const SolverStatus = z.object({
  enabled: z.boolean(),
  /** The browser that would be (or is) used; null when none was found. */
  browser: z.object({ name: z.string(), path: z.string() }).nullable(),
  /** A browser process is running right now. */
  running: z.boolean(),
  /** Requests queued or in progress. */
  pending: z.number().int().min(0),
  /** Profile directory the solver browser uses (`<config>/solver-profile`). */
  profileDir: z.string(),
  /** Id of the "Built-in solver" indexer proxy, when registered. */
  proxyId: z.number().int().nullable(),
  /** FlareSolverr proxies other than the built-in one (e.g. the bundled container): they solve with their own browser. */
  externalSolvers: z.array(z.object({ id: z.number().int(), name: z.string() })).default([]),
  /** Arclight runs in a container, where the image ships no browser. */
  docker: z.boolean().default(false),
});
export type SolverStatus = z.infer<typeof SolverStatus>;

export const ProxyAutoDetectResult = z.object({
  /** Id of the "FlareSolverr (bundled)" proxy when this run created it. */
  bundledCreated: z.number().int().nullable(),
  /** Id of the "Built-in solver" proxy after this run (created, updated or unchanged), else null. */
  builtinProxyId: z.number().int().nullable(),
  messages: z.array(z.string()),
});
export type ProxyAutoDetectResult = z.infer<typeof ProxyAutoDetectResult>;
