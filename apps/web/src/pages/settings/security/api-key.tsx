import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { securityApi } from '../../../api/auth.js';
import { authKeys } from '../../../auth/guard.js';
import { Button, Input } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { useInvalidatingMutation } from '../../../hooks/settings-keys.js';
import { t } from '../../../i18n/index.js';

/** GET /settings/security (the api key lives in that section). */
export function useSecuritySettings() {
  return useQuery({ queryKey: authKeys.security, queryFn: securityApi.get });
}

/**
 * The API key row: mono read-only input, Show / Copy (secondary) and Regenerate (danger) behind
 * a named confirm. Shared by Settings → General and Settings → Security.
 */
export function ApiKeyControls({ id }: { id?: string | undefined }) {
  const query = useSecuritySettings();
  const regenerate = useInvalidatingMutation(() => securityApi.regenerateApiKey(), [authKeys.security], { errorTitle: t('settings.security.apiKey.couldNotRegenerateTheApi') });
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const key = query.data?.apiKey ?? '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard (http, old browser): reveal the key so it can be copied by hand.
      setShown(true);
    }
  };

  return (
    <div className="al-api-key">
      <Input
        id={id}
        readOnly
        mono
        aria-label={t('common.apiKey')}
        className="al-api-key__input"
        value={shown ? key : key ? '•'.repeat(32) : ''}
        placeholder={query.isPending ? t('common.loading') : undefined}
      />
      <div className="al-api-key__actions">
        <Button variant="ghost" onClick={() => setShown((v) => !v)} disabled={!key}>
          {shown ? t('settings.security.apiKey.hide') : t('settings.security.apiKey.show')}
        </Button>
        <Button variant="secondary" onClick={() => void copy()} disabled={!key}>
          {copied ? t('settings.security.apiKey.copied') : t('common.copy')}
        </Button>
        <Button variant="danger" onClick={() => setConfirm(true)} disabled={query.isPending}>
          {t('settings.security.apiKey.regenerate')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title={t('settings.security.apiKey.regenerateApiKey')}
        confirmLabel={t('settings.security.apiKey.regenerateApiKey2')}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await regenerate.mutateAsync(undefined);
          setConfirm(false);
          setShown(true);
        }}
      >
        {t('settings.security.apiKey.everyAppUsingTheCurrent')}
      </ConfirmDialog>
    </div>
  );
}
