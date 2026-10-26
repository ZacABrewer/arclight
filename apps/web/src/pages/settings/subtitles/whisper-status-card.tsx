import type { SubtitleWhisperStatus } from '@arclight/shared';
import { ApiError, errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Icon, KeyValue, Skeleton, type ChipTone } from '../../../arclight/index.js';
import { useWhisperStatus } from '../../../hooks/subtitles.js';
import { formatDateTime } from '../../../lib/format.js';
import { SettingsSection } from '../shared.js';
import './subtitle-settings.css';
import { t } from '../../../i18n/index.js';

// Settings -> Subtitles: the bundled Whisper (ASR) service (GET /subtitle/whisper/status):
// ARCLIGHT_WHISPER_URL, the whisperai provider entry and a live probe.

export type WhisperState = 'unconfigured' | 'unregistered' | 'disabled' | 'reachable' | 'unreachable' | 'unknown';

/** One word for the card's chip, from the status record. */
export function whisperState(s: SubtitleWhisperStatus): WhisperState {
  if (!s.registered) return s.envUrl ? 'unregistered' : 'unconfigured';
  if (!s.enabled) return 'disabled';
  if (s.reachable === true) return 'reachable';
  if (s.reachable === false) return 'unreachable';
  return 'unknown';
}

const STATE_TONE: Record<WhisperState, ChipTone> = {
  unconfigured: 'muted',
  unregistered: 'warn',
  disabled: 'muted',
  reachable: 'accent',
  unreachable: 'danger',
  unknown: 'neutral',
};

function stateLabel(state: WhisperState): string {
  switch (state) {
    case 'unconfigured':
      return t('settings.subtitles.whisper.notSetUp');
    case 'unregistered':
      return t('settings.subtitles.whisper.notRegistered');
    case 'disabled':
      return t('common.disabled');
    case 'reachable':
      return t('settings.subtitles.whisper.reachable');
    case 'unreachable':
      return t('settings.subtitles.whisper.unreachable');
    default:
      return t('settings.subtitles.whisper.notProbed');
  }
}

const yesNo = (v: boolean) => (v ? t('common.yes') : t('common.no'));

export function WhisperStatusCard() {
  const status = useWhisperStatus();
  const label = t('settings.subtitles.whisper.section');
  // Older api builds have no status route: leave the card out.
  if (status.error instanceof ApiError && status.error.status === 404) return null;

  const action = (
    <Button size="sm" variant="ghost" icon={<Icon name="refresh" />} loading={status.isFetching} onClick={() => void status.refetch()}>
      {t('settings.subtitles.whisper.checkAgain')}
    </Button>
  );

  if (status.isPending)
    return (
      <SettingsSection label={label} action={action}>
        <Skeleton lines={3} />
      </SettingsSection>
    );
  if (status.isError)
    return (
      <SettingsSection label={label} action={action}>
        <ErrorBlock title={t('settings.subtitles.whisper.statusDidNotLoad')} onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      </SettingsSection>
    );

  const s = status.data;
  const state = whisperState(s);
  return (
    <SettingsSection label={label} action={action}>
      <div className="al-whisper-status" data-testid="whisper-status">
        <div className="al-whisper-status__head">
          <Chip tone={STATE_TONE[state]}>{stateLabel(state)}</Chip>
          {s.message ? <span className="al-caption">{s.message}</span> : null}
        </div>
        <KeyValue
          items={[
            { key: 'endpoint', label: t('settings.subtitles.whisper.endpoint'), value: s.endpoint ?? '—' },
            { key: 'env', label: t('settings.subtitles.whisper.envUrl'), value: s.envUrl ?? '—' },
            {
              key: 'registered',
              label: t('settings.subtitles.whisper.registered'),
              mono: false,
              value: s.registered ? (s.autoRegistered ? t('settings.subtitles.whisper.yesAutomatically') : t('settings.subtitles.whisper.yesByHand')) : t('common.no'),
            },
            { key: 'enabled', label: t('common.enabled'), mono: false, value: yesNo(s.enabled) },
            { key: 'fallback', label: t('settings.subtitles.whisper.onlyWhenNoOtherResult'), mono: false, value: yesNo(s.onlyWhenNoOtherResult) },
            { key: 'checked', label: t('settings.subtitles.whisper.checkedAt'), value: formatDateTime(s.checkedAt) },
          ]}
        />
      </div>
    </SettingsSection>
  );
}
