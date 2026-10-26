import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Fast-resume record persisted as `<infohash>.resume.json` next to `<infohash>.torrent`. */
export const ResumeDataSchema = z.object({
  version: z.literal(1),
  infoHash: z.string().regex(/^[0-9a-f]{40}$/),
  name: z.string(),
  /** Base64 piece bitfield (empty while metadata is unknown). */
  bitfield: z.string(),
  pieceCount: z.number().int().nonnegative(),
  uploaded: z.number().nonnegative(),
  downloaded: z.number().nonnegative(),
  seedingTimeMs: z.number().nonnegative(),
  activeTimeMs: z.number().nonnegative(),
  addedAt: z.string(),
  completedAt: z.string().nullable(),
  savePath: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  filePriorities: z.array(z.number().int().min(0).max(7)),
  paused: z.boolean(),
  sequential: z.boolean(),
  /** Size and mtime per file at save time, null for files with no data on disk. */
  fileStats: z.array(z.object({ size: z.number(), mtimeMs: z.number() }).nullable()),
  /** Original magnet for torrents still waiting for metadata. */
  magnet: z.string().nullable(),
  seedRatioLimit: z.number().nullable(),
  seedTimeLimitMs: z.number().nullable(),
  /** BEP 16 super-seeding flag (absent in older files). */
  superSeeding: z.boolean().optional(),
  /** Per-torrent and per-peer rate limits in bytes/s (absent in older files). */
  uploadLimit: z.number().nonnegative().optional(),
  downloadLimit: z.number().nonnegative().optional(),
  peerUploadLimit: z.number().nonnegative().optional(),
  peerDownloadLimit: z.number().nonnegative().optional(),
});
export type ResumeData = z.infer<typeof ResumeDataSchema>;

export function resumePath(dir: string, infoHashHex: string): string {
  return join(dir, `${infoHashHex}.resume.json`);
}

export function torrentPath(dir: string, infoHashHex: string): string {
  return join(dir, `${infoHashHex}.torrent`);
}

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function saveResumeData(dir: string, data: ResumeData, torrent?: Buffer): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (torrent) await atomicWrite(torrentPath(dir, data.infoHash), torrent);
  await atomicWrite(resumePath(dir, data.infoHash), JSON.stringify(data, null, 2));
}

/** Loads a resume record; returns null when missing or invalid. */
export async function loadResumeData(dir: string, infoHashHex: string): Promise<ResumeData | null> {
  try {
    const parsed = ResumeDataSchema.safeParse(JSON.parse(await readFile(resumePath(dir, infoHashHex), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Info-hashes that have a resume record in `dir`. */
export async function listResumeData(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .map((f) => /^([0-9a-f]{40})\.resume\.json$/.exec(f)?.[1])
      .filter((x): x is string => x !== undefined);
  } catch {
    return [];
  }
}

export async function deleteResumeData(dir: string, infoHashHex: string): Promise<void> {
  await rm(resumePath(dir, infoHashHex), { force: true });
  await rm(torrentPath(dir, infoHashHex), { force: true });
}
