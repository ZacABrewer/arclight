import { Link } from '@tanstack/react-router';
import { ApiError, errorMessage } from '../../../api/client.js';
import { Chip, ErrorBlock, FormRow, Skeleton, Toggle } from '../../../arclight/index.js';
import { useEngineAgentSettings, useSaveEngineAgentSettings } from '../../../hooks/engine-agent.js';
import { PendingApiNotice, SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

// "Act as remote engine": lets other Arclight instances add this one's built-in torrent engine
// as a Remote Engine download client (GET/PUT /settings/engineagent).

/** The URL another instance enters: this instance's address plus the agent path. */
export function engineAgentUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function EngineAgentSection() {
  const settings = useEngineAgentSettings();
  const save = useSaveEngineAgentSettings();
  const label = t('settings.engineAgent.title');

  if (settings.isPending)
    return (
      <SettingsSection label={label}>
        <Skeleton lines={2} />
      </SettingsSection>
    );
  if (settings.isError)
    return (
      <SettingsSection label={label}>
        {settings.error instanceof ApiError && settings.error.status === 404 ? (
          <PendingApiNotice what={label} />
        ) : (
          <ErrorBlock title={t('settings.engineAgent.couldntLoad')} onRetry={() => void settings.refetch()}>
            {errorMessage(settings.error)}
          </ErrorBlock>
        )}
      </SettingsSection>
    );

  const s = settings.data;
  const enabled = save.isPending && save.variables?.enabled !== undefined ? save.variables.enabled : s.enabled;
  const url = engineAgentUrl(window.location.origin, s.path);
  return (
    <SettingsSection label={label}>
      <FormRow label={t('settings.engineAgent.actAsRemoteEngine')} caption={t('settings.engineAgent.actAsRemoteEngineCaption')} captionInline>
        <Toggle
          aria-label={t('settings.engineAgent.actAsRemoteEngine')}
          checked={enabled}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ enabled: e.currentTarget.checked })}
        />
      </FormRow>
      <FormRow label={t('settings.engineAgent.engine')}>
        {s.engineRunning ? (
          <Chip tone="accent">{t('settings.engineAgent.engineRunning')}</Chip>
        ) : (
          <Chip tone={enabled ? 'warn' : 'muted'}>{t('settings.engineAgent.engineStopped')}</Chip>
        )}
      </FormRow>
      {enabled && !s.engineRunning ? (
        <p className="al-inline-error" role="alert">
          {t('settings.engineAgent.engineStoppedWarning')}{' '}
          <Link to="/settings/torrent">{t('settings.engineAgent.openTorrentEngine')}</Link>
        </p>
      ) : null}
      <FormRow label={t('settings.engineAgent.endpoint')} caption={t('settings.engineAgent.endpointCaption')}>
        <span className="al-num al-dc-agent-url">{url}</span>
      </FormRow>
      <FormRow label={t('settings.engineAgent.token')}>
        <span className="al-caption">
          {t('settings.engineAgent.tokenHint')} <Link to="/settings/security">{t('settings.engineAgent.openSecurity')}</Link>
        </span>
      </FormRow>
    </SettingsSection>
  );
}
