import { asc, eq } from 'drizzle-orm';
import { BooksFormatProfileInput, type BooksFormatProfile, type BooksKind } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { BooksError } from './errors.js';
import { bookFormatProfiles, comicSeries, ebookAuthors, type BookFormatProfileRow } from './schema.js';

// Format profiles (docs/books.md "Format profiles"): which file formats a kind accepts, best
// first, plus size limits and term filters. Two defaults are seeded on startup, by name and
// only when missing, so a renamed or deleted default comes back but an edited one is kept.

/** The profiles seeded on startup (matched by name). */
export const DEFAULT_FORMAT_PROFILES: readonly BooksFormatProfileInput[] = [
  { name: 'Ebooks', kind: 'ebook', formats: ['epub', 'azw3', 'mobi', 'pdf'], cutoff: 'epub', minSizeMb: 0, maxSizeMb: 100 },
  { name: 'Comics', kind: 'comic', formats: ['cbz', 'cbr', 'cb7', 'pdf'], cutoff: 'cbz', minSizeMb: 0, maxSizeMb: 2000 },
];

export function toFormatProfile(row: BookFormatProfileRow): BooksFormatProfile {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    formats: row.formats,
    cutoff: row.cutoff,
    upgradeAllowed: row.upgradeAllowed,
    minSizeMb: row.minSizeMb,
    maxSizeMb: row.maxSizeMb,
    ignoredTerms: row.ignoredTerms,
    preferredTerms: row.preferredTerms,
  };
}

/** Inserts the default profiles that are missing (idempotent); returns how many were added. */
export function seedFormatProfiles(db: Db): number {
  let added = 0;
  for (const input of DEFAULT_FORMAT_PROFILES) {
    const exists = db.select({ id: bookFormatProfiles.id }).from(bookFormatProfiles).where(eq(bookFormatProfiles.name, input.name)).get();
    if (exists) continue;
    db.insert(bookFormatProfiles).values(valuesOf(BooksFormatProfileInput.parse(input))).onConflictDoNothing().run();
    added += 1;
  }
  return added;
}

function valuesOf(p: ReturnType<typeof BooksFormatProfileInput.parse>) {
  return {
    name: p.name.trim(),
    kind: p.kind,
    formats: p.formats,
    cutoff: p.cutoff,
    upgradeAllowed: p.upgradeAllowed,
    minSizeMb: p.minSizeMb,
    maxSizeMb: p.maxSizeMb,
    ignoredTerms: p.ignoredTerms.map((t) => t.trim()).filter(Boolean),
    preferredTerms: p.preferredTerms.map((t) => t.trim()).filter(Boolean),
  };
}

export function listFormatProfiles(db: Db): BooksFormatProfile[] {
  return db.select().from(bookFormatProfiles).orderBy(asc(bookFormatProfiles.id)).all().map(toFormatProfile);
}

export function formatProfileRow(db: Db, id: number): BookFormatProfileRow {
  const row = db.select().from(bookFormatProfiles).where(eq(bookFormatProfiles.id, id)).get();
  if (!row) throw BooksError.notFound('format profile', id);
  return row;
}

/** The profile, which must exist and be of `kind` (VALIDATION otherwise). */
export function requireFormatProfile(db: Db, id: number, kind: BooksKind): BookFormatProfileRow {
  const row = db.select().from(bookFormatProfiles).where(eq(bookFormatProfiles.id, id)).get();
  if (!row) throw new BooksError('VALIDATION', `format profile ${id} does not exist`);
  if (row.kind !== kind) throw new BooksError('VALIDATION', `format profile ${row.name} is not a${kind === 'ebook' ? 'n ebook' : ' comic'} profile`);
  return row;
}

function assertNameFree(db: Db, name: string, selfId?: number): void {
  const clash = db.select({ id: bookFormatProfiles.id }).from(bookFormatProfiles).where(eq(bookFormatProfiles.name, name.trim())).get();
  if (clash && clash.id !== selfId) throw new BooksError('CONFLICT', `a format profile named ${name.trim()} already exists`);
}

function parseInput(raw: BooksFormatProfileInput) {
  const parsed = BooksFormatProfileInput.safeParse(raw);
  if (!parsed.success) throw new BooksError('VALIDATION', parsed.error.issues.map((i) => i.message).join('; '));
  return parsed.data;
}

export function createFormatProfile(db: Db, raw: BooksFormatProfileInput): BooksFormatProfile {
  const input = parseInput(raw);
  assertNameFree(db, input.name);
  return toFormatProfile(db.insert(bookFormatProfiles).values(valuesOf(input)).returning().get());
}

/** The kind cannot change while authors or series use the profile. */
export function updateFormatProfile(db: Db, id: number, raw: BooksFormatProfileInput): BooksFormatProfile {
  const current = formatProfileRow(db, id);
  const input = parseInput(raw);
  assertNameFree(db, input.name, id);
  if (input.kind !== current.kind && profileInUse(db, id)) {
    throw new BooksError('CONFLICT', `format profile ${current.name} is in use; its kind cannot change`);
  }
  return toFormatProfile(db.update(bookFormatProfiles).set(valuesOf(input)).where(eq(bookFormatProfiles.id, id)).returning().get()!);
}

export function profileInUse(db: Db, id: number): boolean {
  const author = db.select({ id: ebookAuthors.id }).from(ebookAuthors).where(eq(ebookAuthors.formatProfileId, id)).limit(1).get();
  if (author) return true;
  return db.select({ id: comicSeries.id }).from(comicSeries).where(eq(comicSeries.formatProfileId, id)).limit(1).get() !== undefined;
}

/** CONFLICT while an author or comic series uses the profile. */
export function deleteFormatProfile(db: Db, id: number): void {
  const row = formatProfileRow(db, id);
  if (profileInUse(db, id)) throw new BooksError('CONFLICT', `format profile ${row.name} is in use`);
  db.delete(bookFormatProfiles).where(eq(bookFormatProfiles.id, id)).run();
}
