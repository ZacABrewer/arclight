import type { BulkAction, BulkId, BulkResource } from '@arclight/shared';

/**
 * One call to a single-item route, made with the caller's credentials. `json` is the parsed
 * body (undefined when empty or not JSON).
 */
export interface RouteResponse {
  statusCode: number;
  json: unknown;
}
export type RouteCall = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => Promise<RouteResponse>;

export interface HandlerInput {
  call: RouteCall;
  /** addTags / removeTags. */
  tags: readonly number[];
}

/** Runs one action on one id; throws BulkItemError (or any Error) when it did not work. */
export type BulkHandler = (id: BulkId, input: HandlerInput) => Promise<void>;

export class BulkItemError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BulkItemError';
  }
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

/** The route's own error message and code, or the HTTP status. */
function failure(res: RouteResponse): BulkItemError {
  const body = asRecord(res.json);
  const nested = asRecord(body['error']);
  const message =
    (typeof body['error'] === 'string' && body['error']) ||
    (typeof nested['message'] === 'string' && nested['message']) ||
    (typeof body['message'] === 'string' && body['message']) ||
    `HTTP ${res.statusCode}`;
  const code = (typeof body['code'] === 'string' && body['code']) || (typeof nested['code'] === 'string' && nested['code']) || undefined;
  return new BulkItemError(message, code);
}

async function expectOk(res: Promise<RouteResponse>): Promise<RouteResponse> {
  const r = await res;
  if (r.statusCode >= 400) throw failure(r);
  return r;
}

const seg = (id: BulkId) => encodeURIComponent(String(id));

/** DELETE base/:id. */
const remove =
  (base: string): BulkHandler =>
  async (id, { call }) => {
    await expectOk(call('DELETE', `${base}/${seg(id)}`));
  };

/** POST path(id) with no body. */
const post =
  (path: (id: string) => string, payload?: (id: BulkId) => unknown): BulkHandler =>
  async (id, { call }) => {
    await expectOk(call('POST', path(seg(id)), payload?.(id)));
  };

/** GET base/:id, change it, PUT it back (routes whose PUT takes the whole resource). */
const readModifyWrite =
  (base: string, change: (row: Json, input: HandlerInput) => Json): BulkHandler =>
  async (id, input) => {
    const row = asRecord((await expectOk(input.call('GET', `${base}/${seg(id)}`))).json);
    await expectOk(input.call('PUT', `${base}/${seg(id)}`, change(row, input)));
  };

const setFields = (fields: readonly string[], value: boolean) => (row: Json) => ({ ...row, ...Object.fromEntries(fields.map((f) => [f, value])) });

function tagList(row: Json): number[] {
  const tags = row['tags'];
  return Array.isArray(tags) ? tags.filter((t): t is number => typeof t === 'number') : [];
}
const addTags = (row: Json, { tags }: HandlerInput) => ({ ...row, tags: [...new Set([...tagList(row), ...tags])] });
const removeTags = (row: Json, { tags }: HandlerInput) => ({ ...row, tags: tagList(row).filter((t) => !tags.includes(t)) });

/**
 * GET base/:id, then POST base/test with it (the saved row's secrets are reused server-side,
 * exactly as the editor's Test button does). A test that ran but answered `ok: false` fails.
 */
const testSaved =
  (base: string): BulkHandler =>
  async (id, { call }) => {
    const row = asRecord((await expectOk(call('GET', `${base}/${seg(id)}`))).json);
    checkTest(await expectOk(call('POST', `${base}/test`, row)));
  };

/** POST path(id) for routes that test a saved row by id. */
const testById =
  (path: (id: string) => string): BulkHandler =>
  async (id, { call }) => {
    checkTest(await expectOk(call('POST', path(seg(id)))));
  };

function checkTest(res: RouteResponse): void {
  const body = asRecord(res.json);
  if (body['ok'] === false || body['isValid'] === false) {
    const nested = asRecord(body['error']);
    const message =
      (typeof nested['message'] === 'string' && nested['message']) ||
      (typeof body['message'] === 'string' && body['message']) ||
      (Array.isArray(body['errors']) && typeof body['errors'][0] === 'string' && body['errors'][0]) ||
      'test failed';
    const code = (typeof nested['code'] === 'string' && nested['code']) || (typeof body['code'] === 'string' && body['code']) || 'TEST_FAILED';
    throw new BulkItemError(message, code);
  }
}

/** Pending releases have no single-item GET: find it in the list, then grab it like the row's button. */
const grabPending: BulkHandler = async (id, { call }) => {
  const list = (await expectOk(call('GET', '/release/pending'))).json;
  const row = Array.isArray(list) ? list.map(asRecord).find((p) => p['id'] === id) : undefined;
  if (!row) throw new BulkItemError('pending release not found', 'NOT_FOUND');
  const pick = (k: string) => (row[k] === undefined || (Array.isArray(row[k]) && (row[k] as unknown[]).length === 0) ? {} : { [k]: row[k] });
  await expectOk(
    call('POST', '/release', {
      guid: row['guid'],
      indexerId: row['indexerId'],
      ...pick('seriesId'),
      ...pick('episodeIds'),
      ...pick('movieId'),
      ...pick('artistId'),
      ...pick('albumIds'),
      ...pick('authorId'),
      ...pick('bookIds'),
    }),
  );
};

