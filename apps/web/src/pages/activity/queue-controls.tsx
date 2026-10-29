import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { QueueItem, QueueMove, TorrentSpeedMode } from '@arclight/shared';
import { Button, ButtonGroup, Chip, FormRow, Input, SectionLabel, Select, Toggle, Tooltip } from '../../arclight/index.js';
import { errorMessage } from '../../api/client.js';
import { queueApi } from '../../api/queue.js';
import { useBulkResultToast } from '../../components/bulk-actions.js';
import type { BulkAction } from '../../components/media/bulk-bar.js';
import { useForceStartQueueItem, useMoveQueueItem, useQueueItemLimits } from '../../hooks/activity.js';
import { useSetSlowMode, useTorrentStatus } from '../../hooks/torrent.js';
import { formatDateTime, formatRate } from '../../lib/format.js';
import { isPendingItem } from './queue-remove.js';
import { bytesToKibText, kibTextToBytes } from './torrent-extras.js';
import { t } from '../../i18n/index.js';

// Engine control on the Activity page: the slow-mode switch in the header, and per download
// (expanded row) its queue place, force start and speed limits. Shown for clients that report
// them (the built-in engine; qBittorrent).

// ---- slow mode ------------------------------------------------------------------------------

export type SlowModeDuration = 'off' | '1h' | '3h' | '8h';

const DURATION_HOURS: Record<Exclude<SlowModeDuration, 'off'>, number> = { '1h': 1, '3h': 3, '8h': 8 };

const DURATION_OPTIONS: { value: SlowModeDuration; readonly label: string }[] = [
  { value: 'off', get label() { return t('activity.slowMode.untilTurnedOff'); } },
  { value: '1h', get label() { return t('activity.slowMode.forHours', { hours: 1 }); } },
  { value: '3h', get label() { return t('activity.slowMode.forHours', { hours: 3 }); } },
  { value: '8h', get label() { return t('activity.slowMode.forHours', { hours: 8 }); } },
];

/** End time for a slow-mode duration (null = until turned off). */
export function slowModeUntil(duration: SlowModeDuration, now: number = Date.now()): string | null {
  return duration === 'off' ? null : new Date(now + DURATION_HOURS[duration] * 3_600_000).toISOString();
}

/** "Slow mode · ↓ 1 MB/s ↑ 256 KB/s" and friends: what the current speed mode means. */
export function speedModeText(speed: TorrentSpeedMode): string {
  const limit = (bytes: number) => (bytes > 0 ? formatRate(bytes) : t('activity.slowMode.unlimited'));
  const limits = t('activity.slowMode.limits', { down: limit(speed.downloadLimit), up: limit(speed.uploadLimit) });
  if (speed.mode === 'normal') return `${t('activity.slowMode.normal')} · ${limits}`;
  const why = speed.reason === 'schedule' ? t('activity.slowMode.bySchedule') : speed.slowModeUntil ? t('activity.slowMode.untilTime', { time: formatDateTime(speed.slowModeUntil) }) : t('activity.slowMode.manual');
  return `${t('activity.slowMode.slowMode')} (${why}) · ${limits}`;
}

/** Header switch: manual slow mode with an optional duration; shows when the schedule applies it. */
export function SlowModeControl() {
  const status = useTorrentStatus();
  const setSlow = useSetSlowMode();
  const [duration, setDuration] = useState<SlowModeDuration>('off');
  const speed = status.data?.speed;
  if (!speed) return null;
  const on = setSlow.isPending && setSlow.variables ? setSlow.variables.enabled : speed.slowMode;
  return (
    <span className="al-slowmode" role="group" aria-label={t('activity.slowMode.slowMode')}>
      {speed.reason === 'schedule' ? (
        <Tooltip content={speedModeText(speed)} placement="bottom">
          <Chip tone="warn" tabIndex={0}>
            {t('activity.slowMode.scheduled')}
          </Chip>
        </Tooltip>
      ) : null}
      <Toggle
        size="sm"
        label={t('activity.slowMode.slowMode')}
        title={speedModeText(speed)}
        checked={on}
        disabled={setSlow.isPending}
        onChange={(e) => setSlow.mutate(e.currentTarget.checked ? { enabled: true, until: slowModeUntil(duration) } : { enabled: false })}
      />
      {on && speed.slowModeUntil ? (
        <span className="al-activity-muted">{t('activity.slowMode.untilTime', { time: formatDateTime(speed.slowModeUntil) })}</span>
      ) : !on ? (
        <Select
          className="al-slowmode__duration"
          aria-label={t('activity.slowMode.duration')}
          value={duration}
          options={DURATION_OPTIONS}
          onChange={(e) => setDuration(e.currentTarget.value as SlowModeDuration)}
        />
      ) : null}
    </span>
  );
}

