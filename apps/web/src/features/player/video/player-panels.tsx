import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { PlayableItem, VideoAudioTrack, VideoHlsRung, VideoQuality, VideoSubtitleTrack } from '@arclight/shared';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { Art, ProgressBar } from '../redesign/tiles.js';
import { useShow } from './api.js';
import { channelLabel, languageName, runtimeLabel, watchedShare } from './format.js';
import { QUALITIES, SPEEDS, type VideoState } from './playback.js';
import { seasonTitle } from './show-page.js';

// The player's side panels (redesign spec §5.4, §5.7 and the template's Audio & Subtitles
// panel): Audio & Subtitles (440), Episodes (520) and the playback settings (quality, speed,
// version; not in the design, kept from 0.22). They live inside the player's own element so
// they stay visible in full screen. Focus is trapped; Back / Esc closes them and focus returns
// to the button that opened them (the page handles the key).

export type PanelId = 'tracks' | 'episodes' | 'settings';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab and Shift+Tab stay inside `el`. */
function trapTab(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (!items.length) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function Panel({ title, children, id, wide }: { title: string; children: ReactNode; id: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[aria-checked="true"], [aria-current="true"], button:not([disabled])');
    first?.focus();
  }, []);
  return (
    <div ref={ref} className={cx('vp-panel', wide && 'vp-panel--wide')} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} id={id} onKeyDown={trapTab}>
      <h2 className="vp-panel__title" id={`${id}-title`}>
        {title}
      </h2>
      <div className="vp-panel__body">{children}</div>
    </div>
  );
}

function Option({ checked, onSelect, label }: { checked: boolean; onSelect: () => void; label: string }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="vp-option" onClick={onSelect}>
      <span className="vp-option__label">{label}</span>
      <span className="vp-option__check" aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
    </button>
  );
}

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="vp-group" aria-labelledby={id}>
      <h3 className="vp-group__title" id={id}>
        {title}
      </h3>
      <div role="radiogroup" aria-labelledby={id} className="vp-options">
        {children}
      </div>
    </section>
  );
}

type Translate = ReturnType<typeof useT>;

const isAtmos = (a: VideoAudioTrack) => /atmos/i.test(a.title ?? '');

/** "English 5.1 Atmos", "English Stereo", "Spanish"; the track title when the language is unknown (§5.7). */
export function audioLabel(a: VideoAudioTrack, t: Translate): string {
  const lang = a.language ? languageName(a.language) : null;
  const known = lang && lang.toLowerCase() !== (a.language ?? '').toLowerCase() ? lang : null;
  const base = known ?? a.title ?? lang ?? t('player.video.trackNumber', { n: a.index + 1 });
  return [base, channelLabel(a.channels), isAtmos(a) ? t('player.video.atmos') : null].filter(Boolean).join(' ');
}

/** "English", "English (SDH)", "English (Forced)" (§5.7). */
export function subtitleLabel(s: VideoSubtitleTrack, t: Translate): string {
  let label = languageName(s.language) ?? s.title ?? t('player.video.trackNumber', { n: 1 });
  if (s.hearingImpaired) label = t('player.video.sdhLabel', { name: label });
  if (s.forced) label = t('player.video.forcedLabel', { name: label });
  return label;
}

/** Same label twice (two English 5.1 tracks): add the track title or the number to tell them apart. */
function distinct<T>(items: readonly T[], label: (x: T) => string, extra: (x: T, i: number) => string): string[] {
  const labels = items.map(label);
  return labels.map((l, i) => (labels.indexOf(l) !== labels.lastIndexOf(l) ? `${l} · ${extra(items[i]!, i)}` : l));
}

export function TracksPanel({ item, state, onAudio, onSubtitle }: { item: PlayableItem; state: VideoState; onAudio: (track: VideoAudioTrack) => void; onSubtitle: (track: VideoSubtitleTrack | null) => void }) {
  const t = useT();
  const audio = item.video?.audioTracks ?? [];
  const subs = item.video?.subtitleTracks ?? [];
  const audioLabels = distinct(audio, (a) => audioLabel(a, t), (a) => a.title ?? a.codec.toUpperCase());
  const subLabels = distinct(subs, (s) => subtitleLabel(s, t), (s, i) => s.title ?? String(i + 1));
  return (
    <Panel id="vp-tracks" title={t('player.video.audioAndSubtitles')}>
      <Group id="vp-audio-h" title={t('player.video.audio')}>
        {audio.length === 0 ? <p className="vp-muted">{t('player.video.noAudioTracks')}</p> : null}
        {audio.map((a, i) => (
          <Option key={a.index} checked={state.audioTrack === a.index} onSelect={() => onAudio(a)} label={audioLabels[i]!} />
        ))}
      </Group>
      <Group id="vp-subs-h" title={t('player.video.subtitles')}>
        <Option checked={state.subtitle === null} onSelect={() => onSubtitle(null)} label={t('player.video.subtitlesOff')} />
        {subs.map((s, i) => (
          <Option key={s.id} checked={state.subtitle === s.id} onSelect={() => onSubtitle(s)} label={subLabels[i]!} />
        ))}
      </Group>
    </Panel>
  );
}

/** Quality menu label of an HLS rung: "Original" for the source copy, else its height ("1080p"). */
export function rungLabel(t: Translate, rung: VideoHlsRung): string {
  return rung.id === 'src' ? t('player.video.qualityOption.original') : `${rung.height}p`;
}

