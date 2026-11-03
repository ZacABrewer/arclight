import { useEffect, useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ForwardAuthSettings,
  OidcProvider,
  OidcProviderId,
  type IdentitySettings,
  type OidcMatchBy,
  type OidcProvider as OidcProviderType,
  type OidcTestResult,
  type UserApiKeyAdminRecord,
  type UserRole,
} from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { identityAdminApi } from '../../api/identity.js';
import { Banner, Button, Chip, ErrorBlock, Field, FormRow, FormSection, Input, Modal, Select, Skeleton, Table, Textarea, Toggle, type Column } from '../../arclight/index.js';
import { authKeys } from '../../auth/guard.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { useInvalidatingMutation } from '../../hooks/settings-keys.js';
import { identityKeys, useAllApiKeys, useIdentitySettings } from '../../hooks/identity.js';
import { appOrigin } from '../../lib/base-path.js';
import { copyText } from '../../lib/clipboard.js';
import { useDraft } from '../../pages/settings/settings-layout.js';
import { EditorFooter, SettingsSection } from '../../pages/settings/shared.js';
import { ScopeChip, When } from './security-panels.js';
import { t } from '../../i18n/index.js';
import './identity.css';

// Settings > Security (admin): OpenID Connect providers, the sign-in policy toggles,
// forward-auth from a trusted reverse proxy, and every user's API keys. Saved through the
// page's unsaved-changes bar together with the authentication form.

