import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH, type PasswordChange } from '@arclight/shared';
import { errorMessage } from '../api/client.js';
import { usersApi } from '../api/auth.js';
import { Button, Field, Input, Modal } from '../arclight/index.js';
import { useToast } from '../components/toast.js';
import { t } from '../i18n/index.js';

export interface PasswordDraft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export type PasswordErrors = Partial<Record<keyof PasswordDraft, string>>;

/** Client-side checks before PUT /user/me/password; the server re-checks the length. */
export function passwordErrors(d: PasswordDraft): PasswordErrors {
  const errors: PasswordErrors = {};
  if (!d.currentPassword) errors.currentPassword = t('changePassword.enterYourCurrentPassword');
  if (d.newPassword.length < PASSWORD_MIN_LENGTH) errors.newPassword = t('changePassword.useAtLeastPasswordMin', { PASSWORD_MIN_LENGTH });
  if (d.confirmPassword !== d.newPassword) errors.confirmPassword = t('changePassword.thePasswordsDoNotMatch');
  return errors;
}

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const EMPTY: PasswordDraft = { currentPassword: '', newPassword: '', confirmPassword: '' };

/** Modal form for the signed-in user's own password. Other sessions are signed out by the server. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<PasswordDraft>(EMPTY);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (body: PasswordChange) => usersApi.changePassword(body),
    // The form shows the error itself.
    meta: { silent: true },
  });
  const errors = touched ? passwordErrors(draft) : {};

  const close = () => {
    setDraft(EMPTY);
    setTouched(false);
    setServerError(null);
    change.reset();
    onClose();
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    setServerError(null);
    if (Object.keys(passwordErrors(draft)).length > 0) return;
    change.mutate(
      { currentPassword: draft.currentPassword, newPassword: draft.newPassword },
      {
        onSuccess: () => {
          toast.push({ tone: 'ok', title: t('changePassword.passwordChanged'), message: t('changePassword.yourOtherSessionsWereSigned') });
          close();
        },
        onError: (err) => setServerError(capitalise(errorMessage(err))),
      },
    );
  };

  const field = (key: keyof PasswordDraft) => ({
    value: draft[key],
    invalid: Boolean(errors[key]),
    onChange: (e: { currentTarget: HTMLInputElement }) => {
      const value = e.currentTarget.value;
      setDraft((d) => ({ ...d, [key]: value }));
    },
  });

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('changePassword.changePassword')}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={change.isPending} onClick={() => submit()}>
            {t('changePassword.changePassword')}
          </Button>
        </>
      }
    >
      <form id="change-password-form" className="mk-stack-sm" onSubmit={submit} noValidate>
        <Field label={t('changePassword.currentPassword')} htmlFor="pw-current" error={errors.currentPassword}>
          <Input id="pw-current" type="password" autoComplete="current-password" {...field('currentPassword')} />
        </Field>
        <Field label={t('changePassword.newPassword')} htmlFor="pw-new" hint={t('changePassword.atLeastPasswordMinLength', { PASSWORD_MIN_LENGTH })} error={errors.newPassword}>
          <Input id="pw-new" type="password" autoComplete="new-password" {...field('newPassword')} />
        </Field>
        <Field label={t('changePassword.confirmNewPassword')} htmlFor="pw-confirm" error={errors.confirmPassword}>
          <Input id="pw-confirm" type="password" autoComplete="new-password" {...field('confirmPassword')} />
        </Field>
        {/* Enter in any field submits. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        {serverError ? (
          <p className="al-field__error" role="alert" style={{ margin: 0 }}>
            {serverError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
