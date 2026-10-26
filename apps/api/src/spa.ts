import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './app.js';
import { injectPortalDocument, spaDecision } from './modules/requests/index.js';
import { getSection } from './modules/settings/service.js';

// Serves the built web app: static files from web/dist, and index.html for every other page
// load (the SPA fallback). Page loads also learn where the request portal answers: portal
// paths (/portal, /watch, ...) on any hostname and the root of portal hostnames, written
// into index.html for the web router (modules/requests/portal-routing.ts). Portal-only
// hostnames send admin pages back to the portal.
//
// The hostname comes from Host, or X-Forwarded-Host behind a proxy: the server always trusts
// forwarded headers (docs/getting-started/exposing-outside-home.md).

export async function registerSpa(app: FastifyInstance, ctx: AppContext, webDist: string): Promise<void> {
  // index.html is left out of the static routes so every page load goes through the fallback.
  await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false, globIgnore: ['index.html'] });

  let template: Promise<string> | null = null;
  const indexHtml = (): Promise<string> => {
    template ??= readFile(path.join(webDist, 'index.html'), 'utf8').catch((err: unknown) => {
      template = null;
      throw err;
    });
    return template;
  };

  app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    const pathname = req.url.split('?')[0] ?? '/';
    const decision = spaDecision(getSection(ctx.db, 'requests').publicPortal, req.host, pathname);
    if (decision.kind === 'redirect') return reply.redirect(decision.location, 302);
    const html = injectPortalDocument(await indexHtml(), decision.portal);
    // The page differs per hostname and path; never let a shared cache mix them up.
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').header('vary', 'Host, X-Forwarded-Host').send(html);
  });
}
