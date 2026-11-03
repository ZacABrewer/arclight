import { z } from 'zod';

// Sign-in hardening: external identity providers (OpenID Connect), forward-auth from a trusted
// reverse proxy, two-factor (TOTP, recovery codes, passkeys) and per-user API keys. Arclight
// stays its own account system; an identity provider only proves who someone is, and the
// Arclight account (role, permissions, requests) stays here. Behaviour:
// docs/using/single-sign-on.md and docs/using/users-and-security.md.

/** Same values as UserRole in auth.ts (kept here so auth.ts can import this file). */
const UserRole = z.enum(['admin', 'user']);

// ---------------------------------------------------------------------------------------
// OpenID Connect providers (settings section `identity`)
// ---------------------------------------------------------------------------------------

/** Lowercase slug used in URLs: /api/v1/auth/oidc/<id>/callback. */
export const OidcProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and - only');
export type OidcProviderId = z.infer<typeof OidcProviderId>;

/** How a first sign-in finds the Arclight account when no link exists yet. */
export const OidcMatchBy = z.enum(['email', 'none']);
export type OidcMatchBy = z.infer<typeof OidcMatchBy>;

const GroupList = z.array(z.string().trim().min(1).max(256)).max(50);

export const OidcProvider = z.object({
  id: OidcProviderId,
  /** Shown on the button: "Sign in with <name>". */
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean().default(true),
  /**
   * The issuer URL (https://auth.example.com/application/o/arclight/) or its discovery document
   * (…/.well-known/openid-configuration). The discovered `issuer` must match exactly.
   */
  issuer: z.string().trim().url({ protocol: /^https?$/ }).max(2048),
  clientId: z.string().trim().min(1).max(512),
  /** Empty for public clients (PKCE only). SECRET_MASK on read; sending it back keeps the stored one. */
  clientSecret: z.string().max(2048).default(''),
  /** Space-separated; `openid` is always added. */
  scopes: z.string().trim().max(512).default('openid email profile'),
  /**
   * email: a first sign-in links the user whose email matches a verified `email` claim (never an
   * admin account; admins link from their profile). none: only accounts linked from the profile
   * (or created by this sign-in) can sign in.
   */
  matchBy: OidcMatchBy.default('email'),
  /** Accept `email` without `email_verified: true` for matching (only for providers that never send it). */
  trustUnverifiedEmail: z.boolean().default(false),
  /** Create an Arclight account on a first sign-in that matches no one. */
  autoCreate: z.boolean().default(false),
  /** Role of auto-created accounts (group mapping below wins when it is set). */
  defaultRole: UserRole.default('user'),
  /** Claim holding the user's groups (Authentik, Authelia, Keycloak with a mapper, Pocket ID: `groups`). */
  groupsClaim: z.string().trim().min(1).max(128).default('groups'),
  /** Members of any of these groups get the admin role at every sign-in; others become users. Empty: roles are not synced. */
  adminGroups: GroupList.default([]),
  /** When not empty, only members of these groups (or the admin groups) may sign in. */
  allowedGroups: GroupList.default([]),
  /** Claim used for the username of created accounts (falls back to the email's local part, then `sub`). */
  usernameClaim: z.string().trim().min(1).max(128).default('preferred_username'),
  /** Show the button on the admin sign-in page. */
  showOnLogin: z.boolean().default(true),
  /** Show the button on the request portal's sign-in page. */
  showOnPortal: z.boolean().default(true),
});
export type OidcProvider = z.infer<typeof OidcProvider>;
export type OidcProviderInput = z.input<typeof OidcProvider>;

/** Forward-auth (trusted header) sign-in: a reverse proxy that already authenticated the user tells Arclight who it is. */
export const ForwardAuthSettings = z.object({
  enabled: z.boolean().default(false),
  /**
   * Socket peers allowed to send the headers: IPs or CIDRs (10.0.0.0/8, 172.18.0.2, fd00::/8).
   * The proxy's own address, never a client's; X-Forwarded-For is not consulted. Empty: nobody.
   */
  trustedProxies: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  /** Header with the username (Authelia, Authentik: Remote-User / X-authentik-username). */
  userHeader: z.string().trim().min(1).max(128).default('Remote-User'),
  emailHeader: z.string().trim().max(128).default('Remote-Email'),
  nameHeader: z.string().trim().max(128).default('Remote-Name'),
  /** Comma- or pipe-separated groups (Authentik: X-authentik-groups with `|`). */
  groupsHeader: z.string().trim().max(128).default('Remote-Groups'),
  /** Create the account when the header names an unknown user. */
  autoCreate: z.boolean().default(false),
  defaultRole: UserRole.default('user'),
  adminGroups: GroupList.default([]),
  allowedGroups: GroupList.default([]),
  /**
   * The header may sign in admin accounts. On by default (as before 0.24); turn it off so a
   * header that slips past the proxy can reach user accounts at most.
   */
  allowAdmins: z.boolean().default(true),
});
export type ForwardAuthSettings = z.infer<typeof ForwardAuthSettings>;

