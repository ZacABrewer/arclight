import type { TranscodeBackendStatus, TranscodeHwaccel, TranscodeRule } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Banner, Button, Chip, ErrorBlock, FormRow, Pane, Skeleton, Table, Toggle, type Column } from '../../../arclight/index.js';
import { useRetestTranscodeHwaccel, useSaveTranscodeSettings, useTranscodeHwaccel, useTranscodeSettings } from '../../../hooks/transcode.js';
import { formatDateTime, formatList } from '../../../i18n/format.js';
import { t } from '../../../i18n/index.js';
import { hwaccelLabel } from './transcode-model.js';

// Settings -> Transcode rules, "Hardware acceleration" pane: each backend's capability test
// (GET /transcode/hwaccel, a 1-frame encode per backend), "Test again" (?refresh=true), a
// warning for rules whose backend fails its test, and the software-fallback setting.

export interface BrokenBackend {
  backend: TranscodeHwaccel;
  reason: string;
  /** Enabled rules that encode video on this backend. */
  rules: string[];
}

/** Enabled transcode rules whose hardware backend failed its test, grouped by backend. */
export function brokenRuleBackends(rules: readonly TranscodeRule[] | undefined, results: readonly TranscodeBackendStatus[] | undefined): BrokenBackend[] {
  if (!rules || !results) return [];
  const out: BrokenBackend[] = [];
  for (const r of results) {
    if (r.available || r.backend === 'none') continue;
    const names = rules
      .filter((rule) => rule.enabled && rule.action === 'transcode' && rule.options.videoCodec !== 'copy' && rule.options.hwaccel === r.backend)
      .map((rule) => rule.name);
    if (names.length > 0) out.push({ backend: r.backend, reason: r.reason ?? '', rules: names });
  }
  return out;
}

function FallbackRow() {
  const settings = useTranscodeSettings();
  const save = useSaveTranscodeSettings();
  const label = t('settings.transcode.fallbackToSoftware');
  return (
    <FormRow label={label} caption={t('settings.transcode.fallbackToSoftwareCaption')} captionInline>
      <Toggle
        aria-label={label}
        checked={save.isPending && save.variables ? save.variables.fallbackToSoftware : (settings.data?.fallbackToSoftware ?? true)}
        disabled={!settings.data || save.isPending}
        onChange={(e) => save.mutate({ fallbackToSoftware: e.currentTarget.checked })}
      />
    </FormRow>
  );
}

export function HardwarePane({ rules }: { rules: readonly TranscodeRule[] | undefined }) {
  const hw = useTranscodeHwaccel();
  const retest = useRetestTranscodeHwaccel();
  const settings = useTranscodeSettings();
  const title = t('settings.transcode.hardware');
  const broken = brokenRuleBackends(rules, hw.data?.results);
  const fallback = settings.data?.fallbackToSoftware ?? true;

  const columns: Column<TranscodeBackendStatus>[] = [
    { key: 'backend', header: t('settings.transcode.backend'), cell: (r) => hwaccelLabel(r.backend) },
    {
      key: 'status',
      header: t('common.status'),
      cell: (r) => <Chip tone={r.available ? 'accent' : 'danger'}>{r.available ? t('settings.transcode.hwWorks') : t('settings.transcode.hwFailed')}</Chip>,
    },
    { key: 'reason', header: t('settings.transcode.hwReason'), mono: true, muted: true, cell: (r) => r.reason ?? '—' },
  ];

  return (
    <Pane
      title={title}
      aria-label={title}
      actions={
        <Button size="sm" variant="secondary" loading={retest.isPending} disabled={hw.isPending} onClick={() => retest.mutate()}>
          {t('settings.transcode.testAgain')}
        </Button>
      }
    >
      <div className="al-editor-stack">
        {hw.isPending ? (
          <Skeleton lines={4} />
        ) : hw.isError ? (
          <ErrorBlock title={t('settings.transcode.couldNotTestHardware')} onRetry={() => retest.mutate()}>
            {errorMessage(hw.error)}
          </ErrorBlock>
        ) : !hw.data.ffmpegPath ? (
          <Banner tone="warn">{t('settings.transcode.ffmpegNotFound')}</Banner>
        ) : (
          <>
            <p className="al-caption" style={{ margin: 0 }}>
              {t('settings.transcode.hardwareCaption', { path: hw.data.ffmpegPath })}
              {hw.data.testedAt ? ` ${t('settings.transcode.testedAt', { time: formatDateTime(hw.data.testedAt) })}` : null}
            </p>
            {broken.map((b) => (
              <Banner key={b.backend} tone="warn">
                {t('settings.transcode.hwBrokenRules', { name: hwaccelLabel(b.backend), rules: formatList(b.rules), reason: b.reason })}{' '}
                {fallback ? t('settings.transcode.hwBrokenFallback') : t('settings.transcode.hwBrokenNoFallback')}
              </Banner>
            ))}
            <Table caption={title} columns={columns} rows={hw.data.results} rowKey={(r) => r.backend} density="dense" />
            {hw.data.results.some((r) => !r.available && r.backend !== 'none') ? (
              <p className="al-caption" style={{ margin: 0 }}>
                {t('settings.transcode.hwHelp')}
              </p>
            ) : null}
          </>
        )}
        <FallbackRow />
      </div>
    </Pane>
  );
}
