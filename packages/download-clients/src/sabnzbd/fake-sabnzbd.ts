/**
 * Test support: an in-memory SABnzbd API (`/api?mode=...`) on top of FakeHttpServer.
 * Enforces the API key (or legacy ma_username/ma_password) like SAB does: HTTP 200 with
 * `{"status": false, "error": "API Key Incorrect"}`. Not exported from the package entry point.
 */
import { FakeHttpServer, type FakeHttpHandler, type FakeHttpReply, type FakeRequest } from '../fake-http.js';

export interface FakeQueueSlot {
  nzo_id: string;
  filename: string;
  cat: string;
  mb: string;
  mbleft: string;
  percentage: string;
  status: string;
  timeleft: string;
  priority: string;
}

export interface FakeHistorySlot {
  nzo_id: string;
  name: string;
  category: string;
  bytes: number;
  status: string;
  fail_message: string;
  storage: string | null;
  path?: string;
}

export interface FakeConfig {
  misc: Record<string, unknown>;
  categories: Array<{ name: string; dir: string; [key: string]: unknown }>;
}

/** Param lookup across query string and form body, like CherryPy merges them. */
function param(request: FakeRequest, key: string): string | undefined {
  return request.query.get(key) ?? request.form[key];
}

export class FakeSabnzbd extends FakeHttpServer {
  apiKey = 'abc123apikey';
  /** Limited key: only addfile (and version) are allowed with it. */
  nzbKey = 'nzbkey456';
  /** Legacy web credentials accepted as ma_username/ma_password when set. */
  username = '';
  password = '';
  version = '4.3.3';
  queuePaused = false;
  queue: FakeQueueSlot[] = [];
  history: FakeHistorySlot[] = [];
  config: FakeConfig = {
    misc: { complete_dir: '/downloads/complete', download_dir: '/downloads/incomplete', history_retention: '' },
    categories: [
      { name: '*', dir: '' },
      { name: 'arclight', dir: 'arclight' },
    ],
  };
  /** NZB uploads received by mode=addfile. */
  readonly uploads: Array<{ filename: string; text: string; cat?: string; priority?: string; nzbname?: string }> = [];

  private nextId = 1;
  private readonly modeOverrides = new Map<string, FakeHttpHandler[]>();
  private readonly modeRoutes = new Map<string, FakeHttpHandler>();

  constructor() {
    super();
    const dispatch: FakeHttpHandler = (request) => this.dispatch(request);
    this.on('GET', '/api', dispatch);
    this.on('POST', '/api', dispatch);
    this.guard = (request) => this.checkAuth(request);
  }

  /** Replies once to the next call of `mode` (before auth checks have run). */
  onceMode(mode: string, handler: FakeHttpHandler | FakeHttpReply): this {
    const list = this.modeOverrides.get(mode) ?? [];
    list.push(typeof handler === 'function' ? handler : () => handler);
    this.modeOverrides.set(mode, list);
    return this;
  }

