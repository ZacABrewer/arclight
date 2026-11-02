import { readFile } from 'node:fs/promises';
import { cueMatchFiles, cueTrackSpans, parseCueSheet, type CueImage, type CueSheet, type CueTrackSpan } from './cue.js';
import type { AudioGroup, AudioScanFile } from './scan-audio.js';
import type { MatchFile } from './track-match.js';

// Reading the cue sheets of an album group for the importer: every sheet of the group that
// describes the group's audio files is parsed and its tracks turned into spans and virtual
// match files. Sheets that cannot be read, parsed or resolved are skipped (with a reason).

export interface CueGroup {
  /** The sheets that resolved, each with the spans it describes. */
  sheets: Array<{ path: string; sheet: CueSheet; spans: CueTrackSpan[] }>;
  spans: CueTrackSpan[];
  files: MatchFile[];
  /** The group's audio files the sheets cut (the images). */
  images: AudioScanFile[];
}

/** Largest cue sheet read (real ones are a few KB). */
const MAX_CUE_BYTES = 512 * 1024;

/** The group's images as described by its cue sheets; null when no sheet fits the files. */
export async function readCueGroup(group: AudioGroup, read: (path: string) => Promise<Uint8Array> = readFile): Promise<{ cue: CueGroup | null; problems: string[] }> {
  const problems: string[] = [];
  const images: CueImage[] = group.files.map((f) => ({ path: f.path, durationMs: f.tags?.durationMs ?? null, discFromFolder: f.discFromFolder }));
  const sheets: CueGroup['sheets'] = [];
  const claimed = new Set<string>();
  const cues = group.extras.filter((e) => e.kind === 'cue').sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  for (const extra of cues) {
    let sheet: CueSheet;
    try {
      if (extra.sizeBytes > MAX_CUE_BYTES) throw new Error('too large');
      sheet = parseCueSheet(await read(extra.path));
    } catch (err) {
      problems.push(`${extra.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // Images another sheet already describes (one sheet per encoding of the same rip) count once.
    const spans = cueTrackSpans(sheet, images.filter((i) => !claimed.has(i.path)));
    if (!spans) {
      problems.push(`${extra.relativePath}: does not describe the audio files next to it`);
      continue;
    }
    for (const s of spans) claimed.add(s.imagePath);
    sheets.push({ path: extra.path, sheet, spans });
  }
  if (sheets.length === 0) return { cue: null, problems };
  const spans = sheets.flatMap((s) => s.spans);
  const files = sheets.flatMap((s) => cueMatchFiles(s.sheet, s.spans, images));
  return { cue: { sheets, spans, files, images: group.files.filter((f) => claimed.has(f.path)) }, problems };
}
