import type {
  MatchKey,
  ProviderCapabilities,
  ProviderContext,
  RateLimit,
  SubtitleCandidate,
  SubtitleFile,
  SubtitleQuery,
  SupportResult,
} from '../types.js';
import { BaseProvider } from './base.js';

// Napisy24: Polish subtitles by OpenSubtitles-style file hash. One POST returns a status
// block and, on a hit, the zip itself; download() replays the bytes held in the token.

const ENDPOINT = 'https://napisy24.pl/run/CheckSubAgent.php';

export interface Napisy24Config {
  username: string;
  password: string;
}

export interface Napisy24Status {
  status: string;
  fields: Record<string, string>;
}

/** Split a response at the first "||": the status block (latin1 text) and the binary rest. */
export function splitNapisy24Response(bytes: Uint8Array): { head: string; body: Uint8Array } {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x7c && bytes[i + 1] === 0x7c) {
      return { head: new TextDecoder('latin1').decode(bytes.subarray(0, i)), body: bytes.subarray(i + 2) };
    }
  }
  return { head: new TextDecoder('latin1').decode(bytes), body: new Uint8Array(0) };
}

/** "OK-2|imdb:133093|napisId:5" -> { status: 'OK-2', fields: { imdb: '133093', napisId: '5' } } */
export function parseNapisy24Status(head: string): Napisy24Status {
  const [status = '', ...rest] = head.trim().split('|');
  const fields: Record<string, string> = {};
  for (const part of rest) {
    const idx = part.indexOf(':');
    if (idx > 0) fields[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return { status: status.trim(), fields };
}

export class Napisy24Provider extends BaseProvider {
  readonly kind = 'napisy24' as const;
  readonly needsAuth = true;
  readonly rateLimit: RateLimit = { minIntervalMs: 1000, requestTimeoutMs: 15_000 };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['hash'],
    languages: new Set(['pl']),
    forced: false,
    hi: false,
    hashVerifiable: true,
    hiVerifiable: false,
    requiredHash: 'opensubtitles',
  };
  private readonly config: Napisy24Config;

  constructor(config: Napisy24Config, ctx?: ProviderContext) {
    super(ctx);
    if (!config.username?.trim() || !config.password) {
      throw this.error('config', 'username and password are required (no built-in fallback account)');
    }
    this.config = config;
  }

  override supports(query: SubtitleQuery): SupportResult {
    const base = super.supports(query);
    if (!base.ok) return base;
    if (!query.fileSize) return { ok: false, reason: 'napisy24 needs the file size' };
    return { ok: true };
  }

  private async check(hash: string, size: number, fileName: string): Promise<{ status: Napisy24Status; body: Uint8Array }> {
    const form = new URLSearchParams({
      postAction: 'CheckSub',
      ua: this.config.username,
      ap: this.config.password,
      fs: String(size),
      fh: hash,
      fn: fileName,
      n24pref: '1',
    });
    const res = await this.request(ENDPOINT, {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) throw this.statusError(res, 'CheckSub');
    const { head, body } = splitNapisy24Response(new Uint8Array(await res.arrayBuffer()));
    const status = parseNapisy24Status(head);
    if (/login error/i.test(head)) throw this.error('auth', 'login rejected');
    return { status, body };
  }

  async test(): Promise<void> {
    // A lookup for an impossible hash exercises credentials; OK-0/OK-1 means we are in.
    const { status } = await this.check('0000000000000000', 0, 'test.mkv');
    if (!/^OK-\d/.test(status.status)) throw this.error('bad-response', `unexpected status ${status.status}`);
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    if (!this.supports(query).ok) return [];
    const hash = query.hashes!.opensubtitles!;
    const fileName = (query.fileName ?? query.filePath ?? query.sceneName ?? 'video').split(/[\\/]/).pop()!;
    const { status, body } = await this.check(hash, query.fileSize!, fileName);
    if (status.status !== 'OK-2') return [];
    if (body.length === 0) throw this.error('bad-response', 'OK-2 without subtitle payload');
    const matches: MatchKey[] = ['hash'];
    const imdbNumber = status.fields.imdb;
    const imdbId = imdbNumber && /^\d+$/.test(imdbNumber) ? `tt${imdbNumber.padStart(7, '0')}` : undefined;
        if (imdbId && imdbId === query.imdbId) matches.push('imdb_id');
    return [
      this.candidate({
        id: hash,
        language: 'pl',
        forced: false,
        hi: false,
        releaseInfo: '',
        matches,
        token: { zip: Buffer.from(body).toString('base64'), imdbId, napisId: status.fields.napisId },
      }),
    ];
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    const zip = candidate.token?.zip;
    if (typeof zip !== 'string' || zip.length === 0) throw this.error('bad-response', 'candidate carries no payload');
    return this.file(new Uint8Array(Buffer.from(zip, 'base64')), 'napisy24.zip');
  }
}
