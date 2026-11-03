import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ContentRestrictions,
  HOUSEHOLD_PROFILE_COLORS,
  HouseholdProfile,
  HouseholdProfilesResponse,
  MOVIE_CERTIFICATIONS,
  TV_CERTIFICATIONS,
  type HouseholdProfileCreate,
  type HouseholdProfileUpdate,
  type MovieCertification,
  type TvCertification,
} from '@arclight/shared';
import { ApiError, errorMessage, request } from '../../../api/client.js';
import { Banner, Button, Chip, Field, Input, SectionLabel, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { capsSummary } from '../../../features/requests/user-editors.js';
import { t } from '../../../i18n/index.js';
import './user-profiles.css';

// Settings → Users → Manage → Profiles: the household profiles of one account (spec §1.1). The
// admin routes (/users/:userId/profiles*) work whichever profile the account has active. The owner
// profile cannot be deleted and has no limit of its own (the account's caps apply to it).

export const userProfilesApi = {
  list: (userId: number) => request(`/users/${userId}/profiles`, HouseholdProfilesResponse),
  create: (userId: number, body: HouseholdProfileCreate) => request(`/users/${userId}/profiles`, HouseholdProfile, { method: 'POST', json: body }),
  update: (userId: number, id: number, body: HouseholdProfileUpdate) =>
    request(`/users/${userId}/profiles/${id}`, HouseholdProfile, { method: 'PATCH', json: body }),
  remove: (userId: number, id: number) => request(`/users/${userId}/profiles/${id}`, null, { method: 'DELETE' }),
};

export const profileKeys = { list: (userId: number) => ['users', userId, 'profiles'] as const };

/** True when a limit actually caps something (an all-empty limit is stored as null). */
export function hasLimit(r: ContentRestrictions | null): r is ContentRestrictions {
  return r !== null && (r.maxCertification.movie !== null || r.maxCertification.tv !== null || r.hideAdultContent);
}

/** The translated message for a households error code, else the server's text. */
export function profileErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.code ?? err.message;
    const known: Record<string, string> = {
      'limit-reached': t('settings.users.profiles.errorLimit'),
      'owner-immutable': t('settings.users.profiles.errorOwner'),
      'not-found': t('settings.users.profiles.errorNotFound'),
    };
    if (known[code]) return known[code];
  }
  return errorMessage(err);
}

const PIN_RE = /^\d{4}$/;

interface Draft {
  name: string;
  initial: string;
  color: string;
  caps: ContentRestrictions;
  /** '' leaves the PIN as it is (or none on a new profile). */
  pin: string;
  removePin: boolean;
}

function draftOf(p: HouseholdProfile | null): Draft {
  return {
    name: p?.name ?? '',
    initial: p?.initial ?? '',
    color: p?.color ?? HOUSEHOLD_PROFILE_COLORS[0],
    caps: ContentRestrictions.parse(p?.contentRestrictions ?? {}),
    pin: '',
    removePin: false,
  };
}

