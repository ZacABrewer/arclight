import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import type { ApiKeyScope, LinkedIdentity, PasskeyRecord, TotpSetup, TwoFactorProof, UserApiKey, UserApiKeyCreated } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { myIdentityApi } from '../../api/identity.js';
import { Banner, Button, Chip, ErrorBlock, Field, Input, KeyValue, Modal, Select, Skeleton, Table, type Column } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { authKeys } from '../../auth/guard.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { useToast } from '../../components/toast.js';
import { identityKeys, useMyApiKeys, useMyIdentities, useMyPasskeys, useMyTwoFactor } from '../../hooks/identity.js';
import { copyText, downloadText } from '../../lib/clipboard.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { QrCode } from '../mobile/mobile-app-section.js';
import { passkeyAttestation, passkeyErrorMessage, passkeysSupported } from './webauthn.js';
import { t } from '../../i18n/index.js';
import './identity.css';

// Profile > Security: two-factor (authenticator app + recovery codes), passkeys, sign-ins
// linked from identity providers, and personal API keys. Every call here needs a browser
// session (the api refuses API keys for them).

/** Mono relative time with the full date on hover. */
export function When({ iso, empty = t('common.never') }: { iso: string | null | undefined; empty?: string }) {
  if (!iso) return <span className="al-muted">{empty}</span>;
  return (
    <time className="al-num" dateTime={iso} title={formatDateTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

/** "ABCD EFGH IJKL …": the TOTP secret in groups of four for typing by hand. */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/** The recovery codes as a .txt file's text. */
export function recoveryCodesText(codes: readonly string[], when: Date = new Date()): string {
  return [t('identity.recovery.fileHeading'), t('identity.recovery.fileHelp'), `${t('identity.recovery.fileCreated')}: ${when.toISOString()}`, '', ...codes, ''].join('\n');
}

/** A refused proof (wrong code) as a sentence; anything else as the api said it. */
function proofError(err: unknown, recovery: boolean): string {
  if (err instanceof ApiError && (err.status === 401 || err.status === 400)) return recovery ? t('identity.twoFactor.wrongRecovery') : t('identity.twoFactor.wrongCode');
  if (err instanceof ApiError && err.status === 429) return t('login.tooManyFailedAttemptsWait');
  return errorMessage(err);
}

/** Codes shown once (after turning two-factor on or regenerating): copy, download, done. */
export function RecoveryCodesModal({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!codes) return null;
  return (
    <Modal
      open
      size={560}
      dismissOnScrim={false}
      onClose={onClose}
      title={t('identity.recovery.title')}
      footer={
        <>
          <Button variant="ghost" onClick={() => void copyText(codes.join('\n')).then((ok) => setCopied(ok))}>
            {copied ? t('settings.security.apiKey.copied') : t('common.copy')}
          </Button>
          <Button variant="secondary" onClick={() => downloadText('arclight-recovery-codes.txt', recoveryCodesText(codes))}>
            {t('identity.recovery.download')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('identity.recovery.saved')}
          </Button>
        </>
      }
    >
      <div className="id-stack">
        <p className="id-muted">{t('identity.recovery.help')}</p>
        <ul className="id-codes" aria-label={t('identity.recovery.title')}>
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

/** Asks for an authenticator code (or a recovery code) before turning off / regenerating. */
function ProofDialog({
  open,
  title,
  confirmLabel,
  danger,
  onCancel,
  onProof,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onProof: (proof: TwoFactorProof) => Promise<void>;
}) {
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const close = () => {
    setValue('');
    setError(null);
    setRecovery(false);
    onCancel();
  };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const v = value.replace(/\s+/g, '');
    if (!recovery && !/^\d{6}$/.test(v)) return setError(t('identity.twoFactor.enterSixDigits'));
    if (recovery && value.trim().length < 8) return setError(t('identity.twoFactor.enterRecovery'));
    setBusy(true);
    setError(null);
    try {
      await onProof(recovery ? { recoveryCode: value.trim() } : { code: v });
      setValue('');
      setRecovery(false);
    } catch (err) {
      setError(proofError(err, recovery));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      size={440}
      onClose={close}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={() => void submit()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form className="id-stack" onSubmit={(e) => void submit(e)} noValidate>
        <Field label={recovery ? t('identity.twoFactor.recoveryCode') : t('identity.twoFactor.code')} htmlFor={id} error={error ?? undefined}>
          {recovery ? (
            <Input id={id} mono autoComplete="off" autoCapitalize="none" spellCheck={false} value={value} onChange={(e) => setValue(e.currentTarget.value)} />
          ) : (
            <Input id={id} mono autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]*" maxLength={7} value={value} onChange={(e) => setValue(e.currentTarget.value)} />
          )}
        </Field>
        <div className="id-actions">
          <Button variant="ghost" size="sm" onClick={() => { setRecovery((r) => !r); setValue(''); setError(null); }}>
            {recovery ? t('identity.twoFactor.useAuthenticator') : t('identity.twoFactor.useRecovery')}
          </Button>
        </div>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** Scan the QR (or type the secret), confirm a code, then show the recovery codes. */
function TotpSetupDialog({ setup, onClose, onEnabled }: { setup: TotpSetup | null; onClose: () => void; onEnabled: (codes: string[]) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  if (!setup) return null;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const v = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(v)) return setError(t('identity.twoFactor.enterSixDigits'));
    setBusy(true);
    setError(null);
    try {
      const res = await myIdentityApi.totpEnable(v);
      setCode('');
      onEnabled(res.codes);
    } catch (err) {
      setError(proofError(err, false));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      size={560}
      dismissOnScrim={false}
      onClose={onClose}
      title={t('identity.totp.setupTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t('identity.totp.turnOn')}
          </Button>
        </>
      }
    >
      <form className="id-stack" onSubmit={(e) => void submit(e)} noValidate>
        <p className="id-muted">{t('identity.totp.scanHelp')}</p>
        <div className="id-qr">
          <QrCode value={setup.uri} label={t('identity.totp.qrLabel')} size={176} />
          <div className="id-stack">
            <span className="al-label">{t('identity.totp.manualKey')}</span>
            <span className="id-secret" data-testid="totp-secret">
              {groupSecret(setup.secret)}
            </span>
          </div>
        </div>
        <Field label={t('identity.totp.confirmCode')} htmlFor={id} error={error ?? undefined}>
          <Input id={id} mono autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]*" maxLength={7} value={code} onChange={(e) => setCode(e.currentTarget.value)} />
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

export function TwoFactorPanel() {
  const status = useMyTwoFactor();
  const qc = useQueryClient();
  const toast = useToast();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [proof, setProof] = useState<'disable' | 'regenerate' | null>(null);
  const start = useMutation({ mutationFn: myIdentityApi.totpSetup, meta: { errorTitle: t('identity.totp.couldNotStart') } });
  // The setup requirement (and the session's twoFactorSetupRequired) change with these.
  const refresh = () => qc.invalidateQueries({ queryKey: authKeys.all });

  if (status.isPending) return <Skeleton lines={2} />;
  if (status.isError) return <ErrorBlock title={t('identity.twoFactor.couldNotLoad')} onRetry={() => void status.refetch()}>{errorMessage(status.error)}</ErrorBlock>;
  const s = status.data;
  const low = s.totp && s.recoveryCodesLeft <= 2;

  return (
    <div className="id-stack">
      <KeyValue
        items={[
          {
            label: t('identity.totp.authenticator'),
            value: s.totp ? <Chip tone="accent">{t('identity.twoFactor.on')}</Chip> : <Chip tone="neutral">{t('identity.twoFactor.off')}</Chip>,
            mono: false,
          },
          ...(s.totp && s.totpEnabledAt ? [{ label: t('identity.totp.since'), value: formatDateTime(s.totpEnabledAt) }] : []),
          ...(s.totp ? [{ label: t('identity.recovery.left'), value: <span className="al-num">{s.recoveryCodesLeft}</span>, mono: false }] : []),
          { label: t('identity.passkeys.title'), value: <span className="al-num">{s.passkeys}</span>, mono: false },
        ]}
      />
      {low ? <Banner tone="warn">{t('identity.recovery.lowWarning', { count: s.recoveryCodesLeft })}</Banner> : null}
      <div className="id-actions">
        {s.totp ? (
          <>
            <Button variant="secondary" onClick={() => setProof('regenerate')}>
              {t('identity.recovery.regenerate')}
            </Button>
            <Button variant="danger" onClick={() => setProof('disable')}>
              {t('identity.totp.turnOff')}
            </Button>
          </>
        ) : (
          <Button variant="primary" loading={start.isPending} onClick={() => start.mutate(undefined, { onSuccess: setSetup })}>
            {t('identity.totp.setUp')}
          </Button>
        )}
      </div>
      <TotpSetupDialog
        setup={setup}
        onClose={() => setSetup(null)}
        onEnabled={(next) => {
          setSetup(null);
          setCodes(next);
          void refresh();
          toast.push({ tone: 'ok', title: t('identity.totp.enabled') });
        }}
      />
      <ProofDialog
        open={proof !== null}
        title={proof === 'disable' ? t('identity.totp.turnOffTitle') : t('identity.recovery.regenerateTitle')}
        confirmLabel={proof === 'disable' ? t('identity.totp.turnOff') : t('identity.recovery.regenerate')}
        danger={proof === 'disable'}
        onCancel={() => setProof(null)}
        onProof={async (p) => {
          if (proof === 'disable') {
            await myIdentityApi.totpDisable(p);
            toast.push({ tone: 'ok', title: t('identity.totp.disabled') });
          } else {
            const res = await myIdentityApi.regenerateRecovery(p);
            setCodes(res.codes);
          }
          setProof(null);
          await refresh();
        }}
      />
      <RecoveryCodesModal codes={codes} onClose={() => setCodes(null)} />
    </div>
  );
}

export function PasskeysPanel() {
  const passkeys = useMyPasskeys();
  const qc = useQueryClient();
  const toast = useToast();
  const supported = passkeysSupported();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<PasskeyRecord | null>(null);
  const [removing, setRemoving] = useState<PasskeyRecord | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const refresh = () => qc.invalidateQueries({ queryKey: authKeys.all });

  const openAdd = () => {
    setName('');
    setError(null);
    setAdding(true);
  };
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ceremony, options } = await myIdentityApi.passkeyOptions();
      const response = await passkeyAttestation(options);
      await myIdentityApi.addPasskey({ ceremony, name: name.trim() || t('identity.passkeys.defaultName'), response: response as unknown as Record<string, unknown> });
      setAdding(false);
      toast.push({ tone: 'ok', title: t('identity.passkeys.added') });
      await refresh();
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const rename = async () => {
    if (!renaming || !name.trim()) return setError(t('identity.passkeys.nameRequired'));
    setBusy(true);
    setError(null);
    try {
      await myIdentityApi.renamePasskey(renaming.id, name.trim());
      setRenaming(null);
      await qc.invalidateQueries({ queryKey: identityKeys.passkeys });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<PasskeyRecord>> = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (p) => (
        <>
          {p.name}
          {p.backedUp ? <span className="al-sub">{t('identity.passkeys.synced')}</span> : null}
        </>
      ),
    },
    { key: 'created', header: t('identity.common.created'), cell: (p) => <When iso={p.createdAt} /> },
    { key: 'used', header: t('identity.common.lastUsed'), cell: (p) => <When iso={p.lastUsedAt} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      align: 'right',
      mobile: 'end',
      cell: (p) => (
        <span className="al-row-actions">
          <Button size="sm" variant="ghost" aria-label={t('identity.passkeys.renameName', { name: p.name })} onClick={() => { setName(p.name); setError(null); setRenaming(p); }}>
            {t('identity.common.rename')}
          </Button>
          <Button size="sm" variant="danger" aria-label={t('identity.passkeys.removeName', { name: p.name })} onClick={() => setRemoving(p)}>
            {t('identity.common.remove')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="id-stack">
      <p className="id-muted al-caption">{t('identity.passkeys.help')}</p>
      {passkeys.isError ? (
        <ErrorBlock title={t('identity.passkeys.couldNotLoad')} onRetry={() => void passkeys.refetch()}>
          {errorMessage(passkeys.error)}
        </ErrorBlock>
      ) : (
        <Table caption={t('identity.passkeys.title')} density="dense" columns={columns} rows={passkeys.data} loading={passkeys.isPending} rowKey={(p) => p.id} empty={t('identity.passkeys.none')} />
      )}
      {supported ? (
        <div className="id-actions">
          <Button variant="secondary" onClick={openAdd}>
            {t('identity.passkeys.add')}
          </Button>
        </div>
      ) : (
        <p className="id-muted al-caption">{t('identity.passkeys.unsupported')}</p>
      )}
      <Modal
        open={adding || renaming !== null}
        size={440}
        onClose={() => { setAdding(false); setRenaming(null); }}
        title={renaming ? t('identity.passkeys.renameTitle') : t('identity.passkeys.add')}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setAdding(false); setRenaming(null); }}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void (renaming ? rename() : add())}>
              {renaming ? t('common.save') : t('identity.passkeys.create')}
            </Button>
          </>
        }
      >
        <form className="id-stack" onSubmit={(e) => { e.preventDefault(); void (renaming ? rename() : add()); }} noValidate>
          <Field label={t('common.name')} htmlFor={nameId} hint={renaming ? undefined : t('identity.passkeys.nameHint')}>
            <Input id={nameId} maxLength={64} value={name} placeholder={t('identity.passkeys.namePlaceholder')} onChange={(e) => setName(e.currentTarget.value)} />
          </Field>
          {error ? (
            <p className="al-inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      </Modal>
      <ConfirmDialog
        open={removing !== null}
        title={t('identity.passkeys.removeTitle', { name: removing?.name ?? '' })}
        confirmLabel={t('identity.passkeys.removeConfirm')}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) await myIdentityApi.removePasskey(removing.id);
          setRemoving(null);
          await refresh();
        }}
      >
        {t('identity.passkeys.removeHelp')}
      </ConfirmDialog>
    </div>
  );
}

/** `LAST_SIGN_IN_METHOD` (409) and the rest, for unlink confirms. */
export function unlinkError(err: unknown): string | undefined {
  if (err instanceof ApiError && err.code === 'LAST_SIGN_IN_METHOD') return t('identity.linked.lastMethod');
  return undefined;
}

export function LinkedSignInsPanel() {
  const { status } = useAuth();
  const providers = status?.signIn?.providers ?? [];
  const identities = useMyIdentities(providers.length > 0);
  const qc = useQueryClient();
  const here = useRouterState({ select: (s) => s.location.pathname });
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<LinkedIdentity | null>(null);

  if (providers.length === 0 && !(identities.data?.length ?? 0)) return <p className="id-muted al-caption">{t('identity.linked.noProviders')}</p>;
  if (identities.isPending) return <Skeleton lines={2} />;
  if (identities.isError) return <ErrorBlock title={t('identity.linked.couldNotLoad')} onRetry={() => void identities.refetch()}>{errorMessage(identities.error)}</ErrorBlock>;

  const link = async (id: string) => {
    setLinking(id);
    setError(null);
    try {
      const { url } = await myIdentityApi.linkStart(id, here);
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setLinking(null);
    }
  };

  const rows = [
    ...identities.data.map((i) => ({ key: `i${i.id}`, providerId: i.providerId, name: i.providerName, identity: i as LinkedIdentity | null })),
    ...providers.filter((p) => !identities.data.some((i) => i.providerId === p.id)).map((p) => ({ key: `p${p.id}`, providerId: p.id, name: p.name, identity: null as LinkedIdentity | null })),
  ];
  type Row = (typeof rows)[number];
  const columns: Array<Column<Row>> = [
    { key: 'name', header: t('identity.linked.provider'), cell: (r) => r.name },
    { key: 'email', header: t('common.email'), mono: true, cell: (r) => r.identity?.email ?? (r.identity ? '—' : <span className="al-muted">{t('identity.linked.notLinked')}</span>) },
    { key: 'used', header: t('identity.common.lastUsed'), cell: (r) => (r.identity ? <When iso={r.identity.lastLoginAt} /> : '') },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      align: 'right',
      mobile: 'end',
      cell: (r) =>
        r.identity ? (
          <Button size="sm" variant="danger" aria-label={t('identity.linked.unlinkName', { name: r.name })} onClick={() => setUnlinking(r.identity)}>
            {t('identity.linked.unlink')}
          </Button>
        ) : providers.some((p) => p.id === r.providerId) ? (
          <Button size="sm" variant="secondary" loading={linking === r.providerId} aria-label={t('identity.linked.linkName', { name: r.name })} onClick={() => void link(r.providerId)}>
            {t('identity.linked.link')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="id-stack">
      <p className="id-muted al-caption">{t('identity.linked.help')}</p>
      <Table caption={t('identity.linked.title')} density="dense" columns={columns} rows={rows} rowKey={(r) => r.key} empty={t('identity.linked.noProviders')} />
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={unlinking !== null}
        title={t('identity.linked.unlinkTitle', { name: unlinking?.providerName ?? '' })}
        confirmLabel={t('identity.linked.unlink')}
        onCancel={() => setUnlinking(null)}
        describeError={unlinkError}
        onConfirm={async () => {
          if (unlinking) await myIdentityApi.unlink(unlinking.id);
          setUnlinking(null);
          await qc.invalidateQueries({ queryKey: identityKeys.identities });
        }}
      >
        {t('identity.linked.unlinkHelp')}
      </ConfirmDialog>
    </div>
  );
}

const SCOPE_LABEL: Record<ApiKeyScope, () => string> = {
  read: () => t('identity.apiKeys.scopeRead'),
  requests: () => t('identity.apiKeys.scopeRequests'),
  admin: () => t('identity.apiKeys.scopeAdmin'),
};

export function scopeLabel(scope: ApiKeyScope): string {
  return SCOPE_LABEL[scope]();
}

export function ScopeChip({ scope }: { scope: ApiKeyScope }) {
  return <Chip tone={scope === 'admin' ? 'warn' : scope === 'requests' ? 'accent' : 'neutral'}>{scopeLabel(scope)}</Chip>;
}

const EXPIRY_OPTIONS = [
  { value: '0', get label() { return t('identity.apiKeys.never'); } },
  { value: '30', get label() { return t('identity.apiKeys.days', { count: 30 }); } },
  { value: '90', get label() { return t('identity.apiKeys.days', { count: 90 }); } },
  { value: '365', get label() { return t('identity.apiKeys.days', { count: 365 }); } },
];

/** The new key, shown once with a copy button. */
export function NewKeyModal({ created, onClose }: { created: UserApiKeyCreated | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!created) return null;
  return (
    <Modal
      open
      size={560}
      dismissOnScrim={false}
      onClose={onClose}
      title={t('identity.apiKeys.createdTitle', { name: created.name })}
      footer={
        <>
          <Button variant="secondary" onClick={() => void copyText(created.key).then(setCopied)}>
            {copied ? t('settings.security.apiKey.copied') : t('common.copy')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('identity.common.done')}
          </Button>
        </>
      }
    >
      <div className="id-stack">
        <p className="id-muted">{t('identity.apiKeys.createdHelp')}</p>
        <code className="id-key" data-testid="new-api-key">
          {created.key}
        </code>
        <p className="id-muted al-caption">{t('identity.apiKeys.usage')}</p>
      </div>
    </Modal>
  );
}

export function ApiKeysPanel() {
  const { isAdmin } = useAuth();
  const keys = useMyApiKeys();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<UserApiKeyCreated | null>(null);
  const [revoking, setRevoking] = useState<UserApiKey | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiKeyScope>('read');
  const [expires, setExpires] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), scope: useId(), expires: useId() };
  const create = useMutation({ mutationFn: myIdentityApi.createApiKey, meta: { silent: true } });
  const scopes: ApiKeyScope[] = isAdmin ? ['read', 'requests', 'admin'] : ['read', 'requests'];

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return setError(t('identity.apiKeys.nameRequired'));
    setError(null);
    const days = Number(expires);
    create.mutate(
      { name: name.trim(), scope, ...(days > 0 ? { expiresInDays: days } : {}) },
      {
        onSuccess: (key) => {
          setCreating(false);
          setCreated(key);
          void qc.invalidateQueries({ queryKey: identityKeys.apiKeys });
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const columns: Array<Column<UserApiKey>> = [
    { key: 'name', header: t('common.name'), cell: (k) => k.name },
    { key: 'scope', header: t('identity.apiKeys.scope'), cell: (k) => <ScopeChip scope={k.scope} /> },
    { key: 'prefix', header: t('identity.apiKeys.prefix'), mono: true, cell: (k) => `${k.prefix}…` },
    { key: 'created', header: t('identity.common.created'), cell: (k) => <When iso={k.createdAt} /> },
    { key: 'used', header: t('identity.common.lastUsed'), cell: (k) => <When iso={k.lastUsedAt} /> },
    { key: 'expires', header: t('settings.security.expires'), cell: (k) => <When iso={k.expiresAt} empty={t('identity.apiKeys.never')} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      align: 'right',
      mobile: 'end',
      cell: (k) => (
        <Button size="sm" variant="danger" aria-label={t('identity.apiKeys.revokeName', { name: k.name })} onClick={() => setRevoking(k)}>
          {t('settings.security.revoke')}
        </Button>
      ),
    },
  ];

  return (
    <div className="id-stack">
      <p className="id-muted al-caption">{t('identity.apiKeys.help')}</p>
      {keys.isError ? (
        <ErrorBlock title={t('identity.apiKeys.couldNotLoad')} onRetry={() => void keys.refetch()}>
          {errorMessage(keys.error)}
        </ErrorBlock>
      ) : (
        <Table caption={t('identity.apiKeys.title')} density="dense" columns={columns} rows={keys.data} loading={keys.isPending} rowKey={(k) => k.id} empty={t('identity.apiKeys.none')} />
      )}
      <div className="id-actions">
        <Button
          variant="secondary"
          onClick={() => {
            setName('');
            setScope('read');
            setExpires('0');
            setError(null);
            setCreating(true);
          }}
        >
          {t('identity.apiKeys.create')}
        </Button>
      </div>
      <Modal
        open={creating}
        size={440}
        onClose={() => setCreating(false)}
        title={t('identity.apiKeys.create')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => submit()}>
              {t('identity.apiKeys.createButton')}
            </Button>
          </>
        }
      >
        <form className="id-stack" onSubmit={submit} noValidate>
          <Field label={t('common.name')} htmlFor={ids.name} hint={t('identity.apiKeys.nameHint')}>
            <Input id={ids.name} maxLength={64} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </Field>
          <Field label={t('identity.apiKeys.scope')} htmlFor={ids.scope} hint={t(`identity.apiKeys.scopeHint.${scope}`)}>
            <Select id={ids.scope} value={scope} options={scopes.map((s) => ({ value: s, label: scopeLabel(s) }))} onChange={(e) => setScope(e.currentTarget.value as ApiKeyScope)} />
          </Field>
          <Field label={t('identity.apiKeys.expiresIn')} htmlFor={ids.expires}>
            <Select id={ids.expires} value={expires} options={EXPIRY_OPTIONS} onChange={(e) => setExpires(e.currentTarget.value)} />
          </Field>
          {error ? (
            <p className="al-inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      </Modal>
      <NewKeyModal created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={revoking !== null}
        title={t('identity.apiKeys.revokeTitle', { name: revoking?.name ?? '' })}
        confirmLabel={t('identity.apiKeys.revokeConfirm')}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (revoking) await myIdentityApi.revokeApiKey(revoking.id);
          setRevoking(null);
          await qc.invalidateQueries({ queryKey: identityKeys.apiKeys });
        }}
      >
        {t('identity.apiKeys.revokeHelp')}
      </ConfirmDialog>
    </div>
  );
}
