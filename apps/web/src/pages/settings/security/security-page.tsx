import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH, type AuthMethod, type AuthSettings, type User, type UserRole } from '@media-tron/shared';
import { securityApi, usersApi } from '../../../api/auth.js';
import { errorMessage } from '../../../api/client.js';
import { useAuth } from '../../../auth/auth-context.js';
import { authKeys } from '../../../auth/guard.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../../components/form.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { Modal } from '../../../components/modal.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useInvalidatingMutation } from '../../../hooks/settings-keys.js';
import { EditorFooter, SaveError } from '../shared.js';

const METHOD_OPTIONS = [
  { value: 'forms', label: 'Login page' },
  { value: 'basic', label: 'Browser prompt (HTTP Basic)' },
  { value: 'none', label: 'None on the local network' },
];

function AuthSettingsCard() {
  const query = useQuery({ queryKey: authKeys.security, queryFn: securityApi.get });
  const save = useInvalidatingMutation((body: AuthSettings) => securityApi.update(body), [authKeys.security, authKeys.status], {
    errorTitle: 'Could not save security settings',
  });
  const [draft, setDraft] = useState<AuthSettings | null>(null);
  useEffect(() => {
    if (query.data && !draft) setDraft({ method: query.data.method, requireForLocal: query.data.requireForLocal, sessionDays: query.data.sessionDays });
  }, [query.data, draft]);

  if (query.isPending || !draft) return <Card title="Authentication">{query.isError ? <ErrorView error={query.error} /> : <LoadingBlock />}</Card>;
  return (
    <Card
      title="Authentication"
      actions={
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(draft)}>
          Save
        </Button>
      }
    >
      <FormField label="Method" inline hint="How people sign in from a browser. The API key always works for apps.">
        <Select value={draft.method} options={METHOD_OPTIONS} onChange={(e) => setDraft({ ...draft, method: e.currentTarget.value as AuthMethod })} />
      </FormField>
      <FormField label="Require for local addresses" inline hint="Off: requests from this machine and the private network (192.168.x, 10.x, ...) skip sign-in.">
        <Toggle checked={draft.requireForLocal} onChange={(e) => setDraft({ ...draft, requireForLocal: e.currentTarget.checked })} />
      </FormField>
      <FormField label="Session length (days)" inline>
        <Input type="number" min={1} max={365} value={draft.sessionDays} onChange={(e) => setDraft({ ...draft, sessionDays: Number(e.currentTarget.value) || 1 })} />
      </FormField>
    </Card>
  );
}

function ApiKeyCard() {
  const query = useQuery({ queryKey: authKeys.security, queryFn: securityApi.get });
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
      setShown(true);
    }
  };

  return (
    <Card title="API key">
      <p className="muted">Apps and scripts send this as the X-Api-Key header (or ?apikey=). It grants admin access.</p>
      <div className="row">
        <Input readOnly aria-label="API key" className="api-key-input" value={shown ? key : key ? '•'.repeat(32) : ''} />
        <Button onClick={() => setShown((v) => !v)}>{shown ? 'Hide' : 'Show'}</Button>
        <Button onClick={() => void copy()} disabled={!key}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          Regenerate
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Regenerate the API key?"
        confirmLabel="Regenerate"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await regenerate.mutateAsync(undefined);
          setConfirm(false);
          setShown(true);
        }}
      >
        Every app using the current key stops working until it is given the new one.
      </ConfirmDialog>
    </Card>
  );
}

interface UserDraft {
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  password: string;
}

export function validateUserDraft(d: UserDraft, isNew: boolean): string | null {
  if (d.username.trim().length < 2) return 'Username needs at least 2 characters.';
  if (!/^[A-Za-z0-9._@-]+$/.test(d.username.trim())) return 'Username: letters, digits and . _ @ - only.';
  if ((isNew || d.password) && d.password.length < PASSWORD_MIN_LENGTH) return `Password needs at least ${PASSWORD_MIN_LENGTH} characters.`;
  return null;
}

