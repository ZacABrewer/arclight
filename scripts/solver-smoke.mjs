// Manual smoke test for @arclight/challenge-solver: launches a REAL local browser (Edge,
// Chrome, Brave or Chromium) headless, solves one URL and prints the result. Never run by
// `pnpm test`; opt in explicitly:
//
//   ARCLIGHT_SOLVER_SMOKE=1 pnpm --filter @arclight/challenge-solver smoke [url]
//   (PowerShell: $env:ARCLIGHT_SOLVER_SMOKE=1; pnpm --filter @arclight/challenge-solver smoke)
//
// Optional: ARCLIGHT_SOLVER_BROWSER=<path to browser exe>, ARCLIGHT_SOLVER_HEADFUL=1 to show
// the window (useful to pass a Turnstile challenge by hand in the same profile).
// The profile lives in <os tmp>/arclight-solver-smoke and is kept between runs.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChallengeSolver, findBrowser } from '../packages/challenge-solver/src/index.ts';

if (process.env.ARCLIGHT_SOLVER_SMOKE !== '1') {
  console.error('Refusing to launch a browser: set ARCLIGHT_SOLVER_SMOKE=1 to run this smoke test.');
  process.exit(2);
}

const url = process.argv[2] ?? 'https://example.com/';
const browser = findBrowser({ configuredPath: process.env.ARCLIGHT_SOLVER_BROWSER });
if (!browser) {
  console.error('No Chromium-family browser found. Set ARCLIGHT_SOLVER_BROWSER to its executable.');
  process.exit(1);
}
console.log(`browser: ${browser.name} ${browser.path}`);

const solver = new ChallengeSolver({
  executablePath: browser.path,
  userDataDir: path.join(tmpdir(), 'arclight-solver-smoke'),
  timeoutMs: 60_000,
  idleCloseMs: 0,
  headless: process.env.ARCLIGHT_SOLVER_HEADFUL !== '1',
  log: (level, message) => console.log(`[${level}] ${message}`),
});

const started = Date.now();
try {
  const res = await solver.solve({ method: 'GET', url });
  console.log(`status:     ${res.status} (${Date.now() - started} ms, challenged: ${res.challenged})`);
  console.log(`final url:  ${res.url}`);
  console.log(`user agent: ${res.userAgent}`);
  console.log(`cookies:    ${res.cookies.map((c) => c.name).join(', ') || '(none)'}`);
  console.log(`cf_clearance: ${res.cookies.some((c) => c.name === 'cf_clearance') ? 'yes' : 'no'}`);
  console.log(`html:       ${res.html.length} chars, title ${/<title[^>]*>([^<]*)<\/title>/i.exec(res.html)?.[1] ?? '(none)'}`);
  process.exitCode = 0;
} catch (err) {
  console.error(`FAILED: ${err instanceof Error ? `${err.name} ${err.code ?? ''} ${err.message}` : String(err)}`);
  process.exitCode = 1;
} finally {
  await solver.close();
}
