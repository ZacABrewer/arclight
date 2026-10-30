/**
 * Turns a `NotificationEvent` into human-readable text once, so every agent says the same
 * thing. Chat agents consume `title` + `body` (or `fields` when they can render columns);
 * webhook and script agents forward the raw event instead.
 */

import type {
  AlbumInfo,
  BookInfo,
  EpisodeInfo,
  MediaInfo,
  NotificationEvent,
  NotificationEventType,
  ReleaseInfo,
  RetentionLine,
} from './types.js';

export type Severity = 'info' | 'success' | 'upgrade' | 'warning' | 'error';

export interface FormattedField {
  name: string;
  value: string;
  /** Hint for agents that lay fields out in columns (Discord). */
  inline?: boolean;
}

/** A link a human can act on (approve/decline a request, open the admin page). */
export interface FormattedAction {
  label: string;
  url: string;
}

export interface FormattedEvent {
  /** What happened, e.g. "Episode Grabbed". */
  subject: string;
  /** Headline: media title plus episode label, or the subject for non-media events. */
  title: string;
  /** Plain-text multi-line body (title line excluded). */
  body: string;
  severity: Severity;
  fields: FormattedField[];
  /** Link to the media (Arclight page when `applicationUrl` is set, otherwise TMDB). */
  link?: string;
  posterUrl?: string;
  fanartUrl?: string;
  /** Deep links into Arclight's admin pages; only when `applicationUrl` is set. */
  actions?: FormattedAction[];
  /** Who the event is about (request events): shown as author/footer by rich agents. */
  person?: { name: string; avatarUrl?: string };
}

