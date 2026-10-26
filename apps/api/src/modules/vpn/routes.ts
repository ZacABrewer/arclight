import { VpnErrorResponse, VpnSettingsResponse, VpnSettingsUpdate, VpnStatus } from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SettingsError } from '../settings/service.js';
import { VpnError, type VpnErrorCode } from './errors.js';
import type { VpnService } from './service.js';

// /api/v1/vpn/* and /api/v1/settings/vpn. Thin: validate -> service -> reply.

const STATUS_FOR: Record<VpnErrorCode, number> = {
  unauthorized: 502,
  unreachable: 502,
  timeout: 504,
  'bad-response': 502,
  'not-found': 502,
  'not-installed': 400,
  'tunnel-not-found': 409,
  'command-failed': 502,
  config: 400,
  unsupported: 400,
};

const errors = { 400: VpnErrorResponse, 409: VpnErrorResponse, 502: VpnErrorResponse, 504: VpnErrorResponse };

export function vpnRoutes(service: VpnService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof VpnError) return reply.code(STATUS_FOR[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled vpn error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/vpn/status', { schema: { response: { 200: VpnStatus } } }, async () => service.getStatus());

    app.post('/vpn/refresh', { schema: { response: { 200: VpnStatus } } }, async () => service.refresh());

    /** Probe a draft configuration (the form's "Test" button) without saving it. */
    app.post('/vpn/test', { schema: { body: VpnSettingsUpdate, response: { 200: VpnStatus, ...errors } } }, async (req) =>
      service.test(req.body),
    );

    /** wireguard-windows: install / remove the tunnel service. */
    app.post('/vpn/connect', { schema: { response: { 200: VpnStatus, ...errors } } }, async () => service.connect());
    app.post('/vpn/disconnect', { schema: { response: { 200: VpnStatus, ...errors } } }, async () => service.disconnect());

    app.get('/settings/vpn', { schema: { response: { 200: VpnSettingsResponse } } }, async () => service.maskedSettings());

    app.put(
      '/settings/vpn',
      { schema: { body: VpnSettingsUpdate, response: { 200: VpnSettingsResponse, ...errors } } },
      async (req) => service.updateSettings(req.body),
    );
  };
}
