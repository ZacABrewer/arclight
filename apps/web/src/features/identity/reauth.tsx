import { useCallback, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, errorMessage } from '../../api/client.js';
import { Button, Field, Input, Modal } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { t } from '../../i18n/index.js';

// Adding a passkey, an authenticator app or a personal API key needs a session younger than ten
// minutes; an older one answers 401 REAUTH_REQUIRED and the call is repeated with the account's
// current password. Accounts without a password of their own have to sign in again.

/** Thrown by `withReauth` when the password prompt is cancelled: nothing to report. */
export class ReauthCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'ReauthCancelled';
  }
}

export function isReauthRequired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'REAUTH_REQUIRED';
}

/** A refused password as a sentence; anything else as the api said it. */
function passwordError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') return t('identity.reauth.wrongPassword');
  if (err instanceof ApiError && err.status === 429) return t('login.tooManyFailedAttemptsWait');
  return errorMessage(err);
}

interface Pending {
  attempt: (password: string) => Promise<void>;
  cancel: () => void;
}

/**
 * `withReauth(call)` runs `call()`; on REAUTH_REQUIRED it asks for the password and runs
 * `call(password)` until it passes or the prompt is cancelled (ReauthCancelled). Render
 * `dialog` once in the component.
 */
export function useReauth(): { withReauth: <T>(call: (currentPassword?: string) => Promise<T>) => Promise<T>; dialog: ReactNode } {
  const { user } = useAuth();
  const noPassword = user?.localPassword === false;
  const pending = useRef<Pending | null>(null);
  const [open, setOpen] = useState(false);

  const withReauth = useCallback(
    async <T,>(call: (currentPassword?: string) => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (err) {
        if (!isReauthRequired(err)) throw err;
        if (noPassword) throw new Error(t('identity.reauth.signInAgain'));
        return new Promise<T>((resolve, reject) => {
          pending.current = {
            attempt: async (password) => {
              const value = await call(password);
              pending.current = null;
              setOpen(false);
              resolve(value);
            },
            cancel: () => {
              pending.current = null;
              setOpen(false);
              reject(new ReauthCancelled());
            },
          };
          setOpen(true);
        });
      }
    },
    [noPassword],
  );

  const dialog = (
    <ReauthDialog open={open} onCancel={() => pending.current?.cancel()} onPassword={(password) => pending.current?.attempt(password) ?? Promise.resolve()} />
  );
  return { withReauth, dialog };
}

/** "Confirm your password": one password field, Cancel and Confirm. */
export function ReauthDialog({ open, onCancel, onPassword }: { open: boolean; onCancel: () => void; onPassword: (password: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const close = () => {
    setValue('');
    setError(null);
    onCancel();
  };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!value) return setError(t('changePassword.enterYourCurrentPassword'));
    setBusy(true);
    setError(null);
    try {
      await onPassword(value);
      setValue('');
    } catch (err) {
      setError(passwordError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      size={440}
      onClose={close}
      title={t('identity.reauth.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t('identity.reauth.confirm')}
          </Button>
        </>
      }
    >
      <form className="id-stack" onSubmit={(e) => void submit(e)} noValidate>
        <Field label={t('changePassword.currentPassword')} htmlFor={id} error={error ?? undefined}>
          <Input id={id} type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.currentTarget.value)} />
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