/** Arclight's request/issue pages for an event, when the instance URL is known. */
export function requestLinks(applicationUrl: string | undefined, requestId: number): { view: string; approve: string; decline: string } | undefined {
  if (!applicationUrl) return undefined;
  const base = applicationUrl.replace(/\/+$/, '');
  return {
    view: `${base}/requests/${requestId}`,
    approve: `${base}/requests/${requestId}?action=approve`,
    decline: `${base}/requests/${requestId}?action=decline`,
  };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function mediaLabel(media: MediaInfo): string {
  return media.year > 0 ? `${media.title} (${media.year})` : media.title;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * "S01E02" for one episode, "S01E02-E04" for a run, "S01E02,E05" for a gap,
 * "" when there are no episodes (movies).
 */
export function episodeLabel(episodes: readonly EpisodeInfo[] | undefined): string {
  if (!episodes || episodes.length === 0) return '';
  const bySeason = new Map<number, number[]>();
  for (const ep of episodes) {
    const list = bySeason.get(ep.seasonNumber) ?? [];
    list.push(ep.episodeNumber);
    bySeason.set(ep.seasonNumber, list);
  }
  const parts: string[] = [];
  for (const [season, numbers] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first === undefined || last === undefined) continue;
    const contiguous = sorted.every((n, i) => n === first + i);
    let label = `S${pad2(season)}E${pad2(first)}`;
    if (sorted.length > 1) {
      label += contiguous
        ? `-E${pad2(last)}`
        : sorted
            .slice(1)
            .map((n) => `,E${pad2(n)}`)
            .join('');
    }
    parts.push(label);
  }
  return parts.join(' ');
}

export function episodeTitles(episodes: readonly EpisodeInfo[] | undefined): string {
  if (!episodes || episodes.length === 0) return '';
  return episodes.map((e) => e.title).filter((t) => t.length > 0).join(' + ');
}

/** Extra context for music/audiobook headlines. */
export interface AudioContext {
  album?: AlbumInfo | undefined;
  book?: BookInfo | undefined;
  /** Quality shown in brackets: "Artist – Album [FLAC]". */
  quality?: string | undefined;
}

/** "Artist – Album [FLAC]" (album and quality when known). */
export function musicHeadline(media: MediaInfo, ctx: AudioContext = {}): string {
  const head = ctx.album?.title ? `${media.title} – ${ctx.album.title}` : media.title;
  return ctx.quality ? `${head} [${ctx.quality}]` : head;
}

/** "Author – Title (narrated by X)" (narrators joined with "and"). */
export function audiobookHeadline(media: MediaInfo, ctx: AudioContext = {}): string {
  const book = ctx.book;
  if (!book) return media.title;
  const narrators = book.narrators.filter((n) => n.trim().length > 0);
  const by = narrators.length > 0 ? ` (narrated by ${joinNames(narrators)})` : '';
  return `${media.title} – ${book.title}${by}`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Title (Year) - S01E02 - Episode Title", "Title (Year)" for movies, "Artist – Album [FLAC]" for music. */
export function mediaHeadline(media: MediaInfo, episodes?: readonly EpisodeInfo[], audio: AudioContext = {}): string {
  if (media.mediaType === 'music') return musicHeadline(media, audio);
  if (media.mediaType === 'audiobook') return audiobookHeadline(media, audio);
  const parts = [mediaLabel(media)];
  const label = episodeLabel(episodes);
  if (label) parts.push(label);
  const titles = episodeTitles(episodes);
  if (titles) parts.push(titles);
  return parts.join(' - ');
}

export function mediaLink(media: MediaInfo, applicationUrl?: string, audio: AudioContext = {}): string | undefined {
  const base = applicationUrl?.replace(/\/+$/, '');
  if (media.mediaType === 'music') {
    if (!base) return undefined;
    return audio.album ? `${base}/library/music/album/${audio.album.id}` : `${base}/library/music/artist/${media.id}`;
  }
  if (media.mediaType === 'audiobook') {
    if (!base) return undefined;
    return audio.book ? `${base}/library/audiobooks/book/${audio.book.id}` : `${base}/library/audiobooks/author/${media.id}`;
  }
  if (base) return `${base}/${media.mediaType === 'series' ? 'series' : 'movies'}/${media.id}`;
  if (media.tmdbId > 0) {
    return `https://www.themoviedb.org/${media.mediaType === 'series' ? 'tv' : 'movie'}/${media.tmdbId}`;
  }
  if (media.imdbId) return `https://www.imdb.com/title/${media.imdbId}/`;
  return undefined;
}

export function imageUrl(media: MediaInfo, coverType: 'poster' | 'fanart'): string | undefined {
  return media.images.find((i) => i.coverType === coverType)?.url;
}

function noun(media: MediaInfo | undefined, episodes: readonly EpisodeInfo[] | undefined): string {
  if (!media) return 'Download';
  switch (media.mediaType) {
    case 'movie':
      return 'Movie';
    case 'music':
      return 'Album';
    case 'audiobook':
      return 'Audiobook';
    case 'series':
      return episodes && episodes.length > 0 ? 'Episode' : 'Series';
  }
}

/** The library item itself: "Series", "Movie", "Artist", "Author". */
function itemNoun(media: MediaInfo): string {
  switch (media.mediaType) {
    case 'movie':
      return 'Movie';
    case 'music':
      return 'Artist';
    case 'audiobook':
      return 'Author';
    case 'series':
      return 'Series';
  }
}

/** What a request is for: albums and books are requested, not artists or authors. */
function requestNoun(media: MediaInfo): string {
  if (media.mediaType === 'music') return 'Album';
  if (media.mediaType === 'audiobook') return 'Audiobook';
  return itemNoun(media);
}

export function eventSubject(event: NotificationEvent): string {
  switch (event.type) {
    case 'test':
      return 'Test Notification';
    case 'grab':
      return `${noun(event.media, event.episodes)} Grabbed`;
    case 'import':
      return `${noun(event.media, event.episodes)} Imported`;
    case 'upgrade':
      return `${noun(event.media, event.episodes)} Upgraded`;
    case 'rename':
      return `${itemNoun(event.media)} Renamed`;
    case 'mediaAdded':
      return `${itemNoun(event.media)} Added`;
    case 'mediaDeleted':
      return `${itemNoun(event.media)} Deleted`;
    case 'fileDeleted':
      return `${noun(event.media, event.episodes)} File Deleted`;
    case 'healthIssue':
      return `Health Issue: ${event.health.status === 'error' ? 'Error' : 'Warning'}`;
    case 'healthRestored':
      return 'Health Issue Resolved';
    case 'applicationUpdate':
      return 'Application Updated';
    case 'manualInteractionRequired':
      return 'Manual Interaction Required';
    case 'subtitleDownloaded':
      return 'Subtitle Downloaded';
    case 'requestCreated':
      return `${requestNoun(event.media)} Requested`;
    case 'requestApproved':
      return 'Request Approved';
    case 'requestAvailable':
      return 'Request Available';
    case 'requestDeclined':
      return 'Request Declined';
    case 'issueCreated':
      return `New ${ISSUE_TYPE_LABELS[event.issue.issueType]}Issue Reported`;
    case 'issueUpdated':
      return event.issue.change === 'resolved' ? 'Issue Resolved' : event.issue.change === 'reopened' ? 'Issue Reopened' : 'New Issue Comment';
    case 'requestsDigest':
      return 'Requests Digest';
    case 'retention':
      return 'Retention Summary';
    case 'healthScan':
      return 'Health Scan Found Problems';
    case 'fileTranscoded':
      return `${noun(event.media, event.episodes)} File Transcoded`;
    case 'downloadStalled':
      return 'Download Stalled';
    case 'killSwitch':
      return event.pausedMinutes !== undefined ? 'Downloads Still Paused by Kill Switch' : 'Downloads Paused by Kill Switch';
    case 'killSwitchResumed':
      return 'Downloads Resumed';
    case 'importProblem':
      return event.problem === 'failed' ? 'Import Failed' : 'Import Blocked';
    case 'diskSpaceLow':
      return event.health.status === 'error' ? 'Disk Full' : 'Disk Space Low';
    case 'downloadUpdate':
      return `Download ${timelineTypeLabel(event.timelineType)}`;
    case 'dailySummary':
      return 'Daily Summary';
    case 'heldAlerts':
      return 'Alerts From Quiet Hours';
  }
}

/** `recovered` -> "Recovered", `releaseReplaced` -> "Release Replaced". */
export function timelineTypeLabel(type: string): string {
  const spaced = type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Update';
}

/** "1 h 5 min", "12 min", "45 s". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMinutes === 0) return `${Math.round(Math.max(0, ms) / 1000)} s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, success: 0, upgrade: 0, warning: 1, error: 2 };

const RETENTION_ACTION_LABELS: Record<RetentionLine['action'], string> = {
  unmonitor: 'unmonitor',
  deleteFiles: 'delete files',
  deleteItem: 'delete',
};

const ISSUE_TYPE_LABELS: Record<'video' | 'audio' | 'subtitles' | 'other', string> = {
  video: 'Video ',
  audio: 'Audio ',
  subtitles: 'Subtitle ',
  other: '',
};

export function eventSeverity(event: NotificationEvent): Severity {
  switch (event.type) {
    case 'import':
    case 'healthRestored':
    case 'requestAvailable':
    case 'requestApproved':
    case 'subtitleDownloaded':
      return 'success';
    case 'upgrade':
      return 'upgrade';
    case 'healthIssue':
      return event.health.status === 'error' ? 'error' : 'warning';
    case 'retention':
      return event.totalFailed > 0 ? 'warning' : 'info';
    case 'healthScan':
      return event.findings.some((f) => f.severity === 'error') ? 'error' : 'warning';
    case 'killSwitchResumed':
      return 'success';
    case 'importProblem':
      return event.problem === 'failed' ? 'error' : 'warning';
    case 'diskSpaceLow':
      return event.health.status === 'error' ? 'error' : 'warning';
    case 'downloadUpdate':
      return event.severity === 'ok' ? 'success' : event.severity;
    case 'dailySummary':
      return event.summary.counts.failed > 0 || event.summary.healthIssues.some((h) => h.status === 'error') ? 'warning' : 'info';
    case 'heldAlerts': {
      let worst: Severity = 'info';
      for (const inner of event.events) {
        const s = eventSeverity(inner);
        if (SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s;
      }
      return worst;
    }
    case 'killSwitch':
      return event.pausedMinutes !== undefined ? 'error' : 'warning';
    case 'downloadStalled':
    case 'manualInteractionRequired':
    case 'mediaDeleted':
    case 'fileDeleted':
    case 'requestDeclined':
    case 'issueCreated':
      return 'warning';
    default:
      return 'info';
  }
}

export const EVENT_LABELS: Record<NotificationEventType, string> = {
  test: 'Test',
  grab: 'On Grab',
  import: 'On Import',
  upgrade: 'On Upgrade',
  rename: 'On Rename',
  mediaAdded: 'On Series/Movie Added',
  mediaDeleted: 'On Series/Movie Deleted',
  fileDeleted: 'On File Deleted',
  healthIssue: 'On Health Issue',
  healthRestored: 'On Health Restored',
  applicationUpdate: 'On Application Update',
  manualInteractionRequired: 'On Manual Interaction Required',
  subtitleDownloaded: 'On Subtitle Downloaded',
  requestCreated: 'On Request Created',
  requestApproved: 'On Request Approved',
  requestAvailable: 'On Request Available',
  requestDeclined: 'On Request Declined',
  issueCreated: 'On Issue Reported',
  issueUpdated: 'On Issue Updated',
  requestsDigest: 'Requests Digest',
  retention: 'Retention Summary',
  healthScan: 'On Health Scan Problems',
  fileTranscoded: 'On File Transcoded',
  downloadStalled: 'On Download Stalled',
  killSwitch: 'On Kill Switch',
  killSwitchResumed: 'On Kill Switch Resumed',
  importProblem: 'On Import Problem',
  diskSpaceLow: 'On Disk Space Low',
  downloadUpdate: 'On Download Recovered',
  dailySummary: 'Daily Summary',
  heldAlerts: 'Held Alerts',
};

function releaseFields(release: ReleaseInfo): FormattedField[] {
  const fields: FormattedField[] = [
    { name: 'Quality', value: qualityLabel(release.quality, release.qualityVersion), inline: true },
    { name: 'Size', value: formatBytes(release.size), inline: true },
  ];
  if (release.indexer) fields.push({ name: 'Indexer', value: release.indexer, inline: true });
  if (release.releaseGroup) fields.push({ name: 'Group', value: release.releaseGroup, inline: true });
  if (release.customFormats.length > 0) {
    fields.push({ name: 'Custom Formats', value: release.customFormats.join(', ') });
    fields.push({ name: 'Custom Format Score', value: String(release.customFormatScore), inline: true });
  }
  fields.push({ name: 'Release', value: release.title });
  return fields;
}

export function qualityLabel(quality: string, version: number): string {
  return version > 1 ? `${quality} v${version}` : quality;
}

function downloadFields(info: {
  downloadClient?: string;
  downloadId?: string;
}): FormattedField[] {
  const fields: FormattedField[] = [];
  if (info.downloadClient) fields.push({ name: 'Download Client', value: info.downloadClient, inline: true });
  if (info.downloadId) fields.push({ name: 'Download Id', value: info.downloadId, inline: true });
  return fields;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function formatEvent(event: NotificationEvent): FormattedEvent {
  const subject = eventSubject(event);
  const severity = eventSeverity(event);
  const fields: FormattedField[] = [];
  let title = subject;
  let link: string | undefined;
  let posterUrl: string | undefined;
  let fanartUrl: string | undefined;
  const actions: FormattedAction[] = [];
  let person: FormattedEvent['person'];
  const base = event.applicationUrl?.replace(/\/+$/, '');

  const media = 'media' in event ? event.media : undefined;
  const episodes = 'episodes' in event ? event.episodes : undefined;
  const audio = audioContextOf(event);
  if (media) {
    title = mediaHeadline(media, episodes, audio);
    link = mediaLink(media, event.applicationUrl, audio);
    posterUrl = imageUrl(media, 'poster');
    fanartUrl = imageUrl(media, 'fanart');
  }

  switch (event.type) {
    case 'test':
      fields.push({
        name: 'Message',
        value: event.message ?? `This is a test notification from ${event.instanceName}.`,
      });
      break;
    case 'grab':
      fields.push(...releaseFields(event.release), ...downloadFields(event));
      break;
    case 'import':
    case 'upgrade': {
      fields.push(
        { name: 'Quality', value: qualityLabel(event.file.quality, event.file.qualityVersion), inline: true },
        { name: 'Size', value: formatBytes(event.file.size), inline: true },
      );
      if (event.file.releaseGroup) fields.push({ name: 'Group', value: event.file.releaseGroup, inline: true });
      if (event.file.languages.length > 0) {
        fields.push({ name: 'Languages', value: event.file.languages.join(', '), inline: true });
      }
      const mi = event.file.mediaInfo;
      if (mi && (mi.videoCodec || mi.audioCodec)) {
        const codecs = [mi.videoCodec, mi.audioCodec && mi.audioChannels ? `${mi.audioCodec} ${mi.audioChannels}` : mi.audioCodec]
          .filter((c): c is string => Boolean(c))
          .join(' / ');
        fields.push({ name: 'Codecs', value: codecs, inline: true });
      }
      if (mi && mi.subtitleLanguages.length > 0) {
        fields.push({ name: 'Subtitles', value: mi.subtitleLanguages.join(', '), inline: true });
      }
      if (event.release) {
        if (event.release.customFormats.length > 0) {
          fields.push({ name: 'Custom Formats', value: event.release.customFormats.join(', ') });
          fields.push({ name: 'Custom Format Score', value: String(event.release.customFormatScore), inline: true });
        }
        fields.push({ name: 'Release', value: event.release.title });
      } else if (event.file.sceneName) {
        fields.push({ name: 'Release', value: event.file.sceneName });
      }
      fields.push({ name: 'Path', value: event.file.relativePath });
      if (event.type === 'upgrade') {
        fields.push({
          name: 'Replaced',
          value: event.oldFiles
            .map((f) => `${f.relativePath} (${qualityLabel(f.quality, f.qualityVersion)})`)
            .join('\n'),
        });
      }
      fields.push(...downloadFields(event));
      break;
    }
    case 'rename':
      fields.push({
        name: 'Renamed',
        value: event.renamedFiles.map((f) => `${f.previousRelativePath} -> ${f.relativePath}`).join('\n'),
      });
      break;
    case 'mediaAdded':
      fields.push({ name: 'Added Via', value: event.addMethod, inline: true });
      fields.push({ name: 'Path', value: event.media.path });
      break;
    case 'mediaDeleted':
      fields.push({ name: 'Files Deleted', value: event.deletedFiles ? 'Yes' : 'No', inline: true });
      fields.push({ name: 'Path', value: event.media.path });
      break;
    case 'fileDeleted':
      fields.push({ name: 'Reason', value: event.reason, inline: true });
      fields.push({ name: 'Quality', value: qualityLabel(event.file.quality, event.file.qualityVersion), inline: true });
      fields.push({ name: 'Path', value: event.file.relativePath });
      break;
    case 'healthIssue':
    case 'healthRestored':
      fields.push({ name: 'Source', value: event.health.source, inline: true });
      fields.push({ name: 'Level', value: event.health.status, inline: true });
      fields.push({ name: 'Message', value: event.health.message });
      if (event.health.wikiUrl) fields.push({ name: 'More Info', value: event.health.wikiUrl });
      break;
    case 'applicationUpdate':
      fields.push({ name: 'Previous Version', value: event.previousVersion, inline: true });
      fields.push({ name: 'New Version', value: event.newVersion, inline: true });
      if (event.message) fields.push({ name: 'Notes', value: event.message });
      break;
    case 'manualInteractionRequired':
      if (!media) title = event.downloadTitle;
      fields.push({ name: 'Download', value: event.downloadTitle });
      fields.push({ name: 'Status', value: event.downloadStatus, inline: true });
      if (event.release) {
        fields.push({ name: 'Quality', value: qualityLabel(event.release.quality, event.release.qualityVersion), inline: true });
        fields.push({ name: 'Size', value: formatBytes(event.release.size), inline: true });
      }
      for (const status of event.statusMessages) {
        fields.push({ name: status.title, value: status.messages.join('\n') || '-' });
      }
      fields.push(...downloadFields(event));
      break;
    case 'subtitleDownloaded': {
      const flags = [event.subtitle.forced ? 'forced' : '', event.subtitle.hearingImpaired ? 'HI' : ''].filter(Boolean);
      fields.push({
        name: 'Language',
        value: flags.length > 0 ? `${event.subtitle.language} (${flags.join(', ')})` : event.subtitle.language,
        inline: true,
      });
      fields.push({ name: 'Provider', value: event.subtitle.provider, inline: true });
      if (event.subtitle.score !== undefined) fields.push({ name: 'Score', value: String(event.subtitle.score), inline: true });
      fields.push({ name: 'Path', value: event.subtitle.path });
      break;
    }
    case 'requestsDigest': {
      title = `${event.totalPendingRequests} pending request${event.totalPendingRequests === 1 ? '' : 's'}, ${event.totalOpenIssues} open issue${event.totalOpenIssues === 1 ? '' : 's'}`;
      if (event.pendingRequests.length > 0) {
        const lines = event.pendingRequests.map(
          (r) => `${r.title}${r.year ? ` (${r.year})` : ''}${r.is4k ? ' [4K]' : ''} - ${r.requestedBy}`,
        );
        if (event.totalPendingRequests > lines.length) lines.push(`...and ${event.totalPendingRequests - lines.length} more`);
        fields.push({ name: 'Pending Requests', value: lines.join('\n') });
      }
      if (event.openIssues.length > 0) {
        const lines = event.openIssues.map((i) => `${i.title} (${i.issueType}) - ${i.reportedBy}`);
        if (event.totalOpenIssues > lines.length) lines.push(`...and ${event.totalOpenIssues - lines.length} more`);
        fields.push({ name: 'Open Issues', value: lines.join('\n') });
      }
      if (base) {
        link = `${base}/requests?filter=pending`;
        actions.push({ label: 'Review requests', url: link });
        if (event.totalOpenIssues > 0) actions.push({ label: 'Open issues', url: `${base}/issues?filter=open` });
      }
      break;
    }
    case 'retention': {
      const parts = [
        `${event.totalStaged} staged`,
        `${event.totalApplied} applied`,
        ...(event.totalFailed > 0 ? [`${event.totalFailed} failed`] : []),
      ];
      title = parts.join(', ');
      const line = (l: RetentionLine): string =>
        `${l.title}${l.year ? ` (${l.year})` : ''} - ${l.rule}: ${RETENTION_ACTION_LABELS[l.action]}` +
        (l.applyAfter ? ` after ${l.applyAfter.slice(0, 10)}` : '') +
        (l.error ? ` (${truncate(l.error, 120)})` : '');
      const list = (name: string, lines: RetentionLine[], total: number): void => {
        if (lines.length === 0) return;
        const out = lines.map(line);
        if (total > out.length) out.push(`...and ${total - out.length} more`);
        fields.push({ name, value: out.join('\n') });
      };
      list('Staged', event.staged, event.totalStaged);
      list('Applied', event.applied, event.totalApplied);
      list('Failed', event.failed, event.totalFailed);
      if (event.freedBytes > 0) fields.push({ name: 'Freed', value: formatBytes(event.freedBytes), inline: true });
      if (base) {
        link = `${base}/retention`;
        actions.push({ label: 'Review candidates', url: link });
      }
      break;
    }
    case 'healthScan': {
      title = `${event.totalNew} new problem${event.totalNew === 1 ? '' : 's'} in ${event.filesChecked} checked file${event.filesChecked === 1 ? '' : 's'}`;
      const out = event.findings.map((f) => `${f.title}: ${truncate(f.details, 160)}`);
      if (event.totalNew > out.length) out.push(`...and ${event.totalNew - out.length} more`);
      if (out.length > 0) fields.push({ name: 'Problems', value: out.join('\n') });
      fields.push({ name: 'Open', value: String(event.totalOpen), inline: true });
      if (base) {
        link = `${base}/library/hygiene?tab=health`;
        actions.push({ label: 'Review problems', url: link });
      }
      break;
    }
    case 'fileTranscoded':
      fields.push({ name: 'Action', value: event.action, inline: true });
      if (event.rule) fields.push({ name: 'Rule', value: event.rule, inline: true });
      fields.push({ name: 'Size', value: `${formatBytes(event.sizeBefore)} -> ${formatBytes(event.sizeAfter)}`, inline: true });
      fields.push({ name: 'Path', value: event.file.relativePath });
      break;
    case 'downloadStalled':
    case 'importProblem':
    case 'downloadUpdate':
      title = event.download.title;
      if (event.message) fields.push({ name: 'Message', value: truncate(event.message, 500) });
      if (event.type === 'downloadUpdate') fields.push({ name: 'Event', value: timelineTypeLabel(event.timelineType), inline: true });
      fields.push({ name: 'Download Id', value: event.download.downloadId, inline: true });
      if (base) {
        link = `${base}/activity/queue`;
        actions.push({ label: 'Open queue', url: link });
      }
      break;
    case 'killSwitch': {
      title = `${event.pausedCount} download${event.pausedCount === 1 ? '' : 's'} paused`;
      if (event.reason) fields.push({ name: 'Reason', value: truncate(event.reason, 300) });
      fields.push({ name: 'Since', value: event.since, inline: true });
      if (event.pausedMinutes !== undefined) {
        fields.push({ name: 'Paused For', value: formatDuration(event.pausedMinutes * 60_000), inline: true });
      }
      if (event.titles.length > 0) {
        const lines = [...event.titles];
        if (event.pausedCount > lines.length) lines.push(`...and ${event.pausedCount - lines.length} more`);
        fields.push({ name: 'Downloads', value: lines.join('\n') });
      }
      break;
    }
    case 'killSwitchResumed':
      title = `${event.resumedCount} download${event.resumedCount === 1 ? '' : 's'} resumed`;
      fields.push({ name: 'Paused For', value: formatDuration(event.durationMs), inline: true });
      if (event.reason) fields.push({ name: 'Reason', value: truncate(event.reason, 300) });
      break;
    case 'diskSpaceLow':
      title = truncate(event.health.message, 200);
      fields.push({ name: 'Source', value: event.health.source, inline: true });
      fields.push({ name: 'Level', value: event.health.status, inline: true });
      fields.push({ name: 'Message', value: event.health.message });
      if (event.health.wikiUrl) fields.push({ name: 'More Info', value: event.health.wikiUrl });
      break;
    case 'dailySummary': {
      const s = event.summary;
      const c = s.counts;
      title = `${c.grabbed} grabbed, ${c.imported} imported, ${c.failed} failed`;
      fields.push({
        name: 'Downloads',
        value: [
          `Grabbed: ${c.grabbed}`,
          `Imported: ${c.imported}`,
          `Failed: ${c.failed}`,
          `Stalled: ${c.stalled}`,
          `Recovered: ${c.recovered}`,
          `Replaced: ${c.replaced}`,
        ].join('\n'),
      });
      if (s.killSwitch.pauses > 0) {
        fields.push({
          name: 'Kill Switch',
          value: `${s.killSwitch.pauses} pause${s.killSwitch.pauses === 1 ? '' : 's'}, ${formatDuration(s.killSwitch.totalMs)} in total`,
        });
      }
      if (s.disk.length > 0) {
        fields.push({
          name: 'Disk Free',
          value: s.disk
            .map((d) => {
              if (d.freeBytes === null) return `${d.path}: unknown`;
              const change = d.changeBytes === null || d.changeBytes === 0 ? '' : ` (${d.changeBytes > 0 ? '+' : '-'}${formatBytes(Math.abs(d.changeBytes))})`;
              return `${d.path}: ${formatBytes(d.freeBytes)}${change}`;
            })
            .join('\n'),
        });
      }
      if (s.problems.length > 0) {
        fields.push({
          name: 'Problems',
          value: s.problems
            .slice(0, 5)
            .map((p) => `${timelineTypeLabel(p.type)}: ${p.title}${p.message ? ` (${truncate(p.message, 120)})` : ''}`)
            .join('\n'),
        });
      }
      fields.push({
        name: 'Health',
        value: s.healthIssues.length === 0 ? 'No issues' : s.healthIssues.map((h) => `${h.status}: ${truncate(h.message, 160)}`).join('\n'),
      });
      const dl = s.downloading;
      fields.push({
        name: 'Downloading',
        value:
          dl.count === 0
            ? 'Nothing'
            : [
                ...dl.items.map((d) => `${d.title} (${Math.round(d.progress * 100)}%)`),
                ...(dl.count > dl.items.length ? [`...and ${dl.count - dl.items.length} more`] : []),
              ].join('\n'),
      });
      if (base) {
        link = `${base}/activity/history`;
        actions.push({ label: 'Open history', url: link });
      }
      break;
    }
    case 'heldAlerts': {
      title = `${event.events.length} alert${event.events.length === 1 ? '' : 's'} held during quiet hours`;
      const lines = event.events.slice(0, 20).map((inner) => {
        const f = formatEvent(inner);
        return f.title === f.subject ? f.subject : `${f.subject}: ${f.title}`;
      });
      if (event.events.length > lines.length) lines.push(`...and ${event.events.length - lines.length} more`);
      fields.push({ name: 'Alerts', value: lines.join('\n') });
      break;
    }
    case 'issueCreated':
    case 'issueUpdated': {
      const issue = event.issue;
      if (base) {
        link = `${base}/issues/${issue.id}`;
        actions.push({ label: 'View issue', url: link });
      }
      fields.push({ name: 'Reported By', value: issue.reportedBy.username, inline: true });
      fields.push({ name: 'Status', value: issue.status, inline: true });
      if (issue.problemSeason && issue.problemSeason > 0) {
        fields.push({ name: 'Affected Season', value: String(issue.problemSeason), inline: true });
        if (issue.problemEpisode && issue.problemEpisode > 0) {
          fields.push({ name: 'Affected Episode', value: String(issue.problemEpisode), inline: true });
        }
      }
      fields.push({ name: 'Issue', value: truncate(issue.message, 500) });
      if (issue.comment) fields.push({ name: `Comment from ${issue.comment.user.username}`, value: truncate(issue.comment.message, 500) });
      break;
    }
    case 'requestDeclined':
      if (event.reason) fields.push({ name: 'Reason', value: truncate(event.reason, 500) });
      fields.push({ name: 'Requested By', value: event.request.requestedBy.username, inline: true });
      person = personOf(event.request.requestedBy);
      if (base) link = `${base}/requests/${event.request.id}`;
      break;
    case 'requestCreated':
    case 'requestApproved':
    case 'requestAvailable': {
      person = personOf(event.request.requestedBy);
      const links = requestLinks(base, event.request.id);
      if (links) {
        link = links.view;
        if (event.type === 'requestCreated' && event.request.status === 'pending') {
          actions.push({ label: 'Approve', url: links.approve }, { label: 'Decline', url: links.decline });
        }
        actions.push({ label: 'View request', url: links.view });
      }
      fields.push({ name: 'Requested By', value: event.request.requestedBy.username, inline: true });
      fields.push({ name: 'Status', value: event.request.status, inline: true });
      if (event.request.seasons && event.request.seasons.length > 0) {
        fields.push({ name: 'Seasons', value: event.request.seasons.join(', '), inline: true });
      }
      if (event.request.is4k) fields.push({ name: '4K', value: 'Yes', inline: true });
      break;
    }
  }

  if (media) fields.push(...audioFields(event));

  if (media?.overview && (event.type === 'grab' || event.type === 'mediaAdded' || event.type.startsWith('request'))) {
    fields.push({ name: 'Overview', value: truncate(media.overview, 300) });
  }

  const bodyLines = [subject, ...fields.map((f) => `${f.name}: ${f.value}`)];
  if (actions.length > 0) bodyLines.push(...actions.map((a) => `${a.label}: ${a.url}`));
  else if (link) bodyLines.push(link);

  const result: FormattedEvent = { subject, title, body: bodyLines.join('\n'), severity, fields };
  if (link) result.link = link;
  if (posterUrl) result.posterUrl = posterUrl;
  if (fanartUrl) result.fanartUrl = fanartUrl;
  if (actions.length > 0) result.actions = actions;
  if (person) result.person = person;
  return result;
}

/** Album/book and the quality to bracket, for music and audiobook headlines. */
export function audioContextOf(event: NotificationEvent): AudioContext {
  if (!('media' in event) || !event.media) return {};
  if (event.media.mediaType !== 'music' && event.media.mediaType !== 'audiobook') return {};
  const quality =
    'file' in event && event.file
      ? event.file.quality
      : 'release' in event && event.release
        ? event.release.quality
        : undefined;
  const ctx: AudioContext = {};
  if ('album' in event && event.album) ctx.album = event.album;
  if ('book' in event && event.book) ctx.book = event.book;
  // The quality bracket is for grabs and imports ("Artist – Album [FLAC]").
  if (quality && (event.type === 'grab' || event.type === 'import' || event.type === 'upgrade')) ctx.quality = quality;
  return ctx;
}

/** Track list (music) and narrator/series lines (audiobooks). */
function audioFields(event: NotificationEvent): FormattedField[] {
  const out: FormattedField[] = [];
  if (!('media' in event) || !event.media) return out;
  if (event.media.mediaType === 'music') {
    const tracks = 'tracks' in event ? (event.tracks ?? []) : [];
    if (tracks.length > 0) {
      const sorted = [...tracks].sort((a, b) => a.mediumNumber - b.mediumNumber || a.trackNumber - b.trackNumber);
      const multi = new Set(sorted.map((t) => t.mediumNumber)).size > 1;
      const lines = sorted.slice(0, 15).map((t) => `${multi ? `${t.mediumNumber}-` : ''}${pad2(t.trackNumber)} ${t.title}`);
      if (sorted.length > lines.length) lines.push(`...and ${sorted.length - lines.length} more`);
      out.push({ name: sorted.length === 1 ? 'Track' : `Tracks (${sorted.length})`, value: lines.join('\n') });
    }
    const album = 'album' in event ? event.album : undefined;
    if (album?.albumType) out.push({ name: 'Type', value: album.albumType, inline: true });
    if (album?.releaseDate) out.push({ name: 'Released', value: album.releaseDate.slice(0, 10), inline: true });
  } else if (event.media.mediaType === 'audiobook') {
    const book = 'book' in event ? event.book : undefined;
    if (book?.seriesTitle) {
      out.push({ name: 'Series', value: book.seriesPosition ? `${book.seriesTitle} #${book.seriesPosition}` : book.seriesTitle, inline: true });
    }
    if (book?.runtimeMs) out.push({ name: 'Runtime', value: formatDuration(book.runtimeMs), inline: true });
  }
  return out;
}

function personOf(user: { username: string; avatar?: string }): NonNullable<FormattedEvent['person']> {
  return user.avatar ? { name: user.username, avatarUrl: user.avatar } : { name: user.username };
}