export function SettingsPanel({
  item,
  state,
  onQuality,
  onRung,
  onSpeed,
  onVersion,
}: {
  item: PlayableItem;
  state: VideoState;
  onQuality: (q: VideoQuality) => void;
  /** HLS: pin a rung of the session (null: Auto). */
  onRung?: (rungId: string | null) => void;
  onSpeed: (s: number) => void;
  onVersion: (mediaFileId: number) => void;
}) {
  const t = useT();
  const versions = item.versions ?? [];
  const reasons = state.session?.reasons ?? [];
  // HLS with level control: the menu is the session's ladder (Auto = ABR), switched in place.
  const rungs = state.levelControl && onRung ? (state.session?.hls?.rungs ?? []) : [];
  return (
    <Panel id="vp-settings" title={t('player.video.settings')}>
      {versions.length > 1 ? (
        <Group id="vp-version-h" title={t('player.video.version')}>
          {versions.map((v) => (
            <Option key={v.mediaFileId} checked={state.mediaFileId === v.mediaFileId} onSelect={() => onVersion(v.mediaFileId)} label={v.label} />
          ))}
        </Group>
      ) : null}
      <Group id="vp-quality-h" title={t('player.video.quality')}>
        {rungs.length ? (
          <>
            <Option checked={state.pinnedRung === null} onSelect={() => onRung?.(null)} label={t('player.video.qualityOption.auto')} />
            {rungs.map((r) => (
              <Option key={r.id} checked={state.pinnedRung === r.id} onSelect={() => onRung?.(r.id)} label={rungLabel(t, r)} />
            ))}
          </>
        ) : (
          QUALITIES.map((q) => <Option key={q} checked={state.quality === q} onSelect={() => onQuality(q)} label={t(`player.video.qualityOption.${q}`)} />)
        )}
      </Group>
      <Group id="vp-speed-h" title={t('player.video.speed')}>
        {SPEEDS.map((s) => (
          <Option key={s} checked={state.speed === s} onSelect={() => onSpeed(s)} label={s === 1 ? t('player.video.speedNormal') : `${s}×`} />
        ))}
      </Group>
      {state.session ? (
        <section className="vp-group" aria-labelledby="vp-stream-h">
          <h3 className="vp-group__title" id="vp-stream-h">
            {t('player.video.stream')}
          </h3>
          <p className="vp-muted vp-group__text">{state.session.delivery === 'hls' ? `${t('player.video.method.hls')} · ${t(`player.video.method.${state.session.method}`)}` : t(`player.video.method.${state.session.method}`)}</p>
          {reasons.length ? (
            <ul className="vp-reasons">
              {reasons.map((r) => (
                <li key={r}>{t(`player.video.reason.${r}`)}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </Panel>
  );
}

/** §5.4: season chips, then the episodes (160x90 still with progress, "E5 · Title", runtime, 2-line overview). */
export function EpisodesPanel({ item, onPick }: { item: PlayableItem; onPick: (itemKey: string) => void }) {
  const t = useT();
  const show = useShow(item.seriesId ?? null);
  const seasons = show.data?.seasons ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  const season = seasons.find((s) => s.seasonNumber === (picked ?? item.seasonNumber)) ?? seasons[0];
  const seed = show.data?.title ?? item.context ?? item.title;
  return (
    <Panel id="vp-episodes" title={t('player.video.episodes')} wide>
      {show.isPending ? <p className="vp-muted">{t('player.browse.loading')}</p> : null}
      {show.isError ? <p className="vp-muted">{t('player.video.showFailed')}</p> : null}
      {seasons.length > 1 ? (
        <div className="vp-chips" role="group" aria-label={t('player.video.seasons')}>
          {seasons.map((s) => (
            <button key={s.seasonNumber} type="button" className="vp-chip" aria-pressed={s === season} onClick={() => setPicked(s.seasonNumber)}>
              {seasonTitle(s)}
            </button>
          ))}
        </div>
      ) : null}
      {season ? (
        <ol className="vp-episodes">
          {season.episodes.map((e) => {
            const current = e.itemKey === item.itemKey;
            const title = e.title ?? t('player.video.episodeN', { n: e.episodeNumber });
            const share = watchedShare(e.progress, e.played);
            return (
              <li key={e.itemKey}>
                <button type="button" className={cx('vp-episode', current && 'is-current')} aria-current={current || undefined} onClick={() => onPick(e.itemKey)}>
                  <Art image={e.thumbUrl} seed={seed} shift={e.episodeNumber * 14 + e.seasonNumber * 30} className="vp-episode__thumb">
                    <ProgressBar value={share > 0 && share < 1 ? share : null} className="vp-episode__progress" />
                  </Art>
                  <span className="vp-episode__text">
                    {current ? <span className="vp-episode__now">{t('player.video.nowPlaying')}</span> : null}
                    <span className="vp-episode__title">{t('player.video.episodeLine', { episode: e.episodeNumber, title })}</span>
                    {runtimeLabel(e.runtimeMinutes) ? <span className="vp-episode__runtime">{runtimeLabel(e.runtimeMinutes)}</span> : null}
                    {e.overview ? <span className="vp-episode__overview">{e.overview}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </Panel>
  );
}

