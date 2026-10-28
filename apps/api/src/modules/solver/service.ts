import { join } from 'node:path';
import {
  ChallengeSolver,
  findBrowser,
  handleFlareSolverrCommand,
  type BrowserCandidate,
  type ChallengeSolverOptions,
  type FlareSolverrHttpResult,
} from '@arclight/challenge-solver';
import { SolverSettings, type SolverSettingsUpdate, type SolverStatus } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { getSection, setSection } from '../settings/service.js';

// The built-in challenge solver for native runs: owns the `solver` settings section, finds a
// local Chromium-family browser and serves the FlareSolverr /v1 contract on top of one
// ChallengeSolver instance (rebuilt when the browser path or timeouts change).

export interface SolverServiceOptions {
  db: Db;
  configDir: string;
  log?: Logger;
  /** Test seam: locate a browser (default: well-known install paths). */
  findBrowser?: (configuredPath: string | undefined) => BrowserCandidate | null;
  /** Test seam: build the solver (default: a real ChallengeSolver). */
  createSolver?: (opts: ChallengeSolverOptions) => ChallengeSolver;
}

export class SolverService {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly find: (configuredPath: string | undefined) => BrowserCandidate | null;
  private readonly create: (opts: ChallengeSolverOptions) => ChallengeSolver;
  readonly profileDir: string;
  private current: { key: string; solver: ChallengeSolver } | undefined;

  constructor(opts: SolverServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.profileDir = join(opts.configDir, 'solver-profile');
    this.find = opts.findBrowser ?? ((configuredPath) => findBrowser({ configuredPath }));
    this.create = opts.createSolver ?? ((o) => new ChallengeSolver(o));
  }

  settings(): SolverSettings {
    return getSection(this.db, 'solver');
  }

  updateSettings(patch: SolverSettingsUpdate): SolverSettings {
    const next = SolverSettings.parse({ ...this.settings(), ...patch });
    if (next.browserPath === '') delete next.browserPath;
    return setSection(this.db, 'solver', next);
  }

  browser(): BrowserCandidate | null {
    return this.find(this.settings().browserPath || undefined);
  }

  /** Enabled and a browser is installed: the "Built-in solver" proxy should exist. */
  available(): boolean {
    return this.settings().enabled && this.browser() !== null;
  }

  status(proxyId: number | null): Omit<SolverStatus, 'externalSolvers' | 'docker'> {
    const s = this.settings();
    const solver = this.current?.solver;
    return {
      enabled: s.enabled,
      browser: this.browser(),
      running: solver?.running ?? false,
      pending: solver?.pending ?? 0,
      profileDir: this.profileDir,
      proxyId,
    };
  }

  /** One FlareSolverr command (POST /solver/v1). Never throws. */
  async handle(body: unknown): Promise<FlareSolverrHttpResult> {
    const s = this.settings();
    const fail = (message: string): FlareSolverrHttpResult => {
      const now = Date.now();
      return { httpStatus: 500, body: { status: 'error', message: `Error: ${message}`, startTimestamp: now, endTimestamp: now, version: 'arclight' } };
    };
    if (!s.enabled) return fail('The built-in solver is disabled (Settings -> Indexers -> Challenge solver).');
    const browser = this.browser();
    if (!browser) {
      return fail(
        s.browserPath
          ? `No browser at ${s.browserPath}.`
          : 'No Chromium-family browser (Edge, Chrome, Brave, Chromium) was found; install one or set solver.browserPath.',
      );
    }
    const solver = await this.solverFor(browser, s);
    return handleFlareSolverrCommand(solver, body, { warn: (m) => this.log?.warn(m) });
  }

  async shutdown(): Promise<void> {
    const c = this.current;
    this.current = undefined;
    await c?.solver.close();
  }

  private async solverFor(browser: BrowserCandidate, s: SolverSettings): Promise<ChallengeSolver> {
    const key = JSON.stringify([browser.path, s.timeoutSeconds, s.idleCloseSeconds]);
    if (this.current?.key === key) return this.current.solver;
    const previous = this.current;
    const log = this.log;
    const solver = this.create({
      executablePath: browser.path,
      userDataDir: this.profileDir,
      timeoutMs: s.timeoutSeconds * 1000,
      idleCloseMs: s.idleCloseSeconds * 1000,
      ...(log ? { log: (level, message) => log[level](message) } : {}),
    });
    this.current = { key, solver };
    if (previous) await previous.solver.close().catch(() => undefined);
    return solver;
  }
}
