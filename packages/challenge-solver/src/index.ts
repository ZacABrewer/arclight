/**
 * Built-in browser challenge solver: drives a locally installed Chromium-family browser
 * (Edge, Chrome, Brave, Chromium) over the DevTools protocol and exposes the FlareSolverr
 * `/v1` command contract on top of it. See docs/CLOUDFLARE.md.
 */
export { SolverError } from './errors.js';
export type { SolverErrorCode } from './errors.js';
export { SerialQueue } from './queue.js';
export { detectChallenge, CHALLENGE_TITLES, CHALLENGE_HTML_MARKERS } from './challenge.js';
export type { PageSnapshot, ChallengeVerdict, ChallengeKind } from './challenge.js';
export { findBrowser, browserCandidates } from './browser.js';
export type { BrowserCandidate, FindBrowserOptions } from './browser.js';
export { launchBrowser, browserArgs, parseDevToolsActivePort, parseDevToolsListening, DEFAULT_LAUNCH_TIMEOUT_MS } from './launch.js';
export type { LaunchOptions, LaunchedBrowser } from './launch.js';
export { CdpConnection, DEFAULT_CDP_TIMEOUT_MS } from './cdp.js';
export type { WebSocketLike, WebSocketFactory, CdpListener, CdpParams } from './cdp.js';
export {
  ChallengeSolver,
  normalizeUserAgent,
  toSolverCookie,
  DEFAULT_SOLVE_TIMEOUT_MS,
  DEFAULT_IDLE_CLOSE_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from './solver.js';
export type { ChallengeSolverOptions, SolveRequest, SolveResult, SolverCookie, SolverLogLevel } from './solver.js';
export { handleFlareSolverrCommand, SOLVER_API_VERSION } from './flaresolverr-api.js';
export type { FlareSolverrResponseBody, FlareSolverrSolutionBody, FlareSolverrHttpResult, HandleCommandOptions } from './flaresolverr-api.js';
