import { useEffect, useRef, type ReactNode } from 'react';
import type { PlayableItem, VideoQuality } from '@arclight/shared';
import { Icon } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { VideoArt } from './cards.js';
import { useShow } from './api.js';
import { audioTrackLabel, episodeCode, resumePoint, subtitleTrackLabel, watchedShare } from './format.js';
import { QUALITIES, SPEEDS, type VideoState } from './playback.js';
import { seasonTitle } from './show-page.js';

// The player's side panels (Audio & subtitles, Episodes, Settings). They live inside the
// player's own element so they stay visible in full screen; Esc (or Back on a remote) closes
// them and focus returns to the button that opened them.

export type PanelId = 'tracks' | 'episodes' | 'settings';

export function Panel({ title, onClose, children, id }: { title: string; onClose: () => void; children: ReactNode; id: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[aria-checked="true"], [aria-current="true"], button:not([disabled])');
    first?.focus();
  }, []);
  return (
    <div ref={ref} className="vp-panel" role="dialog" aria-labelledby={`${id}-title`} id={id}>
      <div className="vp-panel__head">
        <h2 className="vp-panel__title" id={`${id}-title`}>
          {title}
        </h2>
        <button type="button" className="vp-btn vp-btn--sm" aria-label={t('common.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="vp-panel__body">{children}</div>
    </div>
  );
}

function Option({ checked, onSelect, label, detail }: { checked: boolean; onSelect: () => void; label: string; detail?: string | null | undefined }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="vp-option" onClick={onSelect}>
      <span className="vp-option__dot" aria-hidden="true" />
      <span className="vp-option__text">
        <span className="vp-option__label">{label}</span>
        {detail ? <span className="vp-option__detail">{detail}</span> : null}
      </span>
    </button>
  );
}

