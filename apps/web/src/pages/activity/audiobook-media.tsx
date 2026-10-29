import { Link } from '@tanstack/react-router';
import { useAuthorBooks, useAuthorList } from '../../hooks/audiobooks.js';
import { useFeatures } from '../../hooks/music.js';
import { AudiobookChip } from '../library/audiobooks/audiobook-kit.js';
import { isMusicRecord, MusicMediaLabel, type MusicTarget } from './music-media.js';
import { t } from '../../i18n/index.js';

// "Author – Title" labels for audiobook rows in Activity (queue, history, blocklist, pending).
// Records carry `authorId` and `bookIds` with `mediaType: 'audiobook'`; names come from the
// record when the server includes them, else from the author list and that author's books
// (both cached and shared by every row).

/** The audiobook fields an activity record may carry (all optional; older servers send none). */
export interface AudiobookTarget {
  mediaType?: string | null | undefined;
  authorId?: number | null | undefined;
  bookIds?: readonly number[] | null | undefined;
  /** Single-book records. */
  bookId?: number | null | undefined;
  authorName?: string | null | undefined;
  bookTitle?: string | null | undefined;
}

/** True for a record about an audiobook (by media type, or by carrying an author/book target). */
export function isAudiobookRecord(r: AudiobookTarget): boolean {
  return r.mediaType === 'audiobook' || r.authorId != null || (r.bookIds?.length ?? 0) > 0 || r.bookId != null;
}

/** The record's book ids, single or listed, without duplicates. */
export function bookIdsOf(r: AudiobookTarget): number[] {
  return [...new Set([...(r.bookIds ?? []), ...(r.bookId != null ? [r.bookId] : [])])];
}

/** "Author – Title", "Author – Title (+2)", "Author" or the title alone. */
export function audiobookLabel(author: string | null, title: string | null, more: number): string {
  const base = author && title ? t('activity.audiobook.authorTitle', { author, title }) : (title ?? author ?? t('audiobooks.audiobook'));
  return more > 0 ? t('activity.audiobook.moreBooks', { label: base, count: more }) : base;
}

/** The audiobook chip plus "Author – Title", linked to the (first) book, else the author. */
export function AudiobookMediaLabel({ record }: { record: AudiobookTarget }) {
  const features = useFeatures();
  const ids = bookIdsOf(record);
  const needsAuthor = !record.authorName && record.authorId != null;
  const needsBook = !record.bookTitle && ids.length > 0 && record.authorId != null;
  const authors = useAuthorList(features.audiobooks && needsAuthor);
  const books = useAuthorBooks(record.authorId, features.audiobooks && needsBook);
  const authorName = record.authorName ?? authors.data?.find((a) => a.id === record.authorId)?.name ?? null;
  const first = ids[0];
  const title = record.bookTitle ?? (first !== undefined ? books.data?.find((b) => b.id === first)?.title : undefined) ?? null;
  const text = audiobookLabel(authorName, title, Math.max(0, ids.length - 1));
  return (
    <span className="al-activity-music">
      <AudiobookChip />
      {first !== undefined ? (
        <Link className="al-link" to="/library/audiobooks/book/$id" params={{ id: String(first) }}>
          {text}
        </Link>
      ) : record.authorId != null ? (
        <Link className="al-link" to="/library/audiobooks/author/$id" params={{ id: String(record.authorId) }}>
          {text}
        </Link>
      ) : (
        <span>{text}</span>
      )}
    </span>
  );
}

/** Audio records of either kind (audiobook checked first: its rows carry no artist). */
export type AudioTarget = MusicTarget & AudiobookTarget;

export function isAudioRecord(r: AudioTarget): boolean {
  return isAudiobookRecord(r) || isMusicRecord(r);
}

/** The music or audiobook label for an activity record. */
export function AudioMediaLabel({ record }: { record: AudioTarget }) {
  return isAudiobookRecord(record) ? <AudiobookMediaLabel record={record} /> : <MusicMediaLabel record={record} />;
}

/** The manual-import mode a queue row opens with. */
export function audioImportMode(r: AudioTarget): 'audiobook' | 'music' | null {
  return isAudiobookRecord(r) ? 'audiobook' : isMusicRecord(r) ? 'music' : null;
}
