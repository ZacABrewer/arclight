import { Link } from '@tanstack/react-router';
import type { UpdateInfo, UpdateRelease, UpdateSettings } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, KeyValue, Pane, Skeleton } from '../../arclight/index.js';
import { useCheckForUpdates, useContainerUpdates, useSaveUpdateSettings, useUpdateInfo, useUpdateSettings } from '../../hooks/updates.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { useDraft } from '../settings/settings-layout.js';
import { howToUpdate } from '../settings/updates/update-model.js';
import { ContainerUpdatesPane, UPDATE_DOC_ANCHORS, UpdateSettingsFields } from '../settings/updates/updates-panels.js';
import '../settings/updates/updates.css';
import { MarkdownLite } from './markdown-lite.js';
import { SystemHeader } from './system-header.js';
import { t } from '../../i18n/index.js';

function VersionPane({ info }: { info: UpdateInfo }) {
  return (
    <Pane title={t('system.updates.installed')} chamfer="tl">
      {info.error ? (
        <p className="al-upd-error" role="status">
          {t('system.updates.theLastCheckFailedError', { error: info.error })}
        </p>
      ) : null}
      <KeyValue
        items={[
          { label: t('common.running'), value: info.currentVersion },
          { label: t('system.updates.latest'), value: info.latestVersion ?? '—' },
          {
            label: t('common.status'),
            mono: false,
            value: !info.checkedAt ? (
              <Chip tone="muted">{t('system.updates.notCheckedYet')}</Chip>
            ) : info.updateAvailable ? (
              <span className="al-upd-status">
                <Chip tone="warn">{t('system.updates.updateAvailable')}</Chip>
                <Link className="al-link" to="/docs/system/health" hash={UPDATE_DOC_ANCHORS.app}>
                  {t('system.updates.aboutThisWarning')}
                </Link>
              </span>
            ) : (
              <Chip tone="accent">{t('common.upToDate')}</Chip>
            ),
          },
          { label: t('system.updates.image'), value: info.imageTag ? `${info.image ?? ''}:${info.imageTag}` : (info.image ?? '—') },
          { label: t('system.updates.channel'), value: info.channel },
          { label: t('system.updates.checked'), value: info.checkedAt ? relativeTime(info.checkedAt) : 'never' },
          { label: t('system.updates.deployment'), value: info.isDocker ? 'Docker' : t('system.updates.native'), mono: false },
        ]}
      />
    </Pane>
  );
}

function HowToPane({ info }: { info: UpdateInfo }) {
  return (
    <Pane title={t('system.updates.howToUpdate')}>
      {howToUpdate(info).map((h) => (
        <section key={h.id} className="al-upd-howto" data-current={h.current || undefined} aria-label={h.title}>
          <p className="al-title-s" style={{ margin: '0 0 8px' }}>
            {h.title} {h.current ? <Chip tone="neutral" dot="none">{t('system.updates.thisInstall')}</Chip> : null}
          </p>
          <ol className="al-upd-steps">
            {h.steps.map((s) => (
              <li key={s.text}>
                {s.text}
                {s.command ? <code className="al-upd-cmd">{s.command}</code> : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </Pane>
  );
}

function ReleasePane({ release, current }: { release: UpdateRelease; current: string }) {
  return (
    <Pane
      title={t('system.updates.vVersion', { version: release.version })}
      aria-label={t('system.updates.releaseVersion', { version: release.version })}
      actions={
        <>
          {release.version === current ? <Chip tone="accent">{t('system.updates.installed')}</Chip> : null}
          {release.prerelease ? <Chip tone="warn">{t('system.updates.preRelease')}</Chip> : null}
          {release.publishedAt ? <span className="al-num al-caption">{formatDateTime(release.publishedAt)}</span> : null}
          {release.url ? (
            <a className="al-link" href={release.url} target="_blank" rel="noreferrer">
              {t('system.updates.github')}
            </a>
          ) : null}
        </>
      }
    >
      <MarkdownLite source={release.notes} className="al-upd-notes" />
    </Pane>
  );
}

function QuickSettings({ data }: { data: UpdateSettings }) {
  const draft = useDraft(data);
  const save = useSaveUpdateSettings();
  const containers = useContainerUpdates();
  return (
    <Pane
      title={t('common.settings')}
      actions={
        <>
          <Link to="/settings/updates" className="al-link">
            {t('system.updates.allUpdateSettings')}
          </Link>
          {draft.dirty ? (
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(draft.value)}>
              {t('common.saveChanges')}
            </Button>
          ) : null}
        </>
      }
    >
      <UpdateSettingsFields draft={draft} dockerAvailable={containers.data?.dockerAvailable} />
    </Pane>
  );
}

/** System → Updates: running vs latest version, changelog panes, how to update, settings. */
export function SystemUpdatesPage() {
  const info = useUpdateInfo();
  const check = useCheckForUpdates();
  const settings = useUpdateSettings();
  const data = info.data;
  return (
    <>
      <SystemHeader
        title={t('common.updates')}
        subtitle={data?.updateAvailable ? t('system.updates.arclightLatestversionIsAvailable', { latestVersion: data.latestVersion }) : data?.checkedAt ? t('system.updates.arclightIsUpToDate') : undefined}
        actions={
          <Button variant="secondary" loading={check.isPending} onClick={() => check.mutate()}>
            {t('system.updates.checkNow')}
          </Button>
        }
      />
      {info.isPending ? (
        <Skeleton lines={4} />
      ) : info.isError ? (
        <ErrorBlock title={t('system.updates.couldntReadUpdateInformation')} onRetry={() => void info.refetch()}>
          {errorMessage(info.error)}
        </ErrorBlock>
      ) : (
        <>
          <div className="al-upd-grid">
            <VersionPane info={data!} />
            <HowToPane info={data!} />
          </div>
          <div className="al-upd-stack">
            {data!.releases.length === 0 ? (
              <Pane title={t('system.updates.changelog')}>
                <EmptyState title={data!.checkedAt ? t('system.updates.noReleasesFound') : t('system.updates.notCheckedYet')}>
                  {data!.checkedAt ? t('system.updates.noPublishedReleasesOnThe', { channel: data!.channel, repo: data!.repo }) : t('system.updates.pressCheckNowToAsk')}
                </EmptyState>
              </Pane>
            ) : (
              data!.releases.map((r) => <ReleasePane key={r.tag} release={r} current={data!.currentVersion} />)
            )}
            <ContainerUpdatesPane />
            {settings.data ? <QuickSettings data={settings.data} /> : null}
          </div>
        </>
      )}
    </>
  );
}
