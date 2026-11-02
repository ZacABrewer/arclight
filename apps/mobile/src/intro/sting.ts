// The intro sound, played with the Web Audio API.
//
// iOS: Capacitor leaves the app's AVAudioSession alone, and WebKit plays Web Audio (when no
// <audio>/<video> element is playing) in the "ambient" category: it is silenced by the silent
// switch and mixes with whatever the user is listening to instead of stopping it. An <audio>
// element would switch WebKit to the "playback" category and ignore the silent switch, so it is
// not used. Where the Audio Session API exists (iOS 17+), the type is set to "ambient" explicitly.
// Android: plays on the media stream at media volume. Capacitor turns off the user-gesture
// requirement for media on both platforms, so the sound can start without a tap.

export interface Sting {
  /** Start playing now; `offset` skips into the sound (seconds). */
  start(offset?: number): void;
  stop(): void;
}

type AudioCtor = typeof AudioContext;

/** Loads and decodes the sound; null when Web Audio is missing or it does not arrive within `timeoutMs`. */
export async function loadSting(url: string, timeoutMs = 400): Promise<Sting | null> {
  const Ctor: AudioCtor | undefined = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'ambient';
  } catch {
    /* not supported */
  }
  let ctx: AudioContext | null = null;
  const load = (async () => {
    ctx = new Ctor();
    const data = await (await fetch(url)).arrayBuffer();
    return ctx.decodeAudioData(data);
  })();
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const buffer = await Promise.race([load, timeout]).catch(() => null);
  const audio = ctx as AudioContext | null;
  if (!buffer || !audio) {
    void audio?.close().catch(() => undefined);
    return null;
  }
  let source: AudioBufferSourceNode | null = null;
  return {
    start(offset = 0) {
      if (source || offset >= buffer.duration || audio.state === 'closed') return;
      try {
        void audio.resume().catch(() => undefined);
        source = audio.createBufferSource();
        source.buffer = buffer;
        source.connect(audio.destination);
        source.start(0, Math.max(0, offset));
      } catch {
        source = null; // no sound, the animation still plays
      }
    },
    stop() {
      try {
        source?.stop();
      } catch {
        /* already stopped */
      }
      source = null;
      void audio.close().catch(() => undefined);
    },
  };
}