/** Stored settings section `identity` (GET/PUT /settings/identity, admin). */
export const IdentitySettings = z.object({
  providers: z.array(OidcProvider).max(10).default([]),
  /**
   * Hide the username/password form on the sign-in pages when a provider button is shown.
   * Break-glass: /login?local=1 always shows it, and admins can always sign in with their password.
   */
  hidePasswordLogin: z.boolean().default(false),
  /** Admins without a second factor must set one up before they can use the app (password sign-ins). */
  requireTwoFactorForAdmins: z.boolean().default(false),
  forwardAuth: ForwardAuthSettings.default(ForwardAuthSettings.parse({})),
});
export type IdentitySettings = z.infer<typeof IdentitySettings>;
export type IdentitySettingsInput = z.input<typeof IdentitySettings>;

/** A provider as the sign-in pages see it (GET /auth/status). */
export const OidcProviderPublic = z.object({
  id: OidcProviderId,
  name: z.string(),
  showOnLogin: z.boolean(),
  showOnPortal: z.boolean(),
});
export type OidcProviderPublic = z.infer<typeof OidcProviderPublic>;

/** GET /auth/status `signIn`: what the sign-in pages offer. */
export const SignInOptions = z.object({
  providers: z.array(OidcProviderPublic),
  /** The password form is hidden (break-glass: ?local=1). */
  hidePasswordLogin: z.boolean(),
  /** Passkey sign-in is offered (some account has a passkey). */
  passkeys: z.boolean(),
});
export type SignInOptions = z.infer<typeof SignInOptions>;

/** POST /settings/identity/test: checks a provider's discovery document. */
export const OidcTestRequest = z.object({ issuer: z.string().trim().url({ protocol: /^https?$/ }).max(2048) });
export const OidcTestResult = z.object({
  ok: z.boolean(),
  issuer: z.string().optional(),
  authorizationEndpoint: z.string().optional(),
  error: z.string().optional(),
});
export type OidcTestResult = z.infer<typeof OidcTestResult>;

/** GET /settings/identity: also the redirect URI to register at the provider. */
export const IdentitySettingsResponse = IdentitySettings.extend({
  /** Callback URL per provider id, as Arclight will send it (from the request's host, or the application URL). */
  redirectUris: z.record(z.string(), z.string()),
});
export type IdentitySettingsResponse = z.infer<typeof IdentitySettingsResponse>;

/** POST /auth/oidc/:id/link: where the browser goes to link that provider to the signed-in account. */
export const OidcLinkStart = z.object({ url: z.string() });
export type OidcLinkStart = z.infer<typeof OidcLinkStart>;

/** GET /user/me/identities, GET /user/:id/identities. */
export const LinkedIdentity = z.object({
  id: z.number().int(),
  providerId: z.string(),
  /** The provider's display name, or the id when the provider was removed. */
  providerName: z.string(),
  subject: z.string(),
  email: z.string().optional(),
  linkedAt: z.string(),
  lastLoginAt: z.string().optional(),
});
export type LinkedIdentity = z.infer<typeof LinkedIdentity>;

// ---------------------------------------------------------------------------------------
// two-factor
// ---------------------------------------------------------------------------------------

export const SecondFactor = z.enum(['totp', 'recovery', 'passkey']);
export type SecondFactor = z.infer<typeof SecondFactor>;

/** POST /auth/login answers this (200) instead of a session when the account has two-factor on. */
export const TwoFactorChallenge = z.object({
  twoFactorRequired: z.literal(true),
  /** Opaque, single-use, expires after 5 minutes or 5 wrong codes. */
  challenge: z.string(),
  methods: z.array(SecondFactor),
});
export type TwoFactorChallenge = z.infer<typeof TwoFactorChallenge>;

/** POST /auth/login/2fa. Exactly one of `code` (authenticator) or `recoveryCode`. */
export const TwoFactorLogin = z
  .object({
    challenge: z.string().min(1).max(256),
    code: z.string().trim().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().trim().min(8).max(32).optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), 'send code or recoveryCode');
export type TwoFactorLogin = z.infer<typeof TwoFactorLogin>;

/** GET /user/me/2fa (and GET /user/:id/2fa for admins). */
export const TwoFactorStatus = z.object({
  totp: z.boolean(),
  totpEnabledAt: z.string().optional(),
  recoveryCodesLeft: z.number().int(),
  passkeys: z.number().int(),
  /** The admin requirement applies to this account and it has no second factor yet. */
  setupRequired: z.boolean(),
});
export type TwoFactorStatus = z.infer<typeof TwoFactorStatus>;

