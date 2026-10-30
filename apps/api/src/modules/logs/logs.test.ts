import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogRecord } from '@arclight/shared';
import {
  createLogger,
  getLogRegistry,
  isLogFileName,
  listLogFiles,
  LogBuffer,
  RotatingFileStream,
  setLogRegistry,
} from '../../logging.js';
import { logsRoutes } from './routes.js';
import { LogsService } from './service.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-logs-'));
});
afterEach(() => {
  setLogRegistry(null);
  rmSync(dir, { recursive: true, force: true });
});

const line = (o: Record<string, unknown>) => `${JSON.stringify({ time: Date.UTC(2026, 0, 1), level: 30, ...o })}\n`;

function fill(buffer: LogBuffer, n: number, extra: (i: number) => Record<string, unknown> = () => ({})) {
  for (let i = 1; i <= n; i++) buffer.write(line({ msg: `message ${i}`, ...extra(i) }));
}

describe('LogBuffer', () => {
  it('normalises pino lines into records', () => {
    const buffer = new LogBuffer(10);
    buffer.write(line({ level: 50, msg: 'boom', component: 'scheduler', pid: 1, hostname: 'h', jobId: 7 }));
    const [r] = buffer.newestFirst();
    expect(r).toEqual({
      id: 1,
      time: '2026-01-01T00:00:00.000Z',
      level: 'error',
      message: 'boom',
      component: 'scheduler',
      context: { jobId: 7 },
    });
  });

  it('keeps only the most recent records once full', () => {
    const buffer = new LogBuffer(5);
    fill(buffer, 12);
    expect(buffer.size).toBe(5);
    expect(buffer.newestFirst().map((r) => r.message)).toEqual(['message 12', 'message 11', 'message 10', 'message 9', 'message 8']);
  });

  it('pages newest first', () => {
    const buffer = new LogBuffer(100);
    fill(buffer, 25);
    const p1 = buffer.query({ page: 1, pageSize: 10 });
    const p3 = buffer.query({ page: 3, pageSize: 10 });
    expect(p1.totalRecords).toBe(25);
    expect(p1.records[0]?.message).toBe('message 25');
    expect(p3.records.map((r) => r.message)).toEqual(['message 5', 'message 4', 'message 3', 'message 2', 'message 1']);
  });

  it('filters by minimum level', () => {
    const buffer = new LogBuffer(100);
    const levels = [20, 30, 40, 50, 60];
    fill(buffer, 5, (i) => ({ level: levels[i - 1] }));
    expect(buffer.query({ level: 'warn' }).records.map((r) => r.level)).toEqual(['fatal', 'error', 'warn']);
    expect(buffer.query({ level: 'debug' }).totalRecords).toBe(5);
  });

  it('searches message, component and context case-insensitively', () => {
    const buffer = new LogBuffer(100);
    buffer.write(line({ msg: 'Release grabbed' }));
    buffer.write(line({ msg: 'tick', component: 'Scheduler' }));
    buffer.write(line({ msg: 'request', url: '/api/v1/Series' }));
    expect(buffer.query({ search: 'GRAB' }).records.map((r) => r.message)).toEqual(['Release grabbed']);
    expect(buffer.query({ search: 'scheduler' }).records.map((r) => r.message)).toEqual(['tick']);
    expect(buffer.query({ search: 'series' }).records.map((r) => r.message)).toEqual(['request']);
    expect(buffer.query({ search: 'series', level: 'error' }).totalRecords).toBe(0);
  });

  it('search follows the list-search rule (every word, separators as spaces); q is an alias', () => {
    const buffer = new LogBuffer(100);
    buffer.write(line({ msg: 'Release grabbed: The.Office.S01E01', component: 'Releases' }));
    buffer.write(line({ msg: 'tick', component: 'Scheduler', level: 40 }));
    buffer.write(line({ msg: 'web_dl import done' }));
    const messages = (q: Parameters<LogBuffer['query']>[0]) => buffer.query(q).records.map((r) => r.message);
    expect(messages({ search: 'the office grabbed' })).toEqual(['Release grabbed: The.Office.S01E01']);
    expect(messages({ q: 'office releases' })).toEqual(['Release grabbed: The.Office.S01E01']); // message + component
    expect(messages({ q: 'web-dl' })).toEqual(['web_dl import done']);
    expect(messages({ q: 'warn scheduler' })).toEqual(['tick']); // level text
    expect(messages({ q: 'office scheduler' })).toEqual([]);
    expect(messages({ search: 'office', q: 'tick' })).toEqual([]); // both given: all words must match
    expect(buffer.query({ q: ' ' }).totalRecords).toBe(3);
  });

  it('clears and notifies subscribers of new records', () => {
    const buffer = new LogBuffer(10);
    fill(buffer, 3);
    buffer.clear();
    expect(buffer.query().totalRecords).toBe(0);
    const seen: LogRecord[] = [];
    const off = buffer.subscribe((r) => seen.push(r));
    buffer.write(line({ msg: 'a' }) + line({ msg: 'b' }));
    off();
    buffer.write(line({ msg: 'c' }));
    expect(seen.map((r) => r.message)).toEqual(['a', 'b']);
    expect(buffer.newestFirst()[0]?.id).toBeGreaterThan(seen[1]!.id);
  });
});

