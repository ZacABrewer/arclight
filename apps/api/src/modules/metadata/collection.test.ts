import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../db/test-utils.js';
import { metadataRoutes } from './routes.js';
import { MetadataService } from './service.js';

const DUNE = {
  id: 726871,
  name: 'Dune Collection',
  overview: 'Paul Atreides…',
  poster_path: '/p.jpg',
  backdrop_path: '/b.jpg',
  parts: [
    { id: 1170608, title: 'Dune: Part Three', release_date: '', overview: '', poster_path: null, original_language: 'en' },
    { id: 693134, title: 'Dune: Part Two', release_date: '2024-02-27', overview: 'Follow…', poster_path: '/two.jpg', original_language: 'en' },
    { id: 438631, title: 'Dune', release_date: '2021-09-15', overview: 'Paul…', poster_path: '/one.jpg', original_language: 'en' },
  ],
};

describe('GET /metadata/collection/:tmdbId', () => {
  it('maps the TMDB collection with its parts in release order', async () => {
    const db = await createTestDb();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return url.includes('/collection/726871') ? Response.json(DUNE) : new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const service = new MetadataService({ db, log: pino({ level: 'silent' }), env: { ARCLIGHT_TMDB_API_KEY: 'k' }, fetchImpl });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(metadataRoutes(service), { prefix: '/api/v1' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/collection/726871' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tmdbId: 726871, name: 'Dune Collection', images: { poster: 'https://image.tmdb.org/t/p/w500/p.jpg' } });
    expect(body.parts.map((p: { tmdbId: number }) => p.tmdbId)).toEqual([438631, 693134, 1170608]);
    expect(body.parts[0]).toMatchObject({ year: 2021, releaseDate: '2021-09-15', images: { poster: 'https://image.tmdb.org/t/p/w500/one.jpg' } });
    expect(urls[0]).toContain('api_key=k');

    expect((await app.inject({ method: 'GET', url: '/api/v1/metadata/collection/1' })).statusCode).toBe(404);
  });

  it('answers 400 NOT_CONFIGURED without a TMDB key', async () => {
    const db = await createTestDb();
    const service = new MetadataService({ db, log: pino({ level: 'silent' }), env: {} });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(metadataRoutes(service), { prefix: '/api/v1' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/collection/726871' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('NOT_CONFIGURED');
  });
});