export function ProfileAvatar({ profile, size = 36 }: { profile: Pick<HouseholdProfile, 'color' | 'initial' | 'name'>; size?: number }) {
  return (
    <span className="al-profile-avatar" style={{ background: profile.color, width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {profile.initial || profile.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function ProfileForm({ userId, profile, onDone }: { userId: number; profile: HouseholdProfile | null; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile));
  const [error, setError] = useState<string | null>(null);
  const isOwner = profile?.isOwner ?? false;
  const name = draft.name.trim();
  const pinInvalid = draft.pin !== '' && !PIN_RE.test(draft.pin);
  const nameInvalid = name.length === 0 || name.length > 24;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setCaps = (patch: Partial<ContentRestrictions>) => setDraft((d) => ({ ...d, caps: { ...d.caps, ...patch } }));

  const save = useMutation({
    mutationFn: async () => {
      const initial = draft.initial.trim();
      const body: HouseholdProfileUpdate = {
        name,
        color: draft.color,
        ...(initial ? { initial } : {}),
        ...(isOwner ? {} : { contentRestrictions: hasLimit(draft.caps) ? draft.caps : null }),
        ...(draft.pin ? { pin: draft.pin } : draft.removePin ? { pin: null } : {}),
      };
      return profile ? userProfilesApi.update(userId, profile.id, body) : userProfilesApi.create(userId, { ...body, name });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: profileKeys.list(userId) });
      toast.push({ tone: 'ok', title: profile ? t('settings.users.profiles.saved') : t('settings.users.profiles.added') });
      onDone();
    },
    onError: (err) => setError(profileErrorMessage(err)),
  });

  const none = { value: '', label: t('features.requests.userEditors.noCap') };
  const title = profile ? t('settings.users.profiles.editTitle', { name: profile.name }) : t('settings.users.profiles.addTitle');

  return (
    <form
      className="al-profile-form"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        if (nameInvalid || pinInvalid) return;
        setError(null);
        save.mutate();
      }}
    >
      <SectionLabel>{title}</SectionLabel>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <div className="al-profile-form__head">
        <ProfileAvatar profile={{ color: draft.color, initial: draft.initial.trim(), name: name || '?' }} size={56} />
        <div className="al-profile-form__names">
          <Field label={t('settings.users.profiles.name')} error={nameInvalid && draft.name !== '' ? t('settings.users.profiles.nameHint') : undefined}>
            <Input value={draft.name} maxLength={24} required autoComplete="off" onChange={(e) => set({ name: e.currentTarget.value })} />
          </Field>
          <Field label={t('settings.users.profiles.initial')} hint={t('settings.users.profiles.initialHint')}>
            <Input className="al-profile-form__initial" value={draft.initial} maxLength={2} autoComplete="off" onChange={(e) => set({ initial: e.currentTarget.value })} />
          </Field>
        </div>
      </div>

      <div className="al-profile-colors" role="radiogroup" aria-label={t('settings.users.profiles.color')}>
        {HOUSEHOLD_PROFILE_COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={draft.color.toLowerCase() === c}
            aria-label={t('settings.users.profiles.colorN', { n: i + 1 })}
            className="al-profile-colors__swatch"
            style={{ background: c }}
            onClick={() => set({ color: c })}
          />
        ))}
      </div>

      {isOwner ? (
        <p className="al-caption">{t('settings.users.profiles.ownerLimitNote')}</p>
      ) : (
        <>
          <SectionLabel>{t('settings.users.profiles.limits')}</SectionLabel>
          <p className="al-caption">{t('settings.users.profiles.limitsHint')}</p>
          <div className="al-profile-form__grid">
            <Field label={t('features.requests.userEditors.maxMovieRating')}>
              <Select
                value={draft.caps.maxCertification.movie ?? ''}
                onChange={(e) => setCaps({ maxCertification: { ...draft.caps.maxCertification, movie: (e.currentTarget.value || null) as MovieCertification | null } })}
                options={[none, ...MOVIE_CERTIFICATIONS.map((c) => ({ value: c, label: c }))]}
              />
            </Field>
            <Field label={t('features.requests.userEditors.maxSeriesRating')}>
              <Select
                value={draft.caps.maxCertification.tv ?? ''}
                onChange={(e) => setCaps({ maxCertification: { ...draft.caps.maxCertification, tv: (e.currentTarget.value || null) as TvCertification | null } })}
                options={[none, ...TV_CERTIFICATIONS.map((c) => ({ value: c, label: c }))]}
              />
            </Field>
          </div>
          <Field label={t('features.requests.userEditors.hideAdult')} inline>
            <Toggle checked={draft.caps.hideAdultContent} onChange={(e) => setCaps({ hideAdultContent: e.currentTarget.checked })} />
          </Field>
        </>
      )}

      <SectionLabel>{t('settings.users.profiles.pin')}</SectionLabel>
      <Field
        label={profile?.hasPin ? t('settings.users.profiles.newPin') : t('settings.users.profiles.setPin')}
        hint={t('settings.users.profiles.pinHint')}
        error={pinInvalid ? t('settings.users.profiles.pinInvalid') : undefined}
      >
        <Input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          autoComplete="new-password"
          value={draft.pin}
          disabled={draft.removePin}
          onChange={(e) => set({ pin: e.currentTarget.value.replace(/\D/g, '') })}
        />
      </Field>
      {profile?.hasPin ? (
        <Field label={t('settings.users.profiles.removePin')} inline>
          <Toggle checked={draft.removePin} onChange={(e) => set({ removePin: e.currentTarget.checked, pin: '' })} />
        </Field>
      ) : null}

      <div className="al-profile-form__actions">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={nameInvalid || pinInvalid}>
          {profile ? t('common.save') : t('settings.users.profiles.add')}
        </Button>
      </div>
    </form>
  );
}

