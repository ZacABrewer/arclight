import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LinkedIdentity } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { identityAdminApi } from '../../api/identity.js';
import { Button, Chip, ErrorBlock, KeyValue, SectionLabel, Skeleton, Table, type Column } from '../../arclight/index.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { identityKeys, useUserIdentities, useUserTwoFactor } from '../../hooks/identity.js';
import { formatDateTime } from '../../lib/format.js';
import { When, unlinkError } from './security-panels.js';
import { t } from '../../i18n/index.js';
import './identity.css';

// Settings > Users > Manage > Sign-in (admin): someone's second factors (reset when they lost
// their phone) and the identity-provider sign-ins linked to their account.

export function UserSignInAdmin({ userId, name }: { userId: number; name: string }) {
  const status = useUserTwoFactor(userId);
  const identities = useUserIdentities(userId);
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const [unlinking, setUnlinking] = useState<LinkedIdentity | null>(null);
  const has2fa = Boolean(status.data && (status.data.totp || status.data.passkeys > 0));

  const columns: Array<Column<LinkedIdentity>> = [
    { key: 'name', header: t('identity.linked.provider'), cell: (i) => i.providerName },
    { key: 'email', header: t('common.email'), mono: true, cell: (i) => i.email ?? '—' },
    { key: 'used', header: t('identity.common.lastUsed'), cell: (i) => <When iso={i.lastLoginAt} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      align: 'right',
      mobile: 'end',
      cell: (i) => (
        <Button size="sm" variant="danger" aria-label={t('identity.linked.unlinkName', { name: i.providerName })} onClick={() => setUnlinking(i)}>
          {t('identity.linked.unlink')}
        </Button>
      ),
    },
  ];

  return (
    <div className="id-stack">
      <SectionLabel>{t('identity.twoFactor.paneTitle')}</SectionLabel>
      {status.isPending ? (
        <Skeleton lines={2} />
      ) : status.isError ? (
        <ErrorBlock title={t('identity.twoFactor.couldNotLoad')} onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      ) : (
        <>
          <KeyValue
            items={[
              {
                label: t('identity.totp.authenticator'),
                value: status.data.totp ? <Chip tone="accent">{t('identity.twoFactor.on')}</Chip> : <Chip tone="neutral">{t('identity.twoFactor.off')}</Chip>,
                mono: false,
              },
              ...(status.data.totpEnabledAt ? [{ label: t('identity.totp.since'), value: formatDateTime(status.data.totpEnabledAt) }] : []),
              { label: t('identity.recovery.left'), value: <span className="al-num">{status.data.recoveryCodesLeft}</span>, mono: false },
              { label: t('identity.passkeys.title'), value: <span className="al-num">{status.data.passkeys}</span>, mono: false },
            ]}
          />
          {has2fa ? (
            <div className="id-actions">
              <Button variant="danger" onClick={() => setResetting(true)}>
                {t('identity.admin.reset')}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <SectionLabel>{t('identity.linked.title')}</SectionLabel>
      {identities.isError ? (
        <ErrorBlock title={t('identity.linked.couldNotLoad')} onRetry={() => void identities.refetch()}>
          {errorMessage(identities.error)}
        </ErrorBlock>
      ) : (
        <Table caption={t('identity.linked.title')} density="dense" columns={columns} rows={identities.data} loading={identities.isPending} rowKey={(i) => i.id} empty={t('identity.admin.noLinks')} />
      )}
      <ConfirmDialog
        open={resetting}
        title={t('identity.admin.resetTitle', { name })}
        confirmLabel={t('identity.admin.reset')}
        onCancel={() => setResetting(false)}
        onConfirm={async () => {
          await identityAdminApi.resetUserTwoFactor(userId);
          setResetting(false);
          await qc.invalidateQueries({ queryKey: identityKeys.userTwoFactor(userId) });
        }}
      >
        {t('identity.admin.resetHelp')}
      </ConfirmDialog>
      <ConfirmDialog
        open={unlinking !== null}
        title={t('identity.linked.unlinkTitle', { name: unlinking?.providerName ?? '' })}
        confirmLabel={t('identity.linked.unlink')}
        onCancel={() => setUnlinking(null)}
        describeError={unlinkError}
        onConfirm={async () => {
          if (unlinking) await identityAdminApi.unlinkUserIdentity(userId, unlinking.id);
          setUnlinking(null);
          await qc.invalidateQueries({ queryKey: identityKeys.userIdentities(userId) });
        }}
      >
        {t('identity.admin.unlinkHelp', { name })}
      </ConfirmDialog>
    </div>
  );
}
