/**
 * Turns a `NotificationEvent` into human-readable text once, so every agent says the same
 * thing. Chat agents consume `title` + `body` (or `fields` when they can render columns);
 * webhook and script agents forward the raw event instead.
 */

import type {
  EpisodeInfo,
  MediaInfo,
  NotificationEvent,
  NotificationEventType,
  ReleaseInfo,
} from './types.js';

export type Severity = 'info' | 'success' | 'upgrade' | 'warning' | 'error';

export interface FormattedField {
  name: string;
  value: string;
  /** Hint for agents that lay fields out in columns (Discord). */
  inline?: boolean;
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

/** "Title (Year) - S01E02 - Episode Title" or "Title (Year)" for movies. */
export function mediaHeadline(media: MediaInfo, episodes?: readonly EpisodeInfo[]): string {
  const parts = [mediaLabel(media)];
  const label = episodeLabel(episodes);
  if (label) parts.push(label);
  const titles = episodeTitles(episodes);
  if (titles) parts.push(titles);
  return parts.join(' - ');
}

export function mediaLink(media: MediaInfo, applicationUrl?: string): string | undefined {
  if (applicationUrl) {
    const base = applicationUrl.replace(/\/+$/, '');
    return `${base}/${media.mediaType === 'series' ? 'series' : 'movies'}/${media.id}`;
  }
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
  if (media.mediaType === 'movie') return 'Movie';
  return episodes && episodes.length > 0 ? 'Episode' : 'Series';
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
      return `${event.media.mediaType === 'movie' ? 'Movie' : 'Series'} Renamed`;
    case 'mediaAdded':
      return `${event.media.mediaType === 'movie' ? 'Movie' : 'Series'} Added`;
    case 'mediaDeleted':
      return `${event.media.mediaType === 'movie' ? 'Movie' : 'Series'} Deleted`;
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
      return `${event.media.mediaType === 'movie' ? 'Movie' : 'Series'} Requested`;
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
  }
}

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

  const media = 'media' in event ? event.media : undefined;
  const episodes = 'episodes' in event ? event.episodes : undefined;
  if (media) {
    title = mediaHeadline(media, episodes);
    link = mediaLink(media, event.applicationUrl);
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
    case 'issueCreated':
    case 'issueUpdated': {
      const issue = event.issue;
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
      break;
    case 'requestCreated':
    case 'requestApproved':
    case 'requestAvailable':
      fields.push({ name: 'Requested By', value: event.request.requestedBy.username, inline: true });
      fields.push({ name: 'Status', value: event.request.status, inline: true });
      if (event.request.seasons && event.request.seasons.length > 0) {
        fields.push({ name: 'Seasons', value: event.request.seasons.join(', '), inline: true });
      }
      if (event.request.is4k) fields.push({ name: '4K', value: 'Yes', inline: true });
      break;
  }

  if (media?.overview && (event.type === 'grab' || event.type === 'mediaAdded' || event.type.startsWith('request'))) {
    fields.push({ name: 'Overview', value: truncate(media.overview, 300) });
  }

  const bodyLines = [subject, ...fields.map((f) => `${f.name}: ${f.value}`)];
  if (link) bodyLines.push(link);

  const result: FormattedEvent = { subject, title, body: bodyLines.join('\n'), severity, fields };
  if (link) result.link = link;
  if (posterUrl) result.posterUrl = posterUrl;
  if (fanartUrl) result.fanartUrl = fanartUrl;
  return result;
}
