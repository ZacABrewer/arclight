import { z } from 'zod';
import {
  AudiobookManualImportItem,
  AudioManualImportResult,
  Job,
  ReleaseDecision,
  ReleaseGrabResponse,
  type AudioManualImportRequestInput,
  type AudiobookCommand,
  type BookFormatType,
  type ReleaseGrabRequest,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Audiobook acquisition (docs/design/music-audiobooks.md, Wave 3 / WP 3E). The release search and
// grab routes are shared with video and music (GET/POST /release with the audiobook fields of
// packages/shared releases.ts); searches go through POST /command (BookSearch, AuthorSearch);
// manual import uses the audio routes with `mediaType: 'audiobook'` (docs/API.md).

export type AudiobookReleaseTarget = { bookId: number; authorId?: number | undefined } | { authorId: number };

/** The facts the release table shows, read from the decision's parsed audiobook info. */
export interface AudiobookFacts {
  narrators: string[];
  formatType: BookFormatType | null;
  container: string | null;
  bitrateKbps: number | null;
  series: string | null;
  seriesPosition: string | null;
  isPack: boolean;
}

const FORMAT_TYPES = new Set<string>(['unabridged', 'abridged', 'dramatized']);

export function audiobookFacts(r: Pick<ReleaseDecision, 'audiobook'>): AudiobookFacts {
  const a = r.audiobook;
  const container = a?.container && a.container !== 'unknown' ? a.container : null;
  const formatType = a?.formatType && FORMAT_TYPES.has(a.formatType) ? (a.formatType as BookFormatType) : null;
  return {
    narrators: a?.narrators ?? [],
    formatType,
    container,
    bitrateKbps: a?.bitrateKbps ?? null,
    series: a?.series ?? null,
    seriesPosition: a?.seriesPosition ?? null,
    isPack: a?.isPack === true,
  };
}

/** POST /release body for an audiobook grab: the guid plus the author and books the decision mapped to. */
export function audiobookGrabRequest(r: ReleaseDecision): ReleaseGrabRequest {
  return {
    guid: r.guid,
    indexerId: r.indexerId,
    ...(r.authorId !== undefined ? { authorId: r.authorId } : {}),
    ...(r.bookIds?.length ? { bookIds: r.bookIds } : {}),
  };
}

/** GET /manualimport/audio in audiobook mode: a folder or download, optionally pinned to an author or book. */
export interface AudiobookManualImportQuery {
  folder?: string | undefined;
  downloadId?: string | undefined;
  authorId?: number | undefined;
  bookId?: number | undefined;
  filterExistingFiles?: boolean | undefined;
}

export const audiobookAcquisitionApi = {
  releases: {
    /** GET /release?bookId= (one book) or ?authorId= (packs plus every wanted book). */
    search: (target: AudiobookReleaseTarget) => request('/release', ReleaseDecision.array(), { query: target as QueryParams }),
    grab: (body: ReleaseGrabRequest) => request('/release', ReleaseGrabResponse, { method: 'POST', json: body }),
  },
  /** BookSearch / AuthorSearch through POST /command (answered 202 with the job). */
  command: (body: Extract<AudiobookCommand, { name: 'BookSearch' | 'AuthorSearch' }>) => request('/command', Job, { method: 'POST', json: body }),
  manualImport: {
    scan: (query: AudiobookManualImportQuery) =>
      request('/manualimport/audio', z.array(AudiobookManualImportItem), { query: { ...query, mediaType: 'audiobook' } as QueryParams }),
    execute: (body: AudioManualImportRequestInput) => request('/manualimport/audio', AudioManualImportResult, { method: 'POST', json: body }),
  },
};
