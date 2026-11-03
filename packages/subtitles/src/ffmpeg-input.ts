// Downloaded media is untrusted: a playlist or concat file disguised as a video would otherwise make
// ffmpeg fetch URLs or open other protocols. Every input here is a local file or a pipe, and nested
// opens inherit the list, so ffmpeg refuses anything else.

/** `-protocol_whitelist file,pipe -i <path>`: one untrusted ffmpeg input. */
export function fileInput(path: string): string[] {
  return ['-protocol_whitelist', 'file,pipe', '-i', path];
}