/** POST /user/me/2fa/totp/setup: a fresh secret, pending until confirmed with a code. */
export const TotpSetup = z.object({
  secret: z.string(),
  /** otpauth://totp/… for the QR code. */
  uri: z.string(),
});
export type TotpSetup = z.infer<typeof TotpSetup>;

export const TotpCode = z.object({ code: z.string().trim().regex(/^\d{6}$/) });
export type TotpCode = z.infer<typeof TotpCode>;

/** DELETE /user/me/2fa/totp, POST /user/me/2fa/recovery: proves the factor (or a recovery code). */
export const TwoFactorProof = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().trim().min(8).max(32).optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), 'send code or recoveryCode');
export type TwoFactorProof = z.infer<typeof TwoFactorProof>;

/** Shown once: after enabling TOTP and after regenerating. */
export const RecoveryCodes = z.object({ codes: z.array(z.string()) });
export type RecoveryCodes = z.infer<typeof RecoveryCodes>;

// ---------------------------------------------------------------------------------------
// passkeys (WebAuthn)
// ---------------------------------------------------------------------------------------

/** One of the caller's passkeys (GET /user/me/passkeys). */
export const PasskeyRecord = z.object({
  id: z.number().int(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  /** Synced (multi-device) credential, e.g. iCloud Keychain or Google Password Manager. */
  backedUp: z.boolean(),
});
export type PasskeyRecord = z.infer<typeof PasskeyRecord>;

/** Options for navigator.credentials.* (JSON form, @simplewebauthn/browser takes them as is) plus the ceremony id. */
export const PasskeyOptions = z.object({
  ceremony: z.string(),
  options: z.record(z.string(), z.unknown()),
});
export type PasskeyOptions = z.infer<typeof PasskeyOptions>;

/**
 * Re-authentication for adding a passkey, an authenticator app or a personal API key: the
 * session must be younger than ten minutes, or the request carries the account's password.
 * The api answers 401 REAUTH_REQUIRED otherwise (accounts without a password sign in again).
 */
export const ReauthRequest = z.object({ currentPassword: z.string().min(1).max(1024).optional() });
export type ReauthRequest = z.infer<typeof ReauthRequest>;

/** POST /user/me/passkeys: finish registering. */
export const PasskeyRegister = z.object({
  ceremony: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(64).default('Passkey'),
  response: z.record(z.string(), z.unknown()),
});
export type PasskeyRegister = z.input<typeof PasskeyRegister>;

/**
 * POST /auth/passkey/options: `challenge` set = second step of a password sign-in (that account's
 * passkeys); absent = passwordless sign-in with a discoverable passkey.
 */
export const PasskeyLoginOptionsRequest = z.object({ challenge: z.string().max(256).optional() });

/** POST /auth/passkey/login. */
export const PasskeyLogin = z.object({
  ceremony: z.string().min(1).max(256),
  response: z.record(z.string(), z.unknown()),
  /** The password step's challenge when the passkey is the second factor. */
  challenge: z.string().max(256).optional(),
  rememberMe: z.boolean().default(true),
});
export type PasskeyLogin = z.input<typeof PasskeyLogin>;

export const PasskeyRename = z.object({ name: z.string().trim().min(1).max(64) });

// ---------------------------------------------------------------------------------------
// per-user API keys
// ---------------------------------------------------------------------------------------

/**
 * read: GET/HEAD only, with the account's own access. requests: what the account can do in the
 * request portal (never admin, even for an admin). admin: everything (admin accounts only).
 * The role is checked at every use: an admin key of a demoted account acts as `requests`.
 */
export const ApiKeyScope = z.enum(['read', 'requests', 'admin']);
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

export const UserApiKey = z.object({
  id: z.number().int(),
  name: z.string(),
  scope: ApiKeyScope,
  /** First characters (alu_xxxxxx), to tell keys apart. */
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type UserApiKey = z.infer<typeof UserApiKey>;

/** POST /user/me/apikeys. */
export const UserApiKeyCreate = z.object({
  name: z.string().trim().min(1).max(64),
  scope: ApiKeyScope.default('read'),
  /** 0 or absent: never expires. */
  expiresInDays: z.number().int().min(0).max(3650).optional(),
  /** See ReauthRequest. */
  currentPassword: z.string().min(1).max(1024).optional(),
});
export type UserApiKeyCreate = z.input<typeof UserApiKeyCreate>;

/** The new key, shown once. */
export const UserApiKeyCreated = UserApiKey.extend({ key: z.string() });
export type UserApiKeyCreated = z.infer<typeof UserApiKeyCreated>;

/** GET /apikeys (admin): every user's keys. */
export const UserApiKeyAdminRecord = UserApiKey.extend({ userId: z.number().int(), username: z.string() });
export type UserApiKeyAdminRecord = z.infer<typeof UserApiKeyAdminRecord>;