/** "a, b | c" or one per line → ["a", "b", "c"]. */
export function parseList(text: string): string[] {
  return text
    .split(/[\n,|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const IP_OR_CIDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]*:[0-9a-fA-F:.]*)(?:\/\d{1,3})?$/;

/** Entries of the trusted-proxy list that are not an IP or CIDR. */
export function invalidProxies(list: readonly string[]): string[] {
  return list.filter((p) => !IP_OR_CIDR.test(p));
}

/** Problems with a provider draft (null: fine). `others`: the ids already taken. */
export function providerProblem(p: OidcProviderType, others: readonly string[]): string | null {
  if (!OidcProviderId.safeParse(p.id).success) return t('identity.settings.idInvalid');
  if (others.includes(p.id)) return t('identity.settings.idTaken');
  if (!p.name.trim()) return t('identity.settings.nameRequired');
  if (!/^https?:\/\/\S+$/.test(p.issuer.trim())) return t('identity.settings.issuerInvalid');
  if (!p.clientId.trim()) return t('identity.settings.clientIdRequired');
  return null;
}

/** A fresh provider with the contract's defaults. */
export function newProvider(): OidcProviderType {
  // Parsed for the defaults; issuer and client id start empty for the admin to fill in.
  return { ...OidcProvider.parse({ id: 'sso', name: 'SSO', issuer: 'https://auth.example.com', clientId: 'x' }), issuer: '', clientId: '' };
}

function toSettings(d: IdentitySettings): IdentitySettings {
  return { providers: d.providers, hidePasswordLogin: d.hidePasswordLogin, requireTwoFactorForAdmins: d.requireTwoFactorForAdmins, forwardAuth: d.forwardAuth };
}

export function useIdentitySettingsForm() {
  const query = useIdentitySettings();
  const save = useInvalidatingMutation((body: IdentitySettings) => identityAdminApi.updateSettings(body), [identityKeys.settings, authKeys.status], {
    errorTitle: t('identity.settings.couldNotSave'),
  });
  const saved = useMemo<IdentitySettings | null>(() => (query.data ? toSettings(query.data) : null), [query.data]);
  const draft = useDraft<IdentitySettings | null>(saved);
  const proxyProblems = draft.value ? invalidProxies(draft.value.forwardAuth.trustedProxies) : [];
  const valid = proxyProblems.length === 0;
  return { query, save, draft, valid, proxyProblems, redirectUris: query.data?.redirectUris ?? {} };
}
export type IdentitySettingsForm = ReturnType<typeof useIdentitySettingsForm>;

/** Text field for a list (comma, pipe or newline separated) that keeps what is being typed. */
function ListInput({ id, value, onChange, multiline, placeholder }: { id?: string; value: readonly string[]; onChange: (v: string[]) => void; multiline?: boolean; placeholder?: string }) {
  const [text, setText] = useState(value.join(multiline ? '\n' : ', '));
  useEffect(() => {
    if (parseList(text).join('\u0000') !== value.join('\u0000')) setText(value.join(multiline ? '\n' : ', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.join('\u0000')]);
  const change = (next: string) => {
    setText(next);
    onChange(parseList(next));
  };
  return multiline ? (
    <Textarea id={id} mono rows={3} value={text} placeholder={placeholder} onChange={(e) => change(e.currentTarget.value)} />
  ) : (
    <Input id={id} mono value={text} placeholder={placeholder} onChange={(e) => change(e.currentTarget.value)} />
  );
}

const ROLE_OPTIONS = [
  { value: 'user', get label() { return t('common.user'); } },
  { value: 'admin', get label() { return t('common.admin'); } },
];

/** The callback URL to register at the provider (the api's, else what it will be). */
export function redirectUriFor(id: string, known: Record<string, string>): string {
  return known[id] ?? `${appOrigin()}/api/v1/auth/oidc/${id}/callback`;
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="id-redirect">
      <code>{value}</code>
      <Button size="sm" variant="ghost" aria-label={label} onClick={() => void copyText(value).then(setCopied)}>
        {copied ? t('settings.security.apiKey.copied') : t('common.copy')}
      </Button>
    </span>
  );
}

function ProviderEditor({
  provider,
  isNew,
  takenIds,
  redirectUris,
  onApply,
  onDelete,
  onClose,
}: {
  provider: OidcProviderType;
  isNew: boolean;
  takenIds: string[];
  redirectUris: Record<string, string>;
  onApply: (p: OidcProviderType) => void;
  onDelete?: (() => void) | undefined;
  onClose: () => void;
}) {
  const [d, setD] = useState<OidcProviderType>(provider);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<OidcTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const id = useId();
  const set = (patch: Partial<OidcProviderType>) => setD((v) => ({ ...v, ...patch }));
  const text = (k: 'id' | 'name' | 'issuer' | 'clientId' | 'clientSecret' | 'scopes' | 'groupsClaim' | 'usernameClaim') => ({
    id: `${id}-${k}`,
    value: d[k],
    onChange: (e: { currentTarget: HTMLInputElement }) => set({ [k]: e.currentTarget.value }),
  });
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await identityAdminApi.testProvider(d.issuer.trim()));
    } catch (err) {
      setTest({ ok: false, error: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };
  const apply = () => {
    const trimmed = { ...d, id: d.id.trim(), name: d.name.trim(), issuer: d.issuer.trim(), clientId: d.clientId.trim() };
    const problem = providerProblem(trimmed, takenIds);
    setError(problem);
    if (!problem) onApply(trimmed);
  };
  const toggle = (k: 'enabled' | 'trustUnverifiedEmail' | 'autoCreate' | 'showOnLogin' | 'showOnPortal', label: string, caption?: string) => (
    <FormRow label={label} captionInline caption={caption}>
      <Toggle aria-label={label} checked={d[k]} onChange={(e) => set({ [k]: e.currentTarget.checked })} />
    </FormRow>
  );

  return (
    <Modal
      open
      size={640}
      onClose={onClose}
      title={isNew ? t('identity.settings.addProvider') : t('identity.settings.editProvider', { name: provider.name })}
      footer={<EditorFooter onCancel={onClose} onSave={apply} saveLabel={t('identity.settings.apply')} onDelete={onDelete} deleteLabel={t('identity.settings.removeProvider')} />}
    >
      <div className="al-editor-stack">
        <div className="id-grid-2">
          <Field label={t('identity.settings.providerId')} htmlFor={`${id}-id`} hint={t('identity.settings.providerIdHint')}>
            <Input {...text('id')} mono readOnly={!isNew} autoComplete="off" />
          </Field>
          <Field label={t('identity.settings.buttonName')} htmlFor={`${id}-name`} hint={t('identity.settings.buttonNameHint')}>
            <Input {...text('name')} autoComplete="off" />
          </Field>
        </div>
        <Field label={t('identity.settings.issuer')} htmlFor={`${id}-issuer`} hint={t('identity.settings.issuerHint')}>
          <Input {...text('issuer')} mono type="url" placeholder="https://auth.example.com/application/o/arclight/" autoComplete="off" />
        </Field>
        <div className="id-actions">
          <Button size="sm" variant="secondary" loading={testing} onClick={() => void runTest()}>
            {t('identity.settings.test')}
          </Button>
        </div>
        {test ? (
          <p className="id-test-result" role="status" data-ok={test.ok}>
            {test.ok ? t('identity.settings.testOk', { issuer: test.issuer ?? d.issuer }) : t('identity.settings.testFailed', { error: test.error ?? '' })}
          </p>
        ) : null}
        <Field label={t('identity.settings.redirectUri')} hint={redirectUris[d.id] ? t('identity.settings.redirectUriHint') : t('identity.settings.redirectUriAfterSave')}>
          <CopyValue value={redirectUriFor(d.id || 'sso', redirectUris)} label={t('identity.settings.copyRedirectUri')} />
        </Field>
        <div className="id-grid-2">
          <Field label={t('identity.settings.clientId')} htmlFor={`${id}-clientId`}>
            <Input {...text('clientId')} mono autoComplete="off" />
          </Field>
          <Field label={t('identity.settings.clientSecret')} htmlFor={`${id}-clientSecret`} hint={t('identity.settings.clientSecretHint')}>
            <Input {...text('clientSecret')} mono type="password" autoComplete="new-password" />
          </Field>
        </div>
        <Field label={t('identity.settings.scopes')} htmlFor={`${id}-scopes`} hint={t('identity.settings.scopesHint')}>
          <Input {...text('scopes')} mono />
        </Field>
        <FormSection label={t('identity.settings.accounts')}>
          <FormRow label={t('identity.settings.matchBy')} htmlFor={`${id}-match`} caption={t('identity.settings.matchByHint')}>
            <Select
              id={`${id}-match`}
              className="al-select--fit"
              value={d.matchBy}
              options={[
                { value: 'email', label: t('identity.settings.matchEmail') },
                { value: 'none', label: t('identity.settings.matchNone') },
              ]}
              onChange={(e) => set({ matchBy: e.currentTarget.value as OidcMatchBy })}
            />
          </FormRow>
          {toggle('trustUnverifiedEmail', t('identity.settings.trustUnverified'), t('identity.settings.trustUnverifiedHint'))}
          {toggle('autoCreate', t('identity.settings.autoCreate'), t('identity.settings.autoCreateHint'))}
          <FormRow label={t('identity.settings.defaultRole')} htmlFor={`${id}-role`}>
            <Select id={`${id}-role`} className="al-select--fit" value={d.defaultRole} options={ROLE_OPTIONS} onChange={(e) => set({ defaultRole: e.currentTarget.value as UserRole })} />
          </FormRow>
          <FormRow label={t('identity.settings.usernameClaim')} htmlFor={`${id}-usernameClaim`}>
            <Input {...text('usernameClaim')} mono />
          </FormRow>
        </FormSection>
        <FormSection label={t('identity.settings.groups')}>
          <FormRow label={t('identity.settings.groupsClaim')} htmlFor={`${id}-groupsClaim`}>
            <Input {...text('groupsClaim')} mono />
          </FormRow>
          <FormRow label={t('identity.settings.adminGroups')} htmlFor={`${id}-admin`} caption={t('identity.settings.adminGroupsHint')}>
            <ListInput id={`${id}-admin`} value={d.adminGroups} onChange={(adminGroups) => set({ adminGroups })} />
          </FormRow>
          <FormRow label={t('identity.settings.allowedGroups')} htmlFor={`${id}-allowed`} caption={t('identity.settings.allowedGroupsHint')}>
            <ListInput id={`${id}-allowed`} value={d.allowedGroups} onChange={(allowedGroups) => set({ allowedGroups })} />
          </FormRow>
        </FormSection>
        <FormSection label={t('identity.settings.buttons')}>
          {toggle('showOnLogin', t('identity.settings.showOnLogin'))}
          {toggle('showOnPortal', t('identity.settings.showOnPortal'))}
          {toggle('enabled', t('identity.settings.enabled'))}
        </FormSection>
        {error ? (
          <p className="al-inline-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function SectionState({ form, label }: { form: IdentitySettingsForm; label: string }) {
  if (form.query.isError) {
    return (
      <SettingsSection label={label}>
        <ErrorBlock title={t('identity.settings.couldNotLoad')} onRetry={() => void form.query.refetch()}>
          {errorMessage(form.query.error)}
        </ErrorBlock>
      </SettingsSection>
    );
  }
  return (
    <SettingsSection label={label}>
      <Skeleton lines={3} />
    </SettingsSection>
  );
}

export function IdentityProvidersSection({ form }: { form: IdentitySettingsForm }) {
  const [editing, setEditing] = useState<{ index: number | null; provider: OidcProviderType } | null>(null);
  const value = form.draft.value;
  const label = t('identity.settings.providersTitle');
  if (!value) return <SectionState form={form} label={label} />;
  const providers = value.providers;
  const setProviders = (next: OidcProviderType[]) => form.draft.set((d) => (d ? { ...d, providers: next } : d));

  const columns: Array<Column<OidcProviderType>> = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (p) => (
        <>
          {p.name}
          <span className="al-sub al-num">{p.id}</span>
        </>
      ),
    },
    { key: 'issuer', header: t('identity.settings.issuer'), mono: true, cell: (p) => <span className="al-ua">{p.issuer}</span> },
    {
      key: 'status',
      header: t('common.status'),
      cell: (p) => (p.enabled ? <Chip tone="accent">{t('identity.settings.on')}</Chip> : <Chip tone="neutral">{t('identity.settings.off')}</Chip>),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      align: 'right',
      mobile: 'end',
      cell: (p) => (
        <Button size="sm" variant="ghost" aria-label={t('identity.settings.editProvider', { name: p.name })} onClick={() => setEditing({ index: providers.indexOf(p), provider: p })}>
          {t('common.edit')}
        </Button>
      ),
    },
  ];

  return (
    <SettingsSection
      label={label}
      count={providers.length}
      action={
        <Button size="sm" variant="secondary" disabled={providers.length >= 10} onClick={() => setEditing({ index: null, provider: newProvider() })}>
          {t('identity.settings.addProvider')}
        </Button>
      }
    >
      <p className="al-caption id-muted">{t('identity.settings.providersHelp')}</p>
      <Table caption={label} density="dense" columns={columns} rows={providers} rowKey={(p) => p.id} empty={t('identity.settings.noProviders')} />
      {editing ? (
        <ProviderEditor
          key={editing.index ?? 'new'}
          provider={editing.provider}
          isNew={editing.index === null}
          takenIds={providers.filter((_, i) => i !== editing.index).map((p) => p.id)}
          redirectUris={form.redirectUris}
          onClose={() => setEditing(null)}
          onApply={(p) => {
            setProviders(editing.index === null ? [...providers, p] : providers.map((x, i) => (i === editing.index ? p : x)));
            setEditing(null);
          }}
          onDelete={
            editing.index === null
              ? undefined
              : () => {
                  setProviders(providers.filter((_, i) => i !== editing.index));
                  setEditing(null);
                }
          }
        />
      ) : null}
    </SettingsSection>
  );
}

export function SignInPolicySection({ form }: { form: IdentitySettingsForm }) {
  const value = form.draft.value;
  const label = t('identity.settings.policyTitle');
  if (!value) return <SectionState form={form} label={label} />;
  const set = (patch: Partial<IdentitySettings>) => form.draft.set((d) => (d ? { ...d, ...patch } : d));
  return (
    <FormSection label={label}>
      <FormRow label={t('identity.settings.hidePassword')} captionInline caption={t('identity.settings.hidePasswordHint')}>
        <Toggle aria-label={t('identity.settings.hidePassword')} checked={value.hidePasswordLogin} onChange={(e) => set({ hidePasswordLogin: e.currentTarget.checked })} />
      </FormRow>
      <FormRow label={t('identity.settings.requireTwoFactor')} captionInline caption={t('identity.settings.requireTwoFactorHint')}>
        <Toggle aria-label={t('identity.settings.requireTwoFactor')} checked={value.requireTwoFactorForAdmins} onChange={(e) => set({ requireTwoFactorForAdmins: e.currentTarget.checked })} />
      </FormRow>
    </FormSection>
  );
}

export function ForwardAuthSection({ form }: { form: IdentitySettingsForm }) {
  const value = form.draft.value;
  const id = useId();
  const label = t('identity.forward.title');
  if (!value) return <SectionState form={form} label={label} />;
  const fa = value.forwardAuth;
  const set = (patch: Partial<ForwardAuthSettings>) => form.draft.set((d) => (d ? { ...d, forwardAuth: { ...d.forwardAuth, ...patch } } : d));
  const header = (k: 'userHeader' | 'emailHeader' | 'nameHeader' | 'groupsHeader', text: string) => (
    <FormRow label={text} htmlFor={`${id}-${k}`}>
      <Input id={`${id}-${k}`} mono value={fa[k]} onChange={(e) => set({ [k]: e.currentTarget.value })} />
    </FormRow>
  );
  return (
    <FormSection label={label}>
      <Banner tone="warn">{t('identity.forward.warning')}</Banner>
      <FormRow label={t('identity.forward.enabled')} captionInline caption={t('identity.forward.enabledHint')}>
        <Toggle aria-label={t('identity.forward.enabled')} checked={fa.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
      </FormRow>
      <FormRow
        label={t('identity.forward.trustedProxies')}
        htmlFor={`${id}-proxies`}
        caption={t('identity.forward.trustedProxiesHint')}
        error={form.proxyProblems.length ? t('identity.forward.invalidProxies', { list: form.proxyProblems.join(', ') }) : undefined}
      >
        <ListInput id={`${id}-proxies`} multiline value={fa.trustedProxies} onChange={(trustedProxies) => set({ trustedProxies })} placeholder="172.18.0.2" />
      </FormRow>
      {header('userHeader', t('identity.forward.userHeader'))}
      {header('emailHeader', t('identity.forward.emailHeader'))}
      {header('nameHeader', t('identity.forward.nameHeader'))}
      {header('groupsHeader', t('identity.forward.groupsHeader'))}
      <FormRow label={t('identity.settings.autoCreate')} captionInline caption={t('identity.forward.autoCreateHint')}>
        <Toggle aria-label={t('identity.settings.autoCreate')} checked={fa.autoCreate} onChange={(e) => set({ autoCreate: e.currentTarget.checked })} />
      </FormRow>
      <FormRow label={t('identity.forward.allowAdmins')} captionInline caption={t('identity.forward.allowAdminsHint')}>
        <Toggle aria-label={t('identity.forward.allowAdmins')} checked={fa.allowAdmins} onChange={(e) => set({ allowAdmins: e.currentTarget.checked })} />
      </FormRow>
      <FormRow label={t('identity.settings.defaultRole')} htmlFor={`${id}-role`}>
        <Select id={`${id}-role`} className="al-select--fit" value={fa.defaultRole} options={ROLE_OPTIONS} onChange={(e) => set({ defaultRole: e.currentTarget.value as UserRole })} />
      </FormRow>
      <FormRow label={t('identity.settings.adminGroups')} htmlFor={`${id}-admin`} caption={t('identity.settings.adminGroupsHint')}>
        <ListInput id={`${id}-admin`} value={fa.adminGroups} onChange={(adminGroups) => set({ adminGroups })} />
      </FormRow>
      <FormRow label={t('identity.settings.allowedGroups')} htmlFor={`${id}-allowed`} caption={t('identity.settings.allowedGroupsHint')}>
        <ListInput id={`${id}-allowed`} value={fa.allowedGroups} onChange={(allowedGroups) => set({ allowedGroups })} />
      </FormRow>
    </FormSection>
  );
}

/** Every user's personal API keys, with revoke. */
export function AllApiKeysSection() {
  const keys = useAllApiKeys();
  const qc = useQueryClient();
  const [revoking, setRevoking] = useState<UserApiKeyAdminRecord | null>(null);
  const columns: Array<Column<UserApiKeyAdminRecord>> = [
    { key: 'name', header: t('common.name'), cell: (k) => k.name },
    { key: 'user', header: t('common.user'), sortValue: (k) => k.username, cell: (k) => k.username },
    { key: 'scope', header: t('identity.apiKeys.scope'), cell: (k) => <ScopeChip scope={k.scope} /> },
    { key: 'prefix', header: t('identity.apiKeys.prefix'), mono: true, cell: (k) => `${k.prefix}…` },
    { key: 'used', header: t('identity.common.lastUsed'), sortValue: (k) => k.lastUsedAt ?? null, cell: (k) => <When iso={k.lastUsedAt} /> },
    { key: 'expires', header: t('settings.security.expires'), cell: (k) => <When iso={k.expiresAt} empty={t('identity.apiKeys.never')} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      align: 'right',
      mobile: 'end',
      cell: (k) => (
        <Button size="sm" variant="danger" aria-label={t('identity.apiKeys.revokeNameOfUser', { name: k.name, user: k.username })} onClick={() => setRevoking(k)}>
          {t('settings.security.revoke')}
        </Button>
      ),
    },
  ];
  return (
    <SettingsSection label={t('identity.apiKeys.allTitle')} {...(keys.data ? { count: keys.data.length } : {})}>
      {keys.isError ? (
        <ErrorBlock title={t('identity.apiKeys.couldNotLoad')} onRetry={() => void keys.refetch()}>
          {errorMessage(keys.error)}
        </ErrorBlock>
      ) : (
        <Table caption={t('identity.apiKeys.allTitle')} density="dense" columns={columns} rows={keys.data} loading={keys.isPending} rowKey={(k) => k.id} sortable empty={t('identity.apiKeys.noneAll')} />
      )}
      <ConfirmDialog
        open={revoking !== null}
        title={t('identity.apiKeys.revokeTitle', { name: revoking?.name ?? '' })}
        confirmLabel={t('identity.apiKeys.revokeConfirm')}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (revoking) await identityAdminApi.revokeApiKey(revoking.id);
          setRevoking(null);
          await qc.invalidateQueries({ queryKey: identityKeys.allApiKeys });
        }}
      >
        {t('identity.apiKeys.revokeHelpAdmin', { user: revoking?.username ?? '' })}
      </ConfirmDialog>
    </SettingsSection>
  );
}
