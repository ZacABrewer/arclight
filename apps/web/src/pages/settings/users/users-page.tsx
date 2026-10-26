import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PERMISSION_INFO, Permission, type User } from '@arclight/shared';
import { usersApi } from '../../../api/auth.js';
import { errorMessage } from '../../../api/client.js';
import { useAuth } from '../../../auth/auth-context.js';
import { authKeys } from '../../../auth/guard.js';
import { Button, Chip, ErrorBlock, Modal, Table, Tabs, buttonClass, type Column } from '../../../arclight/index.js';
import { UserPermissionsEditor, UserQuotaEditor, UserRequestSettingsForm } from '../../../features/requests/user-editors.js';
import { SettingsPage } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';
import '../security/security.css';

/** Short summary of a permission bitfield for the users table. */
export function permissionSummary(bits: number): string {
  if ((bits & Permission.ADMIN) !== 0) return 'Admin';
  const labels = PERMISSION_INFO.filter((p) => p.value !== Permission.ADMIN && (bits & p.value) === p.value).map((p) => p.label);
  if (labels.length === 0) return 'None';
  return labels.length > 3 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3}` : labels.join(', ');
}

export function UsersPage() {
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list });
  const [open, setOpen] = useState<User | null>(null);

  const columns: Array<Column<User>> = [
    {
      key: 'user',
      header: 'User',
      sortValue: (u) => u.displayName ?? u.username,
      cell: (u) => (
        <>
          {u.displayName ?? u.username}
          {u.id === me?.id ? <span className="al-you">(you)</span> : null}
          {u.displayName ? <span className="al-sub al-num">{u.username}</span> : null}
        </>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      sortValue: (u) => u.role,
      cell: (u) => (u.role === 'admin' ? <Chip tone="accent">Admin</Chip> : <Chip tone="neutral">User</Chip>),
    },
    { key: 'permissions', header: 'Permissions', cell: (u) => permissionSummary(u.permissions), muted: true },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (u) => (
        <Button size="sm" variant="secondary" onClick={() => setOpen(u)} aria-label={`Manage ${u.displayName ?? u.username}`}>
          Manage
        </Button>
      ),
    },
  ];

  return (
    <SettingsPage
      title="Users"
      description="Request permissions, quotas and personal notifications. Accounts are created on Settings → Security."
      actions={
        <Link to="/settings/security" className={buttonClass({ variant: 'secondary' })}>
          Manage accounts
        </Link>
      }
    >
      <SettingsSection label="Users" {...(users.data ? { count: users.data.length } : {})}>
        {users.isError ? (
          <ErrorBlock title="Could not load users" onRetry={() => void users.refetch()}>
            {errorMessage(users.error)}
          </ErrorBlock>
        ) : (
          <Table caption="Users" density="dense" columns={columns} rows={users.data} loading={users.isPending} rowKey={(u) => u.id} sortable empty="No users." />
        )}
      </SettingsSection>
      {open ? (
        <Modal open size={640} onClose={() => setOpen(null)} title={`Manage ${open.displayName ?? open.username}`}>
          <Tabs
            aria-label="User settings"
            tabs={[
              { id: 'permissions', label: 'Permissions', content: <UserPermissionsEditor userId={open.id} /> },
              { id: 'quota', label: 'Quota', content: <UserQuotaEditor userId={open.id} /> },
              { id: 'notifications', label: 'Notifications', content: <UserRequestSettingsForm userId={open.id} /> },
            ]}
          />
        </Modal>
      ) : null}
    </SettingsPage>
  );
}