  /** Replaces the reply for every call of `mode`. */
  onMode(mode: string, handler: FakeHttpHandler | FakeHttpReply): this {
    this.modeRoutes.set(mode, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  modeCalls(mode: string, name?: string): FakeRequest[] {
    return this.requests.filter(
      (r) => param(r, 'mode') === mode && (name === undefined || param(r, 'name') === name),
    );
  }

  /** Loads a raw `mode=queue` response (e.g. a fixture). */
  loadQueue(raw: { queue: { paused?: boolean; slots: FakeQueueSlot[] } }): void {
    this.queuePaused = raw.queue.paused ?? false;
    this.queue = raw.queue.slots.map((s) => ({ ...s }));
  }

  loadHistory(raw: { history: { slots: FakeHistorySlot[] } }): void {
    this.history = raw.history.slots.map((s) => ({ ...s }));
  }

  loadConfig(raw: { config: FakeConfig }): void {
    this.config = structuredClone(raw.config);
  }

  private checkAuth(request: FakeRequest): FakeHttpReply | undefined {
    if (request.path !== '/api') return undefined;
    const mode = param(request, 'mode') ?? '';
    if (mode === 'version' || mode === 'auth') return undefined;
    const key = param(request, 'apikey');
    if (key === this.apiKey) return undefined;
    if (key === this.nzbKey && (mode === 'addfile' || mode === 'addurl')) return undefined;
    if (
      this.username !== '' &&
      param(request, 'ma_username') === this.username &&
      param(request, 'ma_password') === this.password
    ) {
      return undefined;
    }
    if (key === undefined || key === '') return { body: { status: false, error: 'API Key Required' } };
    return { body: { status: false, error: 'API Key Incorrect' } };
  }

  private dispatch(request: FakeRequest): FakeHttpReply | Promise<FakeHttpReply> {
    const mode = param(request, 'mode') ?? '';
    const override = this.modeOverrides.get(mode)?.shift() ?? this.modeRoutes.get(mode);
    if (override) return override(request);
    switch (mode) {
      case 'version':
        return { body: { version: this.version } };
      case 'get_config':
        return { body: { config: this.config } };
      case 'queue':
        return this.handleQueue(request);
      case 'history':
        return this.handleHistory(request);
      case 'addfile':
        return this.handleAddFile(request);
      case 'change_cat': {
        const id = param(request, 'value') ?? '';
        const slot = this.queue.find((s) => s.nzo_id === id);
        if (slot) slot.cat = param(request, 'value2') ?? '*';
        return { body: { status: true } };
      }
      default:
        return { body: 'error: not implemented\n' };
    }
  }

  private handleQueue(request: FakeRequest): FakeHttpReply {
    const name = param(request, 'name');
    const ids = (param(request, 'value') ?? '').split(',').filter((v) => v !== '');
    if (name === 'delete') {
      const removed = this.queue.filter((s) => ids.includes(s.nzo_id)).map((s) => s.nzo_id);
      this.queue = this.queue.filter((s) => !ids.includes(s.nzo_id));
      return { body: { status: true, nzo_ids: removed } };
    }
    if (name === 'pause' || name === 'resume') {
      const hits = this.queue.filter((s) => ids.includes(s.nzo_id));
      for (const slot of hits) slot.status = name === 'pause' ? 'Paused' : 'Queued';
      return { body: { status: true, nzo_ids: hits.map((s) => s.nzo_id) } };
    }
    return {
      body: {
        queue: {
          version: this.version,
          paused: this.queuePaused,
          status: this.queuePaused ? 'Paused' : 'Downloading',
          noofslots: this.queue.length,
          slots: this.queue.map((s, index) => ({ index, ...s })),
        },
      },
    };
  }

  private handleHistory(request: FakeRequest): FakeHttpReply {
    if (param(request, 'name') === 'delete') {
      const ids = (param(request, 'value') ?? '').split(',');
      this.history = this.history.filter((s) => !ids.includes(s.nzo_id));
      return { body: { status: true } };
    }
    const category = param(request, 'category');
    const limit = Number(param(request, 'limit') ?? '0');
    let slots = category === undefined ? this.history : this.history.filter((s) => s.category === category);
    if (limit > 0) slots = slots.slice(0, limit);
    return { body: { history: { noofslots: slots.length, slots } } };
  }

  private handleAddFile(request: FakeRequest): FakeHttpReply {
    const file = request.files.find((f) => f.field === 'name' || f.field === 'nzbfile');
    if (!file) return { body: { status: false, error: 'No file given' } };
    const text = new TextDecoder().decode(file.bytes);
    const upload: FakeSabnzbd['uploads'][number] = { filename: file.filename, text };
    const cat = param(request, 'cat');
    const priority = param(request, 'priority');
    const nzbname = param(request, 'nzbname');
    if (cat !== undefined) upload.cat = cat;
    if (priority !== undefined) upload.priority = priority;
    if (nzbname !== undefined) upload.nzbname = nzbname;
    this.uploads.push(upload);
    if (!text.includes('<nzb')) return { body: { status: false, nzo_ids: [] } };
    const id = `SABnzbd_nzo_fake${this.nextId++}`;
    this.queue.push({
      nzo_id: id,
      filename: nzbname ?? file.filename,
      cat: cat ?? '*',
      mb: '0.00',
      mbleft: '0.00',
      percentage: '0',
      status: priority === '-2' ? 'Paused' : 'Grabbing',
      timeleft: '0:00:00',
      priority: 'Normal',
    });
    return { body: { status: true, nzo_ids: [id] } };
  }
}