describe('RotatingFileStream', () => {
  it('rotates before a write would exceed the size limit', () => {
    const files = new RotatingFileStream({ dir, maxBytes: 20, keep: 5 });
    files.write('0123456789\n'); // 11 bytes
    files.write('abcdefghi\n'); // 10 bytes -> would be 21, rotate first
    files.close();
    expect(readFileSync(join(dir, 'arclight.log'), 'utf8')).toBe('abcdefghi\n');
    expect(readFileSync(join(dir, 'arclight.log.1'), 'utf8')).toBe('0123456789\n');
  });

  it('keeps at most `keep` rotated files, newest as .1', () => {
    const files = new RotatingFileStream({ dir, maxBytes: 5, keep: 3 });
    for (let i = 1; i <= 6; i++) files.write(`line${i}\n`); // every write rotates
    files.close();
    expect(listLogFiles(dir).map((f) => f.name)).toEqual(['arclight.log', 'arclight.log.1', 'arclight.log.2', 'arclight.log.3']);
    expect(readFileSync(join(dir, 'arclight.log'), 'utf8')).toBe('line6\n');
    expect(readFileSync(join(dir, 'arclight.log.1'), 'utf8')).toBe('line5\n');
    expect(readFileSync(join(dir, 'arclight.log.3'), 'utf8')).toBe('line3\n');
    expect(existsSync(join(dir, 'arclight.log.4'))).toBe(false);
  });

  it('appends to an existing file and counts its size', () => {
    writeFileSync(join(dir, 'arclight.log'), 'x'.repeat(15));
    const files = new RotatingFileStream({ dir, maxBytes: 20, keep: 2 });
    expect(files.size).toBe(15);
    files.write('yyyyyy');
    files.close();
    expect(readFileSync(join(dir, 'arclight.log.1'), 'utf8')).toBe('x'.repeat(15));
  });

  it('recognises only the log file and its numbered rotations', () => {
    expect(isLogFileName('arclight.log')).toBe(true);
    expect(isLogFileName('arclight.log.12')).toBe(true);
    expect(isLogFileName('arclight.log.bak')).toBe(false);
    expect(isLogFileName('../arclight.log')).toBe(false);
    expect(isLogFileName('arclight.db')).toBe(false);
  });
});

describe('createLogger', () => {
  it('writes to the buffer and the file and registers both', () => {
    const { log, buffer, files } = createLogger({ logDir: dir, logLevel: 'info' }, { stdout: null });
    log.child({ component: 'test' }).warn({ answer: 42 }, 'hello');
    log.debug('hidden by level');
    files.close();
    expect(buffer.newestFirst()).toMatchObject([{ level: 'warn', message: 'hello', component: 'test', context: { answer: 42 } }]);
    expect(readFileSync(join(dir, 'arclight.log'), 'utf8')).toContain('"msg":"hello"');
    expect(getLogRegistry()?.buffer).toBe(buffer);
  });
});

describe('log routes', () => {
  async function app() {
    const buffer = new LogBuffer(100);
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await a.register(websocket);
    await a.register(logsRoutes(new LogsService({ buffer, logDir: dir, fileName: 'arclight.log' })), { prefix: '/api/v1' });
    await a.ready();
    return { a, buffer };
  }

  it('pages and filters the buffer, then clears it', async () => {
    const { a, buffer } = await app();
    fill(buffer, 30, (i) => ({ level: i % 3 === 0 ? 50 : 30 }));
    const res = await a.inject({ method: 'GET', url: '/api/v1/log?page=2&pageSize=4&level=error' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRecords).toBe(10);
    expect(body.records.map((r: LogRecord) => r.message)).toEqual(['message 18', 'message 15', 'message 12', 'message 9']);
    expect((await a.inject({ method: 'GET', url: '/api/v1/log?level=loud' })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/v1/log?q=message.18' })).json().records.map((r: LogRecord) => r.message)).toEqual(['message 18']);
    expect((await a.inject({ method: 'GET', url: '/api/v1/log?search=message%2018&level=error' })).json().totalRecords).toBe(1);
    expect((await a.inject({ method: 'GET', url: `/api/v1/log?q=${'x'.repeat(201)}` })).statusCode).toBe(400);
    expect((await a.inject({ method: 'DELETE', url: '/api/v1/log' })).statusCode).toBe(204);
    expect((await a.inject({ method: 'GET', url: '/api/v1/log' })).json().totalRecords).toBe(0);
    await a.close();
  });

  it('lists and downloads log files, refusing other names', async () => {
    writeFileSync(join(dir, 'arclight.log'), 'current\n');
    writeFileSync(join(dir, 'arclight.log.1'), 'older\n');
    writeFileSync(join(dir, 'secrets.txt'), 'nope');
    const { a } = await app();
    const list = await a.inject({ method: 'GET', url: '/api/v1/log/file' });
    expect(list.json().map((f: { name: string }) => f.name)).toEqual(['arclight.log', 'arclight.log.1']);
    expect(list.json()[0].sizeBytes).toBe(8);
    const dl = await a.inject({ method: 'GET', url: '/api/v1/log/file/arclight.log.1' });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('older\n');
    expect(dl.headers['content-disposition']).toContain('arclight.log.1');
    expect((await a.inject({ method: 'GET', url: '/api/v1/log/file/secrets.txt' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: `/api/v1/log/file/${encodeURIComponent('../arclight.log')}` })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/v1/log/file/arclight.log.9' })).statusCode).toBe(404);
    await a.close();
  });

  it('streams new records over the websocket', async () => {
    const { a, buffer } = await app();
    const ws = await a.injectWS('/api/v1/log/stream');
    const got = new Promise<LogRecord>((resolve) => ws.once('message', (data: Buffer) => resolve(JSON.parse(data.toString()) as LogRecord)));
    buffer.write(line({ msg: 'live one', level: 40 }));
    await expect(got).resolves.toMatchObject({ message: 'live one', level: 'warn' });
    ws.terminate();
    await a.close();
  });
});
