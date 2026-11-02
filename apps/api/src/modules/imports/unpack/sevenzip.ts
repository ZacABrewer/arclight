import { spawn } from 'node:child_process';

// The 7-Zip command line (`7zz`, the official static build in the Docker image), used for
// listing and extracting RAR, 7z and zip archives. Arguments are always passed as an array
// (never through a shell) and a dummy password is always given, so 7-Zip never stops to ask
// for one: an encrypted archive fails with "Wrong password" instead.

/** Never a real password: makes 7-Zip fail fast on encrypted archives instead of prompting. */
const DUMMY_PASSWORD = 'arclight-no-password';
const CANDIDATES = ['7zz', '7z', '7za'];

export type SevenZipFailure = 'encrypted' | 'missingVolume' | 'corrupt' | 'unsupported' | 'failed';

export class SevenZipError extends Error {
  constructor(
    readonly kind: SevenZipFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SevenZipError';
  }
}

export interface ArchiveEntry {
  path: string;
  sizeBytes: number;
  folder: boolean;
  encrypted: boolean;
}

export interface ArchiveListing {
  type: string | null;
  entries: ArchiveEntry[];
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (
  binary: string,
  args: readonly string[],
  options?: { onStdout?: (chunk: string) => void; timeoutMs?: number },
) => Promise<RunResult>;

/** Runs a binary without a shell, stdin closed (nothing can prompt). */
export const spawnRunner: Runner = (binary, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer =
      options.timeoutMs !== undefined ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // Progress output is long and repetitive; keep only the tail for error messages.
      stdout = (stdout + chunk).slice(-64 * 1024);
      options.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

let cachedBinary: Promise<string | null> | undefined;

/**
 * The 7-Zip binary to use: `ARCLIGHT_7ZIP` when set, else the first of 7zz / 7z / 7za that
 * runs. Null when none is installed. Cached; `refresh` looks again.
 */
export function findSevenZip(options: { refresh?: boolean; runner?: Runner; env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
  if (cachedBinary && !options.refresh && !options.runner) return cachedBinary;
  const runner = options.runner ?? spawnRunner;
  const env = options.env ?? process.env;
  const lookup = (async () => {
    const configured = env.ARCLIGHT_7ZIP?.trim();
    for (const candidate of configured ? [configured] : CANDIDATES) {
      try {
        const r = await runner(candidate, ['i'], { timeoutMs: 10_000 });
        if (r.code === 0 && /7-Zip/i.test(r.stdout)) return candidate;
      } catch {
        // not installed under this name
      }
    }
    return null;
  })();
  if (!options.runner) cachedBinary = lookup;
  return lookup;
}

/** Classifies 7-Zip's output of a failed run. */
export function classifyFailure(output: string): SevenZipFailure {
  if (/wrong password|cannot open encrypted archive|encrypted archive/i.test(output)) return 'encrypted';
  if (/missing volume|unexpected end of archive.*volume|there are some data after the end/i.test(output) && /volume/i.test(output)) {
    return 'missingVolume';
  }
  if (/unsupported method|unsupported feature/i.test(output)) return 'unsupported';
  if (/unexpected end of archive|data error|crc failed|headers error|can ?not open the file as archive|is not archive/i.test(output)) {
    return 'corrupt';
  }
  return 'failed';
}

/** First meaningful error line of 7-Zip's output (for messages). */
export function firstError(output: string): string | undefined {
  const lines = output
    .split(/[\r\n]+/)
    .map((l) => l.replace(/[\b]/g, '').trim())
    .filter(Boolean);
  return lines.find((l) => /^(error|errors?:|can ?not|unexpected|wrong|missing|data error|crc failed)/i.test(l) || / : (missing|wrong|data|crc)/i.test(l));
}

function failureMessage(kind: SevenZipFailure, archiveName: string, detail: string | undefined): string {
  switch (kind) {
    case 'encrypted':
      return `${archiveName} is password-protected`;
    case 'missingVolume':
      return `${archiveName} is incomplete: a volume of the set is missing${detail ? ` (${detail})` : ''}`;
    case 'corrupt':
      return `${archiveName} is damaged or incomplete${detail ? ` (${detail})` : ''}`;
    case 'unsupported':
      return `${archiveName} uses a compression method 7-Zip cannot extract${detail ? ` (${detail})` : ''}`;
    default:
      return `Could not unpack ${archiveName}${detail ? `: ${detail}` : ''}`;
  }
}

/** Parses `7z l -slt` output: the archive block, then one block per entry after `----------`. */
export function parseSltListing(stdout: string): ArchiveListing {
  const text = stdout.replace(/\r/g, '');
  const split = text.indexOf('\n----------\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 12) : '';
  const type = /^Type = (.+)$/m.exec(head)?.[1]?.trim() ?? null;
  const entries: ArchiveEntry[] = [];
  for (const block of body.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const eq = line.indexOf(' = ');
      if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 3));
      else if (line.endsWith(' =')) fields.set(line.slice(0, -2).trim(), '');
    }
    const path = fields.get('Path');
    if (path === undefined || path === '') continue;
    const attributes = fields.get('Attributes') ?? '';
    entries.push({
      path,
      sizeBytes: Number(fields.get('Size') ?? 0) || 0,
      folder: fields.get('Folder') === '+' || attributes.startsWith('D'),
      encrypted: fields.get('Encrypted') === '+',
    });
  }
  return { type, entries };
}

/** Last percentage in a chunk of `-bsp1` progress output (0..1), or null. */
export function parseProgress(chunk: string): number | null {
  const matches = [...chunk.matchAll(/(\d{1,3})%/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const n = Number(last[1]);
  return n >= 0 && n <= 100 ? n / 100 : null;
}

export class SevenZip {
  constructor(
    readonly binary: string,
    private readonly runner: Runner = spawnRunner,
    private readonly timeoutMs = 6 * 60 * 60_000,
  ) {}

  /** Lists an archive (the first volume of a set). Throws SevenZipError. */
  async list(archive: string, archiveName = archive): Promise<ArchiveListing> {
    const r = await this.runner(this.binary, ['l', '-slt', '-y', `-p${DUMMY_PASSWORD}`, '--', archive], { timeoutMs: 5 * 60_000 });
    const output = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0) {
      const kind = classifyFailure(output);
      throw new SevenZipError(kind, failureMessage(kind, archiveName, firstError(output)));
    }
    // A listing can succeed and still report the set as broken ("ERROR = Missing volume").
    const listingError = /^ERRORS?(?: =|:)\s*(.+)$/m.exec(r.stdout.replace(/\r/g, ''))?.[1]?.trim();
    if (listingError) {
      const kind = classifyFailure(listingError);
      throw new SevenZipError(kind === 'failed' ? 'corrupt' : kind, failureMessage(kind === 'failed' ? 'corrupt' : kind, archiveName, listingError));
    }
    return parseSltListing(r.stdout);
  }

  /** Extracts an archive into `outDir` (created by 7-Zip), reporting progress 0..1. Throws SevenZipError. */
  async extract(archive: string, outDir: string, onProgress?: (fraction: number) => void, archiveName = archive): Promise<void> {
    const r = await this.runner(
      this.binary,
      ['x', '-y', '-aoa', '-bsp1', '-bso0', '-bb0', `-p${DUMMY_PASSWORD}`, `-o${outDir}`, '--', archive],
      {
        timeoutMs: this.timeoutMs,
        ...(onProgress
          ? {
              onStdout: (chunk: string) => {
                const p = parseProgress(chunk);
                if (p !== null) onProgress(p);
              },
            }
          : {}),
      },
    );
    if (r.code !== 0) {
      const output = `${r.stdout}\n${r.stderr}`;
      const kind = classifyFailure(output);
      throw new SevenZipError(kind, failureMessage(kind, archiveName, firstError(output)));
    }
    onProgress?.(1);
  }
}
