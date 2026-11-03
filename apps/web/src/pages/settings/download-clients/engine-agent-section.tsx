import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ApiError, errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, FormRow, Input, Skeleton, Toggle } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { useEngineAgentSettings, useRegenerateEngineAgentToken, useSaveEngineAgentSettings } from '../../../hooks/engine-agent.js';
import { PendingApiNotice, SettingsSection } from '../shared.js';
import { formatRelative, t } from '../../../i18n/index.js';
import { appOrigin } from '../../../lib/base-path.js';
import '../security/security.css';

// "Act as remote engine": lets other Arclight instances add this one's built-in torrent engine
// as a Remote Engine download client (GET/PUT /settings/engineagent). They sign in with this
// instance's agent token, a secret that opens only the agent routes (never the API key).

/** The URL another instance enters: this instance's address plus the agent path. */
export function engineAgentUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** The agent token: masked read-only input, Show / Copy and Regenerate behind a confirm. */
function AgentTokenControls({ token }: { token: string }) {
  const regenerate = useRegenerateEngineAgentToken();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard (http, old browser): reveal the token so it can be copied by hand.
      setShown(true);
    }
  };

  return (
    <div className="al-api-key">
      <Input
        readOnly
        mono
        aria-label={t('settings.engineAgent.token')}
        className="al-api-key__input"
        value={shown ? token : token ? '•'.repeat(32) : ''}
      />
      <div className="al-api-key__actions">
        <Button variant="ghost" onClick={() => setShown((v) => !v)} disabled={!token}>
          {shown ? t('settings.security.apiKey.hide') : t('settings.security.apiKey.show')}
        </Button>
        <Button variant="secondary" onClick={() => void copy()} disabled={!token}>
          {copied ? t('settings.security.apiKey.copied') : t('common.copy')}
        </Button>
        <Button variant="danger" onClick={() => setConfirm(true)} disabled={regenerate.isPending}>
          {t('settings.security.apiKey.regenerate')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title={t('settings.engineAgent.regenerateTitle')}
        confirmLabel={t('settings.engineAgent.regenerateConfirm')}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await regenerate.mutateAsync(undefined);
          setConfirm(false);
          setShown(true);
        }}
      >
        {t('settings.engineAgent.regenerateBody')}
      </ConfirmDialog>
    </div>
  );
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
  const acceptApiKey = save.isPending && save.variables?.acceptApiKey !== undefined ? save.variables.acceptApiKey : s.acceptApiKey;
  const url = engineAgentUrl(appOrigin(), s.path);
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
      <FormRow label={t('settings.engineAgent.token')} caption={t('settings.engineAgent.tokenCaption')}>
        <AgentTokenControls token={s.token} />
      </FormRow>
      {s.acceptApiKey || s.apiKeyLastUsedAt ? (
        <FormRow label={t('settings.engineAgent.acceptApiKey')} caption={t('settings.engineAgent.acceptApiKeyCaption')} captionInline>
          <Toggle
            aria-label={t('settings.engineAgent.acceptApiKey')}
            checked={acceptApiKey}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ acceptApiKey: e.currentTarget.checked })}
          />
        </FormRow>
      ) : null}
      {s.apiKeyLastUsedAt ? (
        <p className="al-inline-error" role="status">
          {t('settings.engineAgent.apiKeyStillUsed', { when: formatRelative(s.apiKeyLastUsedAt) })}
        </p>
      ) : null}
    </SettingsSection>
  );
}