type Mode = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; profile: HouseholdProfile };

/** The Profiles tab of the manage-user dialog. */
export function UserProfilesEditor({ userId }: { userId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: profileKeys.list(userId), queryFn: () => userProfilesApi.list(userId) });
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [confirming, setConfirming] = useState<HouseholdProfile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (p: HouseholdProfile) => userProfilesApi.remove(userId, p.id),
    onSuccess: async (_v, p) => {
      setConfirming(null);
      await qc.invalidateQueries({ queryKey: profileKeys.list(userId) });
      toast.push({ tone: 'ok', title: t('settings.users.profiles.deleted', { name: p.name }) });
    },
    onError: (err) => setDeleteError(profileErrorMessage(err)),
  });

  if (list.isPending) return <Skeleton lines={3} />;
  if (list.isError) {
    return (
      <Banner tone="danger">
        {t('settings.users.profiles.couldNotLoad')} {errorMessage(list.error)}
      </Banner>
    );
  }
  if (mode.kind !== 'list') {
    return <ProfileForm userId={userId} profile={mode.kind === 'edit' ? mode.profile : null} onDone={() => setMode({ kind: 'list' })} />;
  }

  const { profiles, max } = list.data;
  const full = profiles.length >= max;
  return (
    <div className="al-profiles" data-testid="user-profiles">
      <p className="al-caption">{t('settings.users.profiles.intro')}</p>
      <ul className="al-profiles__list" aria-label={t('settings.users.profiles.title')}>
        {profiles.map((p) => (
          <li key={p.id} className="al-profiles__row">
            <ProfileAvatar profile={p} />
            <div className="al-profiles__main">
              <span className="al-profiles__name">{p.name}</span>
              <span className="al-profiles__badges">
                {p.isOwner ? <Chip tone="accent">{t('settings.users.profiles.owner')}</Chip> : null}
                {hasLimit(p.contentRestrictions) ? (
                  <Chip tone="warn" title={capsSummary(p.contentRestrictions)}>
                    {t('settings.users.profiles.kids')}
                  </Chip>
                ) : null}
                {p.hasPin ? <Chip tone="neutral">{t('settings.users.profiles.pinBadge')}</Chip> : null}
              </span>
            </div>
            {confirming?.id === p.id ? (
              <div className="al-profiles__confirm" role="group" aria-label={t('settings.users.profiles.deleteConfirm', { name: p.name })}>
                <span className="al-profiles__confirm-text">{t('settings.users.profiles.deleteConfirm', { name: p.name })}</span>
                {deleteError ? <span className="al-profiles__confirm-error">{deleteError}</span> : null}
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate(p)}>
                  {t('common.delete')}
                </Button>
              </div>
            ) : (
              <div className="al-profiles__actions">
                <Button size="sm" variant="secondary" onClick={() => setMode({ kind: 'edit', profile: p })} aria-label={t('settings.users.profiles.editTitle', { name: p.name })}>
                  {t('common.edit')}
                </Button>
                {p.isOwner ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDeleteError(null);
                      setConfirming(p);
                    }}
                    aria-label={t('settings.users.profiles.deleteName', { name: p.name })}
                  >
                    {t('common.delete')}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="al-profiles__footer">
        <Button variant="primary" disabled={full} onClick={() => setMode({ kind: 'new' })}>
          {t('settings.users.profiles.add')}
        </Button>
        <span className="al-caption">{full ? t('settings.users.profiles.full', { max }) : t('settings.users.profiles.count', { count: profiles.length, max })}</span>
      </div>
    </div>
  );
}
