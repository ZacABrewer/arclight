import { ProxyAutoDetectResult, SolverSettings, SolverStatus, type SolverSettingsUpdate } from '@arclight/shared';
import { z } from 'zod';
import { request } from './client.js';
import { t } from '../i18n/index.js';

// Paths mirror apps/api/src/modules/solver/routes.ts.

/** The FlareSolverr-shaped answer of POST /solver/v1 (only what the Test button shows). */
export const SolverTestResponse = z.looseObject({
  status: z.string(),
  message: z.string().optional(),
  solution: z.looseObject({ url: z.string().optional(), status: z.number().optional(), userAgent: z.string().optional() }).optional(),
});
export type SolverTestResponse = z.infer<typeof SolverTestResponse>;

export const solverApi = {
  status: () => request('/solver/status', SolverStatus),
  autodetect: () => request('/solver/autodetect', ProxyAutoDetectResult, { method: 'POST' }),
  settings: {
    get: () => request('/settings/solver', SolverSettings),
    update: (body: SolverSettingsUpdate) => request('/settings/solver', SolverSettings, { method: 'PUT', json: body }),
  },
  /** Solve one page through the built-in solver; resolves with the body and the elapsed ms. */
  async test(url = 'https://example.com/', maxTimeoutMs = 60_000): Promise<{ response: SolverTestResponse; elapsedMs: number }> {
    const started = performance.now();
    // The route answers 500 with a FlareSolverr error body when solving fails; read it either way.
    const res = await fetch('/api/v1/solver/v1', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: maxTimeoutMs }),
    });
    const elapsedMs = Math.round(performance.now() - started);
    const body: unknown = await res.json().catch(() => ({ status: 'error', message: `${res.status} ${res.statusText}` }));
    const parsed = SolverTestResponse.safeParse(body);
    return { response: parsed.success ? parsed.data : { status: 'error', message: t('api.solver.unexpectedAnswerStatus', { status: res.status }) }, elapsedMs };
  },
};
