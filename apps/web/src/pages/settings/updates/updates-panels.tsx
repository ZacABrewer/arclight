import { useId } from 'react';
import { Link } from '@tanstack/react-router';
import { AUTOUPDATE_LABEL, type ContainerUpdateItem, type UpdateChannel, type UpdateMode, type UpdateSettings } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Banner, Button, Chip, EmptyState, ErrorBlock, FormRow, Input, Pane, Segmented, Select, Skeleton, Table, Tag, Toggle, type Column } from '../../../arclight/index.js';
import { useCheckContainers, useContainerUpdates, useUpdateContainers } from '../../../hooks/updates.js';
import { relativeTime } from '../../../lib/format.js';
import type { Draft } from '../settings-layout.js';
import { containerState, HOURS, shortDigest, windowLabel } from './update-model.js';
import './updates.css';
import { t } from '../../../i18n/index.js';

const CHANNELS: Array<{ value: UpdateChannel; label: string }> = [
  { value: 'stable', get label() { return t('settings.updates.panels.stable'); } },
  { value: 'develop', get label() { return t('settings.updates.panels.develop'); } },
];
const MODES: Array<{ value: UpdateMode; label: string }> = [
  { value: 'notify', get label() { return t('settings.updates.panels.notifyOnly'); } },
  { value: 'auto', get label() { return t('settings.updates.panels.updateAutomatically'); } },
];

