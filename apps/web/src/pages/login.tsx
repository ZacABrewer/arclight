import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { ApiError, errorMessage } from '../api/client.js';
import { authApi } from '../api/auth.js';
import { authKeys, safeRedirect } from '../auth/guard.js';
import { Button } from '../components/button.js';
import { FormField, Input, Toggle } from '../components/form.js';

export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Incorrect username or password.';
    if (err.status === 429) return 'Too many failed attempts. Wait a few minutes and try again.';
  }
  return errorMessage(err);
}

export function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Sign in · Arclight';
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.login({ username: username.trim(), password, rememberMe });
      await qc.invalidateQueries({ queryKey: authKeys.all });
      await router.navigate({ href: safeRedirect(search['redirect']), replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card card" onSubmit={(e) => void onSubmit(e)} noValidate aria-labelledby="login-title">
        <div className="card-body stack">
          <div className="auth-brand">ARCLIGHT</div>
          <h1 id="login-title" className="auth-title">
            Sign in
          </h1>
          <FormField label="Username">
            <Input name="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
          </FormField>
          <FormField label="Password">
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          </FormField>
          <Toggle label="Keep me signed in" checked={rememberMe} onChange={(e) => setRememberMe(e.currentTarget.checked)} />
          {error ? (
            <p className="text-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" loading={busy}>
            Sign in
          </Button>
        </div>
      </form>
    </div>
  );
}
