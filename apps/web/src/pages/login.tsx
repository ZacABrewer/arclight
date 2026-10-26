import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { ApiError, errorMessage } from '../api/client.js';
import { authApi } from '../api/auth.js';
import { Backdrop, Banner, Button, Checkbox, Field, Input, Mark, Pane } from '../arclight/index.js';
import { authKeys, safeRedirect } from '../auth/guard.js';

export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Incorrect username or password.';
    if (err.status === 429) return 'Too many failed attempts. Wait a few minutes and try again.';
  }
  return errorMessage(err);
}

/** Page 07: centred chamfered card on the open backdrop; warn banner when the session expired. */
export function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const expired = search['expired'] === true || search['expired'] === 1 || search['expired'] === '1';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const userId = useId();
  const passId = useId();

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
    <div className="al-app login">
      <Backdrop vx={0.5} horizon={0.58} />
      <main className="login-main">
        {expired ? <Banner tone="warn">Your session expired. Sign in to continue.</Banner> : null}
        <Pane chamfer="both" strong className="login-card" bare>
          <form className="login-form" onSubmit={(e) => void onSubmit(e)} noValidate aria-labelledby="login-title">
            <div className="login-brand">
              <Mark size={44} />
              <span className="login-wordmark" aria-hidden="true">
                ARCLIGHT
              </span>
              <h1 id="login-title" className="al-sr-only">
                Sign in
              </h1>
            </div>
            <Field label="Username" htmlFor={userId}>
              <Input id={userId} name="username" size="lg" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
            </Field>
            <Field label="Password" htmlFor={passId}>
              <Input id={passId} name="password" type="password" size="lg" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
            </Field>
            <Checkbox label="Keep me signed in" checked={rememberMe} onChange={(e) => setRememberMe(e.currentTarget.checked)} />
            {error ? (
              <p className="login-error" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              Sign in
            </Button>
          </form>
        </Pane>
        <p className="login-foot">Forgot your password? An admin can reset it under Settings › Users.</p>
      </main>
    </div>
  );
}
