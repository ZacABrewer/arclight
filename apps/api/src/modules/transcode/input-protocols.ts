// What ffmpeg and ffprobe may open for an input. Downloaded media is untrusted: a playlist (HLS),
// concat list or similar file disguised as a video would otherwise make ffmpeg fetch URLs (outside
// the torrent VPN, revealing the server's address) or open other protocols. Every input Arclight
// hands to ffmpeg or ffprobe is a local file or a pipe, and nested opens (segments, concat entries)
// inherit the list, so anything else is refused. Generated inputs (lavfi test sources) skip it.

/** The protocols an input may use. */
export const INPUT_PROTOCOLS = 'file,pipe';

/** The input option, placed before each `-i` (ffmpeg) or before the input path (ffprobe). */
export const PROTOCOL_WHITELIST: readonly string[] = ['-protocol_whitelist', INPUT_PROTOCOLS];

/** `-protocol_whitelist file,pipe -i <path>`: one untrusted ffmpeg input. */
export function fileInput(path: string): string[] {
  return [...PROTOCOL_WHITELIST, '-i', path];
}

/** ffprobe arguments with the whitelist placed right before the input path (the last argument). */
export function ffprobeArgs(options: readonly string[], path: string): string[] {
  return [...options, ...PROTOCOL_WHITELIST, path];
}
