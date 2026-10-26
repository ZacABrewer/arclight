import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PERMISSION_INFO, Permission, type User } from '@media-tron/shared';
import { usersApi } from '../../../api/auth.js';
import { useAuth } from '../../../auth/auth-context.js';
import { authKeys } from '../../../auth/guard.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Modal } from '../../../components/modal.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { Tabs } from '../../../components/tabs.js';
import { UserPermissionsEditor, UserQuotaEditor, UserRequestSettingsForm } from '../../../features/requests/user-editors.js';

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

  return (
    <Page
      title="Users"
      subtitle={
        <>
          Request permissions, quotas and personal notifications. Accounts are created on{' '}
          <Link to="/settings/security" className="link-subtle">
            Settings → Security
          </Link>
          .
        </>
      }
    >
      <Card flush>
        {users.isPending ? (
          <LoadingBlock />
        ) : users.isError ? (
          <ErrorView error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th className="align-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.displayName ?? u.username}
                      {u.id === me?.id ? <span className="muted"> (you)</span> : null}
                      {u.displayName ? <div className="muted small">{u.username}</div> : null}
                    </td>
                    <td>
                      <Badge tone={u.role === 'admin' ? 'info' : 'neutral'}>{u.role}</Badge>
                    </td>
                    <td className="muted small">{permissionSummary(u.permissions)}</td>
                    <td className="align-right">
                      <Button size="sm" onClick={() => setOpen(u)}>
                        Manage
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open ? (
        <Modal open size="lg" onClose={() => setOpen(null)} title={`Manage ${open.displayName ?? open.username}`}>
          <Tabs
            tabs={[
              { id: 'permissions', label: 'Permissions', content: <UserPermissionsEditor userId={open.id} /> },
              { id: 'quota', label: 'Quota', content: <UserQuotaEditor userId={open.id} /> },
              { id: 'notifications', label: 'Notifications', content: <UserRequestSettingsForm userId={open.id} /> },
            ]}
          />
        </Modal>
      ) : null}
    </Page>
  );
}
