import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { securityApi } from '../../../api/auth.js';
import { authKeys } from '../../../auth/guard.js';
import { Button, Input } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { useInvalidatingMutation } from '../../../hooks/settings-keys.js';

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
  const regenerate = useInvalidatingMutation(() => securityApi.regenerateApiKey(), [authKeys.security], { errorTitle: 'Could not regenerate the API key' });
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
        aria-label="API key"
        className="al-api-key__input"
        value={shown ? key : key ? '•'.repeat(32) : ''}
        placeholder={query.isPending ? 'Loading' : undefined}
      />
      <div className="al-api-key__actions">
        <Button variant="ghost" onClick={() => setShown((v) => !v)} disabled={!key}>
          {shown ? 'Hide' : 'Show'}
        </Button>
        <Button variant="secondary" onClick={() => void copy()} disabled={!key}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="danger" onClick={() => setConfirm(true)} disabled={query.isPending}>
          Regenerate
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Regenerate API key?"
        confirmLabel="Regenerate API key"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await regenerate.mutateAsync(undefined);
          setConfirm(false);
          setShown(true);
        }}
      >
        Every app using the current key stops working until it is given the new one.
      </ConfirmDialog>
    </div>
  );
}