// ---- per-download controls ------------------------------------------------------------------

/** The item's client reports engine controls (limits, queue place or force start). */
export function hasEngineControls(item: QueueItem): boolean {
  const l = item.live;
  if (isPendingItem(item) || !l) return false;
  return l.downloadLimit !== undefined || l.uploadLimit !== undefined || l.queuePosition !== undefined || l.forceStart !== undefined;
}

const MOVES: { move: QueueMove; label: () => string; aria: (title: string) => string }[] = [
  { move: 'top', label: () => t('activity.queueControls.top'), aria: (title) => t('activity.queueControls.moveTopTitle', { title }) },
  { move: 'up', label: () => t('activity.queueControls.up'), aria: (title) => t('activity.queueControls.moveUpTitle', { title }) },
  { move: 'down', label: () => t('activity.queueControls.down'), aria: (title) => t('activity.queueControls.moveDownTitle', { title }) },
  { move: 'bottom', label: () => t('activity.queueControls.bottom'), aria: (title) => t('activity.queueControls.moveBottomTitle', { title }) },
];

function LimitInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        mono
        className="al-input--num"
        end="KiB/s"
        min={0}
        placeholder={t('activity.torrentDrawer.unlimited')}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </FormRow>
  );
}

/** Queue order, force start and speed limits of one download (expanded queue row). */
export function QueueRowControls({ item }: { item: QueueItem }) {
  const move = useMoveQueueItem();
  const force = useForceStartQueueItem();
  const limits = useQueueItemLimits();
  const live = item.live;
  const savedDown = live?.downloadLimit ?? 0;
  const savedUp = live?.uploadLimit ?? 0;
  const savedKey = `${savedDown}/${savedUp}`;
  const [draft, setDraft] = useState({ key: savedKey, down: bytesToKibText(savedDown), up: bytesToKibText(savedUp) });
  if (!live || !hasEngineControls(item)) return null;
  // New saved limits (after a save or a change elsewhere) reset the form.
  const value = draft.key === savedKey ? draft : { key: savedKey, down: bytesToKibText(savedDown), up: bytesToKibText(savedUp) };
  const body: { downloadLimit?: number; uploadLimit?: number } = {};
  if (kibTextToBytes(value.down) !== savedDown) body.downloadLimit = kibTextToBytes(value.down);
  if (kibTextToBytes(value.up) !== savedUp) body.uploadLimit = kibTextToBytes(value.up);
  const dirty = Object.keys(body).length > 0;
  const position = live.queuePosition;
  const forced = force.isPending && force.variables?.id === item.id ? force.variables.enabled : (live.forceStart ?? false);
  const finished = item.progress >= 1;

  return (
    <section className="al-queue-controls" aria-label={t('activity.queueControls.controlsOf', { title: item.title })}>
      {position !== undefined || live.forceStart !== undefined ? (
        <div className="al-activity-stack-xs">
          <SectionLabel>{t('activity.queueControls.queueOrder')}</SectionLabel>
          <span className="al-activity-muted">
            {position !== undefined ? (
              <span className="al-num">{t('activity.queueControls.position', { position })}</span>
            ) : finished ? (
              t('activity.queueControls.finished')
            ) : (
              t('activity.queueControls.notQueued')
            )}
          </span>
          {position !== undefined ? (
            <ButtonGroup>
              {MOVES.map((m) => (
                <Button
                  key={m.move}
                  size="sm"
                  variant="secondary"
                  aria-label={m.aria(item.title)}
                  loading={move.isPending && move.variables?.move === m.move && move.variables.id === item.id}
                  disabled={move.isPending || ((m.move === 'top' || m.move === 'up') && position === 1)}
                  onClick={() => move.mutate({ id: item.id, move: m.move })}
                >
                  {m.label()}
                </Button>
              ))}
            </ButtonGroup>
          ) : null}
          {live.forceStart !== undefined && !finished ? (
            <Toggle
              size="sm"
              label={t('activity.queueControls.forceStart')}
              checked={forced}
              disabled={force.isPending}
              onChange={(e) => force.mutate({ id: item.id, enabled: e.currentTarget.checked })}
            />
          ) : null}
          <p className="al-caption">{t('activity.queueControls.forceStartCaption')}</p>
        </div>
      ) : null}
      {live.downloadLimit !== undefined || live.uploadLimit !== undefined ? (
        <form
          className="al-activity-stack-xs"
          aria-label={t('activity.queueControls.speedLimitsOf', { title: item.title })}
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) limits.mutate({ id: item.id, body });
          }}
        >
          <SectionLabel>{t('activity.queueControls.speedLimits')}</SectionLabel>
          <LimitInput label={t('activity.torrentDrawer.downloadLimit')} value={value.down} onChange={(v) => setDraft({ ...value, down: v })} />
          <LimitInput label={t('activity.torrentDrawer.uploadLimit')} value={value.up} onChange={(v) => setDraft({ ...value, up: v })} />
          <div>
            <Button type="submit" size="sm" variant="secondary" disabled={!dirty} loading={limits.isPending && limits.variables?.id === item.id}>
              {t('activity.torrentDrawer.saveLimits')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

// ---- bulk ----------------------------------------------------------------------------------

type QueueBulkVerb = 'top' | 'bottom' | 'reannounce';

/**
 * Bulk-bar actions for the selected downloads that report engine controls: move to the top or
 * bottom of the client's queue, and ask for fresh peers. Each item goes through its own route;
 * the toast says how many worked.
 */
export function useQueueEngineBulk(items: readonly QueueItem[]): BulkAction[] {
  const qc = useQueryClient();
  const report = useBulkResultToast();
  const [busy, setBusy] = useState<QueueBulkVerb | null>(null);
  const movable = items.filter((i) => i.live?.queuePosition !== undefined);
  const torrents = items.filter((i) => i.protocol === 'torrent' && !isPendingItem(i) && i.live !== undefined);
  const run = async (verb: QueueBulkVerb, targets: readonly QueueItem[], label: string) => {
    setBusy(verb);
    // One at a time, so "top" keeps the selection's relative order (last moved ends first).
    const ordered = verb === 'top' ? [...targets].reverse() : targets;
    const result: { ok: number[]; failed: { id: number; error: string }[] } = { ok: [], failed: [] };
    for (const item of ordered) {
      try {
        if (verb === 'reannounce') await queueApi.reannounce(item.id);
        else await queueApi.move(item.id, verb);
        result.ok.push(item.id);
      } catch (err) {
        result.failed.push({ id: item.id, error: errorMessage(err) });
      }
    }
    setBusy(null);
    await qc.invalidateQueries({ queryKey: ['queue'] });
    report(label, result, (id) => targets.find((i) => i.id === id)?.title);
  };
  const action = (verb: QueueBulkVerb, targets: readonly QueueItem[], label: string): BulkAction => ({
    id: verb,
    label,
    loading: busy === verb,
    disabled: busy !== null,
    onSelect: () => void run(verb, targets, label),
  });
  return [
    ...(movable.length
      ? [action('top', movable, t('activity.queueControls.moveToTop')), action('bottom', movable, t('activity.queueControls.moveToBottom'))]
      : []),
    ...(torrents.length ? [action('reannounce', torrents, t('activity.queueRecovery.reannounce'))] : []),
  ];
}
