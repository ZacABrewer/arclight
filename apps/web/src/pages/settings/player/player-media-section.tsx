import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { PlayerSettings } from '@arclight/shared';
import { request } from '../../../api/client.js';
import { Button, FormRow, FormSection, Select, Toggle } from '../../../arclight/index.js';
import { formatBytes } from '../../../components/media/format.js';
import { useRunJob } from '../../../hooks/jobs.js';
import { useInvalidatingMutation } from '../../../hooks/settings-keys.js';
import { t } from '../../../i18n/index.js';

// Settings → Player → Scrub thumbnails and intros: when scrub-thumbnail sheets are made, the size
// of their cache (and clearing it), intro and credits detection, and a scan of the whole library
// now (the nightly `player-segments` job). The settings themselves save with the page.

/** GET /settings/player/trickplay-cache (admin). */
export const TrickplayCacheSize = z.object({ bytes: z.number(), files: z.number() });
export const trickplayCacheKey = ['settings', 'player', 'trickplay-cache'] as const;
/** The nightly detection job: re-checks every season whose files changed. */
export const PLAYER_SEGMENTS_JOB = 'player-segments';

export const playerMediaApi = {
  cache: () => request('/settings/player/trickplay-cache', TrickplayCacheSize),
  clearCache: () => request('/settings/player/trickplay-cache', null, { method: 'DELETE' }),
};

export function useTrickplayCache() {
  return useQuery({ queryKey: trickplayCacheKey, queryFn: playerMediaApi.cache });
}

export function useClearTrickplayCache() {
  return useInvalidatingMutation(() => playerMediaApi.clearCache(), [trickplayCacheKey], { errorTitle: t('settings.player.trickplay.couldNotClear') });
}

/** "1.2 GB in 340 files", or "Empty". */
export function cacheLine(size: { bytes: number; files: number } | undefined): string {
  if (!size) return '…';
  if (size.files === 0) return t('settings.player.trickplay.cacheEmpty');
  return t('settings.player.trickplay.cacheSize', { size: formatBytes(size.bytes), files: size.files });
}

export interface PlayerMediaSectionProps {
  trickplay: PlayerSettings['trickplay'];
  segmentDetection: boolean;
  /** The saved detection setting: a scan only runs once detection is saved on. */
  savedSegmentDetection: boolean;
  onTrickplay: (v: PlayerSettings['trickplay']) => void;
  onSegmentDetection: (v: boolean) => void;
}

export function PlayerMediaSection({ trickplay, segmentDetection, savedSegmentDetection, onTrickplay, onSegmentDetection }: PlayerMediaSectionProps) {
  const ids = { trickplay: useId(), detection: useId() };
  const cache = useTrickplayCache();
  const clear = useClearTrickplayCache();
  const scan = useRunJob();

  return (
    <FormSection label={t('settings.player.media.title')}>
      <FormRow label={t('settings.player.trickplay.label')} htmlFor={ids.trickplay} caption={t('settings.player.trickplay.caption')}>
        <Select
          id={ids.trickplay}
          value={trickplay}
          options={[
            { value: 'off', label: t('settings.player.trickplay.off') },
            { value: 'on-play', label: t('settings.player.trickplay.onPlay') },
            { value: 'library', label: t('settings.player.trickplay.library') },
          ]}
          onChange={(e) => onTrickplay(e.currentTarget.value as PlayerSettings['trickplay'])}
        />
      </FormRow>
      <FormRow label={t('settings.player.trickplay.cache')} caption={t('settings.player.trickplay.cacheCaption')}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="mk-muted" data-testid="trickplay-cache">
            {cache.isError ? t('settings.player.trickplay.cacheUnknown') : cacheLine(cache.data)}
          </span>
          <Button type="button" size="sm" disabled={clear.isPending || cache.data?.files === 0} loading={clear.isPending} onClick={() => clear.mutate(undefined)}>
            {t('settings.player.trickplay.clear')}
          </Button>
        </div>
      </FormRow>
      <FormRow label={t('settings.player.segments.label')} caption={t('settings.player.segments.caption')} captionInline>
        <Toggle id={ids.detection} aria-label={t('settings.player.segments.label')} checked={segmentDetection} onChange={(e) => onSegmentDetection(e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('settings.player.segments.scan')} caption={savedSegmentDetection ? t('settings.player.segments.scanCaption') : t('settings.player.segments.scanOff')}>
        <div>
          <Button type="button" size="sm" disabled={!savedSegmentDetection || scan.isPending} loading={scan.isPending} onClick={() => scan.mutate(PLAYER_SEGMENTS_JOB)}>
            {t('settings.player.segments.scanNow')}
          </Button>
        </div>
      </FormRow>
    </FormSection>
  );
}
