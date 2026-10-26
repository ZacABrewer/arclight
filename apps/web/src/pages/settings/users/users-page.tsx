import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PERMISSION_INFO, Permission, type User } from '@arclight/shared';
import { usersApi } from '../../../api/auth.js';
import { errorMessage } from '../../../api/client.js';
import { useAuth } from '../../../auth/auth-context.js';
import { authKeys } from '../../../auth/guard.js';
import { Button, Chip, ErrorBlock, Modal, Table, Tabs, buttonClass, type Column } from '../../../arclight/index.js';
import { UserPermissionsEditor, UserPolicyEditor, UserQuotaEditor, UserRequestSettingsForm } from '../../../features/requests/user-editors.js';
import { SettingsPage } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';
import '../security/security.css';
import { t } from '../../../i18n/index.js';

/** Short summary of a permission bitfield for the users table. */
export function permissionSummary(bits: number): string {
  if ((bits & Permission.ADMIN) !== 0) return t('common.admin');
  const labels = PERMISSION_INFO.filter((p) => p.value !== Permission.ADMIN && (bits & p.value) === p.value).map((p) => p.label);
  if (labels.length === 0) return t('common.none');
  return labels.length > 3 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3}` : labels.join(', ');
}

export function UsersPage() {
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list });
  const [open, setOpen] = useState<User | null>(null);

  const columns: Array<Column<User>> = [
    {
      key: 'user',
      header: t('common.user'),
      sortValue: (u) => u.displayName ?? u.username,
      cell: (u) => (
        <>
          {u.displayName ?? u.username}
          {u.id === me?.id ? <span className="al-you">{t('settings.users.you')}</span> : null}
          {u.displayName ? <span className="al-sub al-num">{u.username}</span> : null}
        </>
      ),
    },
    {
      key: 'role',
      header: t('common.role'),
      sortValue: (u) => u.role,
      cell: (u) => (u.role === 'admin' ? <Chip tone="accent">{t('common.admin')}</Chip> : <Chip tone="neutral">{t('common.user')}</Chip>),
    },
    { key: 'permissions', header: t('settings.users.permissions'), cell: (u) => permissionSummary(u.permissions), muted: true },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (u) => (
        <Button size="sm" variant="secondary" onClick={() => setOpen(u)} aria-label={t('settings.users.manageValue', { value: u.displayName ?? u.username })}>
          {t('settings.users.manage')}
        </Button>
      ),
    },
  ];

  return (
    <SettingsPage
      title={t('common.users')}
      description={t('settings.users.requestPermissionsQuotasAndPersonal')}
      actions={
        <Link to="/settings/security" className={buttonClass({ variant: 'secondary' })}>
          {t('settings.users.manageAccounts')}
        </Link>
      }
    >
      <SettingsSection label={t('common.users')} {...(users.data ? { count: users.data.length } : {})}>
        {users.isError ? (
          <ErrorBlock title={t('settings.users.couldNotLoadUsers')} onRetry={() => void users.refetch()}>
            {errorMessage(users.error)}
          </ErrorBlock>
        ) : (
          <Table caption={t('common.users')} density="dense" columns={columns} rows={users.data} loading={users.isPending} rowKey={(u) => u.id} sortable empty={t('settings.users.noUsers')} />
        )}
      </SettingsSection>
      {open ? (
        <Modal open size={640} onClose={() => setOpen(null)} title={t('settings.users.manageValue', { value: open.displayName ?? open.username })}>
          <Tabs
            aria-label={t('settings.users.userSettings')}
            tabs={[
              { id: 'permissions', label: t('settings.users.permissions'), content: <UserPermissionsEditor userId={open.id} /> },
              { id: 'quota', label: t('settings.users.quota'), content: <UserQuotaEditor userId={open.id} /> },
              { id: 'policy', label: t('settings.users.capsAndApproval'), content: <UserPolicyEditor userId={open.id} /> },
              { id: 'notifications', label: t('common.notifications'), content: <UserRequestSettingsForm userId={open.id} /> },
            ]}
          />
        </Modal>
      ) : null}
    </SettingsPage>
  );
}
