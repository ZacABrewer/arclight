import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { parseFile } from 'music-metadata';
import type { Db } from '../../db/index.js';
import { audioFiles } from '../library/schema.js';
import { albums, artists } from '../music/schema.js';
import { books } from '../audiobooks/schema.js';

// Artwork for player users, who cannot reach the admin library routes. In order: an image file
// in the item's folder (cover.jpg, folder.png ...), the picture embedded in its first audio file,
// a redirect to the stored catalogue image, else 404. Paths come from the database only. Images
// over MAX_ARTWORK_BYTES are skipped (never read into memory), so a stray huge file cannot pin RAM.

export type ArtworkKind = 'album' | 'artist' | 'book';

export type Artwork = { kind: 'bytes'; body: Buffer; mimeType: string } | { kind: 'redirect'; url: string } | null;

/** Larger folder or embedded images are skipped. */
export const MAX_ARTWORK_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const NAMES: Record<ArtworkKind, string[]> = {
  album: ['cover', 'folder', 'front', 'album'],
  book: ['cover', 'folder', 'front'],
  artist: ['artist', 'folder', 'poster'],
};

/** The first image in `dir` named like one of `names` (case-insensitive, in that order). */
export async function folderImage(dir: string, names: readonly string[]): Promise<Artwork> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const file = entries.find((e) => IMAGE_MIME[extname(e).toLowerCase()] && e.slice(0, -extname(e).length).toLowerCase() === name);
    if (!file) continue;
    try {
      const path = join(dir, file);
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_ARTWORK_BYTES) continue;
      return { kind: 'bytes', body: await readFile(path), mimeType: IMAGE_MIME[extname(file).toLowerCase()]! };
    } catch {
      continue;
    }
  }
  return null;
}

async function embedded(path: string): Promise<Artwork> {
  try {
    const meta = await parseFile(path, { duration: false, skipCovers: false });
    const pic = meta.common.picture?.[0];
    return pic && pic.data.length <= MAX_ARTWORK_BYTES ? { kind: 'bytes', body: Buffer.from(pic.data), mimeType: pic.format.includes('/') ? pic.format : `image/${pic.format}` } : null;
  } catch {
    return null;
  }
}

export function remote(images: ReadonlyArray<{ coverType: string; url: string; remoteUrl?: string | null | undefined }> | null, types: readonly string[]): Artwork {
  for (const type of types) {
    const img = images?.find((i) => i.coverType === type);
    const url = [img?.url, img?.remoteUrl].find((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (url) return { kind: 'redirect', url };
  }
  return null;
}

export async function findArtwork(db: Db, kind: ArtworkKind, id: number): Promise<Artwork> {
  if (kind === 'album') {
    const album = db.select({ images: albums.images }).from(albums).where(eq(albums.id, id)).get();
    if (!album) return null;
    const file = db.select({ path: audioFiles.path }).from(audioFiles).where(eq(audioFiles.albumId, id)).orderBy(audioFiles.discNumber, audioFiles.trackNumber, audioFiles.path).get();
    if (file) {
      const found = (await folderImage(dirname(file.path), NAMES.album)) ?? (await embedded(file.path));
      if (found) return found;
    }
    return remote(album.images, ['cover']);
  }
  if (kind === 'book') {
    const book = db.select({ images: books.images, path: books.path }).from(books).where(eq(books.id, id)).get();
    if (!book) return null;
    const file = db.select({ path: audioFiles.path }).from(audioFiles).where(eq(audioFiles.bookId, id)).orderBy(audioFiles.partNumber, audioFiles.trackNumber, audioFiles.path).get();
    const dir = book.path ?? (file ? dirname(file.path) : null);
    const found = (dir ? await folderImage(dir, NAMES.book) : null) ?? (file ? await embedded(file.path) : null);
    return found ?? remote(book.images, ['cover']);
  }
  const artist = db.select({ images: artists.images, path: artists.path }).from(artists).where(eq(artists.id, id)).get();
  if (!artist) return null;
  return (await folderImage(artist.path, NAMES.artist)) ?? remote(artist.images, ['poster', 'fanart', 'cover']);
}