function UserEditor({ user, mode, onClose }: { user: User | null; mode: 'edit' | 'password'; onClose: () => void }) {
  const [draft, setDraft] = useState<UserDraft>({
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'user',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const save = useInvalidatingMutation(
    async (d: UserDraft) => {
      if (!user) {
        return usersApi.create({
          username: d.username.trim(),
          password: d.password,
          role: d.role,
          ...(d.displayName.trim() ? { displayName: d.displayName.trim() } : {}),
          ...(d.email.trim() ? { email: d.email.trim() } : {}),
        });
      }
      if (mode === 'password') return usersApi.update(user.id, { password: d.password });
      return usersApi.update(user.id, {
        username: d.username.trim(),
        role: d.role,
        displayName: d.displayName.trim() || null,
        email: d.email.trim() || null,
      });
    },
    [authKeys.users, authKeys.me],
    { silent: true },
  );

  const submit = () => {
    const problem = mode === 'password' ? (draft.password.length < PASSWORD_MIN_LENGTH ? `Password needs at least ${PASSWORD_MIN_LENGTH} characters.` : null) : validateUserDraft(draft, !user);
    setError(problem);
    if (!problem) save.mutate(draft, { onSuccess: onClose });
  };
  const set = (k: keyof UserDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.currentTarget.value });

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'password' ? `Reset password for ${user?.username}` : user ? `Edit ${user.username}` : 'Add user'}
      footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} />}
    >
      {mode === 'edit' ? (
        <>
          <FormField label="Username">
            <Input value={draft.username} onChange={set('username')} />
          </FormField>
          <FormField label="Display name">
            <Input value={draft.displayName} onChange={set('displayName')} />
          </FormField>
          <FormField label="Email">
            <Input type="email" value={draft.email} onChange={set('email')} />
          </FormField>
          <FormField label="Role" hint="Admins manage settings and users; users can browse and (later) request.">
            <Select value={draft.role} onChange={set('role')} options={[{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }]} />
          </FormField>
        </>
      ) : null}
      {mode === 'password' || !user ? (
        <FormField label={user ? 'New password' : 'Password'} hint={user ? 'Signs the user out everywhere.' : undefined}>
          <Input type="password" autoComplete="new-password" value={draft.password} onChange={set('password')} />
        </FormField>
      ) : null}
      {error ? <p className="text-error" role="alert">{error}</p> : null}
      <SaveError error={save.error} />
    </Modal>
  );
}

function UsersCard() {
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list });
  const remove = useInvalidatingMutation((id: number) => usersApi.remove(id), [authKeys.users], { silent: true });
  const [editing, setEditing] = useState<{ user: User | null; mode: 'edit' | 'password' } | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  return (
    <Card
      title="Users"
      flush
      actions={
        <Button variant="primary" onClick={() => setEditing({ user: null, mode: 'edit' })}>
          Add user
        </Button>
      }
    >
      {users.isPending ? (
        <LoadingBlock />
      ) : users.isError ? (
        <ErrorView error={users.error} onRetry={() => void users.refetch()} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th className="align-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.username}
                    {u.id === me?.id ? <span className="muted"> (you)</span> : null}
                  </td>
                  <td>{u.displayName ?? ''}</td>
                  <td>{u.email ?? ''}</td>
                  <td>
                    <Badge tone={u.role === 'admin' ? 'info' : 'neutral'}>{u.role}</Badge>
                  </td>
                  <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                  <td className="align-right">
                    <div className="row row-end">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ user: u, mode: 'edit' })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ user: u, mode: 'password' })}>
                        Reset password
                      </Button>
                      <Button size="sm" variant="ghost" disabled={u.id === me?.id} onClick={() => setDeleting(u)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <UserEditor key={`${editing.user?.id ?? 'new'}-${editing.mode}`} user={editing.user} mode={editing.mode} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.username ?? ''}?`}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
        describeError={(err) => errorMessage(err)}
      >
        Their sessions end immediately.
      </ConfirmDialog>
    </Card>
  );
}

export function SecurityPage() {
  return (
    <Page title="Security">
      <div className="stack">
        <AuthSettingsCard />
        <ApiKeyCard />
        <UsersCard />
      </div>
    </Page>
  );
}
