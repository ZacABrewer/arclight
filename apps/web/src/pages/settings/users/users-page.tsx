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
import { UserDefaultsFields, useUserDefaults } from '../../../features/users/user-defaults.js';
import { appAccessSummary } from '../security/security-page.js';
import { SettingsPage } from '../settings-layout.js';
import { SettingsListSearch, SettingsSection } from '../shared.js';
import { useClientListSearch } from '../../../components/list-search.js';
import { useToast } from '../../../components/toast.js';
import { ResourceBulkBar, tableSelection } from '../../../components/resource-bulk-actions.js';
import { useSelection } from '../../../components/bulk-actions.js';
import '../security/security.css';
import { t } from '../../../i18n/index.js';

/** Short summary of a permission bitfield for the users table. */
export function permissionSummary(bits: number): string {
  if ((bits & Permission.ADMIN) !== 0) return t('common.admin');
  const labels = PERMISSION_INFO.filter((p) => p.value !== Permission.ADMIN && (bits & p.value) === p.value).map((p) => p.label);
  if (labels.length === 0) return t('common.none');
  return labels.length > 3 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3}` : labels.join(', ');
}

/** Settings > Users > User defaults: sign-in, new accounts' permissions, quotas, app access. */
function UserDefaultsSection() {
  const state = useUserDefaults();
  const toast = useToast();
  const save = async () => {
    if (await state.save()) toast.push({ tone: 'ok', title: t('userDefaults.saved') });
  };
  return (
    <SettingsSection
      label={t('setup.wizard.userDefaults')}
      action={
        <Button size="sm" variant="primary" loading={state.saving} disabled={!state.draft} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      }
    >
      <UserDefaultsFields state={state} />
    </SettingsSection>
  );
}

export function UsersPage() {
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list });
  const [open, setOpen] = useState<User | null>(null);
  // Search: username, display name, role and permission / app-access text (emails are not shown, so not searched).
  const search = useClientListSearch(users.data, (u) => [
    u.username,
    u.displayName,
    u.role,
    u.role === 'admin' ? t('common.admin') : t('common.user'),
    PERMISSION_INFO.filter((p) => (u.permissions & p.value) === p.value).map((p) => p.label),
    appAccessSummary(u),
  ]);
  // Select all picks the matching users only.
  const userKeys = (search.rows ?? []).map((u) => u.id);
  const selection = useSelection(userKeys);

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
    { key: 'access', header: t('settings.security.appAccess'), cell: (u) => appAccessSummary(u), muted: true },
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
          <SettingsListSearch search={search} placeholder={t('settings.users.searchUsers')}>
          <Table
            caption={t('common.users')}
            density="dense"
            columns={columns}
            rows={search.rows}
            loading={users.isPending}
            rowKey={(u) => u.id}
            sortable
            empty={t('settings.users.noUsers')}
            {...tableSelection(selection)}
            rowLabel={(u) => t('components.bulkActions.selectName', { name: u.displayName ?? u.username })}
          />
          </SettingsListSearch>
        )}
      </SettingsSection>
      <ResourceBulkBar resource="user" selection={selection} allKeys={userKeys} nameOf={(id) => users.data?.find((u) => u.id === id)?.username} />
      <UserDefaultsSection />
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