/**
 * POST /jobs/run answers when the job has finished, which can take minutes: check the name
 * against the scheduled jobs, then start it without waiting (progress arrives as job events).
 */
const runJob: BulkHandler = async (id, { call }) => {
  const list = (await expectOk(call('GET', '/jobs/scheduled'))).json;
  const known = Array.isArray(list) && list.map(asRecord).some((j) => j['name'] === id);
  if (!known) throw new BulkItemError(`unknown job: ${String(id)}`, 'NOT_FOUND');
  void call('POST', '/jobs/run', { name: String(id) }).catch(() => undefined);
};

const INDEXER_FLAGS = ['enableRss', 'enableAutomaticSearch', 'enableInteractiveSearch'] as const;
/** Indexer PUT is a partial update: send only what changes. */
const indexerFlags =
  (value: boolean): BulkHandler =>
  async (id, { call }) => {
    await expectOk(call('PUT', `/indexer/${seg(id)}`, Object.fromEntries(INDEXER_FLAGS.map((f) => [f, value]))));
  };
const indexerTags =
  (change: (row: Json, input: HandlerInput) => Json): BulkHandler =>
  async (id, input) => {
    const row = asRecord((await expectOk(input.call('GET', `/indexer/${seg(id)}`))).json);
    await expectOk(input.call('PUT', `/indexer/${seg(id)}`, { tags: change(row, input)['tags'] }));
  };

/** Handlers per resource; must cover BULK_ACTIONS exactly (checked by the tests). */
export const HANDLERS: { [R in BulkResource]: Partial<Record<BulkAction, BulkHandler>> } = {
  indexer: {
    enable: indexerFlags(true),
    disable: indexerFlags(false),
    // The indexer test takes a create body; the saved row's masked secrets are matched by the service.
    test: testSaved('/indexer'),
    delete: remove('/indexer'),
    addTags: indexerTags(addTags),
    removeTags: indexerTags(removeTags),
  },
  downloadclient: {
    enable: readModifyWrite('/downloadclient', setFields(['enable'], true)),
    disable: readModifyWrite('/downloadclient', setFields(['enable'], false)),
    test: testSaved('/downloadclient'),
    delete: remove('/downloadclient'),
    addTags: readModifyWrite('/downloadclient', addTags),
    removeTags: readModifyWrite('/downloadclient', removeTags),
  },
  notification: {
    enable: readModifyWrite('/notification', setFields(['enabled'], true)),
    disable: readModifyWrite('/notification', setFields(['enabled'], false)),
    test: testSaved('/notification'),
    delete: remove('/notification'),
    addTags: readModifyWrite('/notification', addTags),
    removeTags: readModifyWrite('/notification', removeTags),
  },
  importlist: {
    enable: readModifyWrite('/importlist', setFields(['enabled'], true)),
    disable: readModifyWrite('/importlist', setFields(['enabled'], false)),
    test: testSaved('/importlist'),
    delete: remove('/importlist'),
    addTags: readModifyWrite('/importlist', addTags),
    removeTags: readModifyWrite('/importlist', removeTags),
  },
  mediaserver: {
    enable: readModifyWrite('/mediaserver', setFields(['enabled'], true)),
    disable: readModifyWrite('/mediaserver', setFields(['enabled'], false)),
    test: testById((id) => `/mediaserver/${id}/test`),
    delete: remove('/mediaserver'),
  },
  customformat: { delete: remove('/customformat') },
  qualityprofile: { delete: remove('/qualityprofile') },
  delayprofile: { delete: remove('/delayprofile') },
  releaseprofile: {
    enable: readModifyWrite('/releaseprofile', setFields(['enabled'], true)),
    disable: readModifyWrite('/releaseprofile', setFields(['enabled'], false)),
    delete: remove('/releaseprofile'),
    addTags: readModifyWrite('/releaseprofile', addTags),
    removeTags: readModifyWrite('/releaseprofile', removeTags),
  },
  remotepathmapping: { delete: remove('/remotepathmapping') },
  user: { delete: remove('/user') },
  backup: { delete: remove('/system/backup') },
  // Job ids are job names.
  job: { run: runJob },
  transcodejob: { cancel: post((id) => `/transcode/jobs/${id}/cancel`) },
  history: { markFailed: post((id) => `/history/failed/${id}`), redownload: post((id) => `/history/${id}/redownload`) },
  pending: { grab: grabPending, delete: remove('/release/pending') },
};