export function TracksPanel({
  item,
  state,
  subtitleOffsetMs,
  onAudio,
  onSubtitle,
  onOffset,
  onClose,
}: {
  item: PlayableItem;
  state: VideoState;
  subtitleOffsetMs: number;
  onAudio: (index: number) => void;
  onSubtitle: (id: string | null) => void;
  onOffset: (ms: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const audio = item.video?.audioTracks ?? [];
  const subs = item.video?.subtitleTracks ?? [];
  return (
    <Panel id="vp-tracks" title={t('player.video.audioAndSubtitles')} onClose={onClose}>
      <section className="vp-group" aria-labelledby="vp-audio-h">
        <h3 className="vp-group__title" id="vp-audio-h">
          {t('player.video.audio')}
        </h3>
        <div role="radiogroup" aria-labelledby="vp-audio-h" className="vp-options">
          {audio.length === 0 ? <p className="vp-muted">{t('player.video.noAudioTracks')}</p> : null}
          {audio.map((a) => {
            const l = audioTrackLabel(a);
            return <Option key={a.index} checked={state.audioTrack === a.index} onSelect={() => onAudio(a.index)} label={l.name} detail={l.detail} />;
          })}
        </div>
      </section>
      <section className="vp-group" aria-labelledby="vp-subs-h">
        <h3 className="vp-group__title" id="vp-subs-h">
          {t('player.video.subtitles')}
        </h3>
        <div role="radiogroup" aria-labelledby="vp-subs-h" className="vp-options">
          <Option checked={state.subtitle === null} onSelect={() => onSubtitle(null)} label={t('player.video.subtitlesOff')} />
          {subs.map((s) => {
            const l = subtitleTrackLabel(s);
            return <Option key={s.id} checked={state.subtitle === s.id} onSelect={() => onSubtitle(s.id)} label={l.name} detail={l.detail} />;
          })}
        </div>
        {state.subtitle ? (
          <div className="vp-stepper" role="group" aria-label={t('player.video.subtitleOffset')}>
            <span className="vp-stepper__label">{t('player.video.subtitleOffset')}</span>
            <button type="button" className="vp-btn vp-btn--sm" aria-label={t('player.video.subtitleEarlier')} onClick={() => onOffset(subtitleOffsetMs - 250)}>
              <Icon name="minus" />
            </button>
            <output className="vp-stepper__value" aria-live="polite">
              {t('player.video.seconds', { value: (subtitleOffsetMs / 1000).toFixed(2) })}
            </output>
            <button type="button" className="vp-btn vp-btn--sm" aria-label={t('player.video.subtitleLater')} onClick={() => onOffset(subtitleOffsetMs + 250)}>
              <Icon name="plus" />
            </button>
          </div>
        ) : null}
      </section>
    </Panel>
  );
}

export function SettingsPanel({
  item,
  state,
  onQuality,
  onSpeed,
  onVersion,
  onClose,
}: {
  item: PlayableItem;
  state: VideoState;
  onQuality: (q: VideoQuality) => void;
  onSpeed: (s: number) => void;
  onVersion: (mediaFileId: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const versions = item.versions ?? [];
  const reasons = state.session?.reasons ?? [];
  return (
    <Panel id="vp-settings" title={t('player.video.settings')} onClose={onClose}>
      {versions.length > 1 ? (
        <section className="vp-group" aria-labelledby="vp-version-h">
          <h3 className="vp-group__title" id="vp-version-h">
            {t('player.video.version')}
          </h3>
          <div role="radiogroup" aria-labelledby="vp-version-h" className="vp-options">
            {versions.map((v) => (
              <Option key={v.mediaFileId} checked={state.mediaFileId === v.mediaFileId} onSelect={() => onVersion(v.mediaFileId)} label={v.label} />
            ))}
          </div>
        </section>
      ) : null}
      <section className="vp-group" aria-labelledby="vp-quality-h">
        <h3 className="vp-group__title" id="vp-quality-h">
          {t('player.video.quality')}
        </h3>
        <div role="radiogroup" aria-labelledby="vp-quality-h" className="vp-options">
          {QUALITIES.map((q) => (
            <Option key={q} checked={state.quality === q} onSelect={() => onQuality(q)} label={t(`player.video.qualityOption.${q}`)} />
          ))}
        </div>
      </section>
      <section className="vp-group" aria-labelledby="vp-speed-h">
        <h3 className="vp-group__title" id="vp-speed-h">
          {t('player.video.speed')}
        </h3>
        <div role="radiogroup" aria-labelledby="vp-speed-h" className="vp-options vp-options--inline">
          {SPEEDS.map((s) => (
            <Option key={s} checked={state.speed === s} onSelect={() => onSpeed(s)} label={s === 1 ? t('player.video.speedNormal') : `${s}×`} />
          ))}
        </div>
      </section>
      {state.session ? (
        <section className="vp-group" aria-labelledby="vp-stream-h">
          <h3 className="vp-group__title" id="vp-stream-h">
            {t('player.video.stream')}
          </h3>
          <p className="vp-muted">{t(`player.video.method.${state.session.method}`)}</p>
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

export function EpisodesPanel({ item, onPick, onClose }: { item: PlayableItem; onPick: (itemKey: string) => void; onClose: () => void }) {
  const t = useT();
  const show = useShow(item.seriesId ?? null);
  const season = show.data?.seasons.find((s) => s.seasonNumber === item.seasonNumber) ?? show.data?.seasons[0];
  return (
    <Panel id="vp-episodes" title={season ? seasonTitle(season) : t('player.video.episodes')} onClose={onClose}>
      {show.isPending ? <p className="vp-muted">{t('player.browse.loading')}</p> : null}
      {show.isError ? <p className="vp-muted">{t('player.video.showFailed')}</p> : null}
      {season ? (
        <>
          <p className="vp-eyebrow">{t('player.video.episodesWatched', { played: season.playedCount, count: season.episodeCount })}</p>
          <ol className="vp-episodes">
            {season.episodes.map((e) => {
              const current = e.itemKey === item.itemKey;
              const title = e.title ?? t('player.video.episodeN', { n: e.episodeNumber });
              return (
                <li key={e.itemKey}>
                  <button type="button" className={cx('vp-episode', current && 'vp-episode--current')} aria-current={current || undefined} onClick={() => onPick(e.itemKey)}>
                    <span className="vp-episode__thumb">
                      <VideoArt src={e.thumbUrl} shape="wide" progress={watchedShare(e.progress, e.played)} corner={e.played ? { kind: 'done', label: t('player.video.watched') } : null} />
                    </span>
                    <span className="vp-episode__text">
                      <span className="vp-episode__code">{episodeCode(e.seasonNumber, e.episodeNumber)}</span>
                      <span className="vp-episode__title">{title}</span>
                      {resumePoint(e.progress) !== null ? <span className="vp-episode__code">{t('player.video.inProgress')}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </Panel>
  );
}