/** The `updates` settings form rows; the caller owns the draft and the save bar. */
export function UpdateSettingsFields({ draft, advanced = false, dockerAvailable }: { draft: Draft<UpdateSettings>; advanced?: boolean; dockerAvailable: boolean | undefined }) {
  const ids = { enabled: useId(), interval: useId(), notify: useId(), start: useId(), end: useId(), repo: useId() };
  const v = draft.value;
  const set = <K extends keyof UpdateSettings>(k: K, value: UpdateSettings[K]) => draft.set((d) => ({ ...d, [k]: value }));
  return (
    <div className="al-upd-rows">
      <FormRow label={t('settings.updates.panels.checkForUpdates')} htmlFor={ids.enabled} captionInline>
        <Toggle id={ids.enabled} checked={v.enabled} label={t('settings.updates.panels.askGithubForNewReleases')} onChange={(e) => set('enabled', e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('settings.updates.panels.channel')} caption={v.channel === 'develop' ? t('settings.updates.panels.preReleasesAndTheDevelop') : t('settings.updates.panels.taggedReleasesOnly')}>
        <Segmented aria-label={t('settings.updates.panels.updateChannel')} variant="soft" options={CHANNELS} value={v.channel} onChange={(c) => set('channel', c)} />
      </FormRow>
      <FormRow label={t('settings.updates.panels.checkEvery')} htmlFor={ids.interval} caption={t('common.n1To168Hours')}>
        <Input id={ids.interval} type="number" mono min={1} max={168} end="h" className="al-upd-num" value={v.checkIntervalHours} onChange={(e) => set('checkIntervalHours', Number(e.currentTarget.value))} />
      </FormRow>
      <FormRow label={t('settings.updates.panels.healthWarning')} htmlFor={ids.notify} captionInline>
        <Toggle id={ids.notify} checked={v.notifyOnUpdate} label={t('settings.updates.panels.showAHealthWarningWhile')} onChange={(e) => set('notifyOnUpdate', e.currentTarget.checked)} />
      </FormRow>
      <FormRow
        label={t('common.mode')}
        caption={
          dockerAvailable === false
            ? t('settings.updates.panels.notifyOnlyTheDockerSocket')
            : v.mode === 'auto'
              ? t('settings.updates.panels.pullNewImagesAndRecreate')
              : t('settings.updates.panels.reportContainerUpdatesYouStart')
        }
      >
        <Segmented
          aria-label={t('settings.updates.panels.updateMode')}
          variant="soft"
          options={MODES.map((m) => (m.value === 'auto' && dockerAvailable === false ? { ...m, disabled: true } : m))}
          value={v.mode}
          onChange={(m) => set('mode', m)}
        />
      </FormRow>
      <FormRow label={t('settings.updates.panels.updateWindow')} caption={t('settings.updates.panels.localTimeAutomaticUpdatesRun', { windowLabel: windowLabel(v.autoUpdateWindow) })}>
        <div className="al-upd-window">
          <Select
            id={ids.start}
            aria-label={t('settings.updates.panels.windowStart')}
            value={String(v.autoUpdateWindow.startHour)}
            options={HOURS}
            onChange={(e) => set('autoUpdateWindow', { ...v.autoUpdateWindow, startHour: Number(e.currentTarget.value) })}
          />
          <span aria-hidden="true">{t('settings.updates.panels.to')}</span>
          <Select
            id={ids.end}
            aria-label={t('settings.updates.panels.windowEnd')}
            value={String(v.autoUpdateWindow.endHour)}
            options={HOURS}
            onChange={(e) => set('autoUpdateWindow', { ...v.autoUpdateWindow, endHour: Number(e.currentTarget.value) })}
          />
        </div>
      </FormRow>
      {advanced ? (
        <FormRow label={t('settings.updates.panels.repository')} htmlFor={ids.repo} caption={t('settings.updates.panels.githubOwnerNameTheImage')}>
          <Input id={ids.repo} mono spellCheck={false} value={v.repo} onChange={(e) => set('repo', e.currentTarget.value)} />
        </FormRow>
      ) : null}
    </div>
  );
}

/** Health docs anchors of the update checks (pages/docs/health-docs-data.ts). */
export const UPDATE_DOC_ANCHORS = { app: 'update-available', containers: 'container-updates-available' } as const;

/** Which label opts a container in, plus the health docs link for the warning. */
export function ContainerLabelHint() {
  return (
    <p className="al-caption al-upd-foot al-upd-labelhint">
      {t('settings.updates.panels.containersOptInWithThe')} <Tag className="al-num">{`${AUTOUPDATE_LABEL}=true`}</Tag>{' '}
      <Link className="al-link" to="/docs/system/health" hash={UPDATE_DOC_ANCHORS.containers}>
        {t('settings.updates.panels.aboutContainerUpdates')}
      </Link>
    </p>
  );
}

/** Labelled containers with their digest state, Check now, Update now and Update all. */
export function ContainerUpdatesPane() {
  const info = useContainerUpdates();
  const check = useCheckContainers();
  const update = useUpdateContainers();
  const data = info.data;
  const pending = data?.containers.filter((c) => c.updateAvailable) ?? [];

  const columns: Column<ContainerUpdateItem>[] = [
    {
      key: 'name',
      header: t('settings.updates.panels.container'),
      cell: (c) => (
        <span className="al-upd-name">
          {c.name}
          {c.isSelf ? <Chip tone="neutral" dot="none">{t('settings.updates.panels.thisApp')}</Chip> : null}
        </span>
      ),
    },
    { key: 'image', header: t('settings.updates.panels.image'), mono: true, cell: (c) => c.image },
    { key: 'net', header: t('common.network'), muted: true, cell: (c) => (c.networkParent ? `via ${c.networkParent}` : '—') },
    { key: 'digest', header: t('settings.updates.panels.digest'), mono: true, cell: (c) => (c.updateAvailable ? `${shortDigest(c.currentDigest)} → ${shortDigest(c.latestDigest)}` : shortDigest(c.currentDigest)) },
    {
      key: 'state',
      header: t('common.state'),
      cell: (c) => {
        const s = containerState(c);
        return (
          <Chip tone={s.tone} title={c.error}>
            {s.label}
          </Chip>
        );
      },
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      cell: (c) =>
        c.updateAvailable ? (
          <Button size="sm" variant="secondary" loading={update.isPending && update.variables === c.name} disabled={update.isPending} onClick={() => update.mutate(c.name)}>
            {t('settings.updates.panels.updateNow')}
          </Button>
        ) : null,
    },
  ];

  return (
    <Pane
      title={t('settings.updates.panels.containers')}
      aria-label={t('settings.updates.panels.containers')}
      flush
      actions={
        data?.dockerAvailable ? (
          <>
            <Button size="sm" variant="ghost" loading={check.isPending} onClick={() => check.mutate()}>
              {t('settings.updates.panels.checkNow')}
            </Button>
            <Button size="sm" variant="secondary" disabled={pending.length === 0 || update.isPending} loading={update.isPending && update.variables === undefined} onClick={() => update.mutate(undefined)}>
              {t('settings.updates.panels.updateAll')}
            </Button>
          </>
        ) : null
      }
    >
      {info.isPending ? (
        <div className="al-upd-pad">
          <Skeleton lines={3} />
        </div>
      ) : info.isError ? (
        <div className="al-upd-pad">
          <ErrorBlock title={t('settings.updates.panels.couldntReadContainerUpdates')} onRetry={() => void info.refetch()}>
            {errorMessage(info.error)}
          </ErrorBlock>
        </div>
      ) : !data!.dockerAvailable ? (
        <div className="al-upd-pad">
          <Banner tone="info">{data!.reason ?? t('settings.updates.panels.notifyOnlyUpdateByPulling')}</Banner>
        </div>
      ) : (
        <>
          {data!.containers.length === 0 ? (
            <div className="al-upd-pad">
              <EmptyState title={data!.checkedAt ? t('settings.updates.panels.noLabelledContainers') : t('settings.updates.panels.notCheckedYet')}>
                {data!.checkedAt
                  ? t('settings.updates.panels.addTheLabelArclightAutoupdate')
                  : t('settings.updates.panels.pressCheckNowToCompare')}
              </EmptyState>
            </div>
          ) : (
            <Table columns={columns} rows={data!.containers} rowKey={(c) => c.id} density="dense" />
          )}
          <p className="al-caption al-upd-foot">
            {data!.checkedAt ? <>{t('settings.updates.panels.checkedRelativetime', { relativeTime: relativeTime(data!.checkedAt) })}</> : null}{' '}
            {data!.lastRun ? (
              <span data-tone={data!.lastRun.ok ? undefined : 'danger'}>
                {t('settings.updates.panels.lastUpdateRelativetimeMessage', { relativeTime: relativeTime(data!.lastRun.at), message: data!.lastRun.message })}
              </span>
            ) : null}
            {update.data ? <span role="status"> {update.data.message}</span> : null}
          </p>
          <ContainerLabelHint />
        </>
      )}
    </Pane>
  );
}
