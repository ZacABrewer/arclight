import { useEffect, useId, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  HOUSEHOLD_PROFILE_COLORS,
  MOVIE_CERTIFICATIONS,
  TV_CERTIFICATIONS,
  type ContentRestrictions,
  type HouseholdProfile,
  type HouseholdProfileUpdate,
} from '@arclight/shared';
import { cx } from '../../../../arclight/cx.js';
import { useT } from '../../../../i18n/index.js';
import { useCreateProfile, useDeleteProfile, useSelectProfile, useUpdateProfile } from '../api.js';
import { useLayout } from '../layout.js';
import { ProfileAvatar } from '../profile-avatar.js';
import { PinEntry, ProfilePicker, type PickerProfile } from '../profile-picker.js';
import { markProfilePicked, parseProfilesSearch } from '../profile-session.js';
import { ChoiceRow, ToggleRow } from '../settings-rows.js';
import { useProfilesView } from '../shell.js';
import { RdLoading } from './common.js';

// /player/profiles: "Who's watching?" (spec §4.2, §4.6, §9 Q1-Q5). `?select=<id>` opens the PIN
// for that profile (the avatar menu sends PIN profiles here); `?manage=1` opens Manage profiles,
// which only the owner profile may use: add, edit (name, colour, PIN, content limit) and delete.

const toPicker = (p: HouseholdProfile): PickerProfile => ({ id: p.id, name: p.name, color: p.color, initial: p.initial, hasPin: p.hasPin });

/**
 * The picker page. `gate`: shown by the layout before the page that was asked for (no close
 * button); `onPicked` then lets that page show instead of going Home.
 */
export function RdProfilesPage({ gate = false, onPicked }: { gate?: boolean; onPicked?: () => void } = {}) {
  const t = useT();
  const navigate = useNavigate();
  const layout = useLayout() === 'portrait' ? 'portrait' : 'wide';
  const search = parseProfilesSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const { profiles, canManage, activeId, loaded } = useProfilesView();
  const select = useSelectProfile();
  const [managing, setManaging] = useState(Boolean(search.manage) && !gate);
  const [editing, setEditing] = useState<HouseholdProfile | 'new' | null>(null);
  const [pinTarget, setPinTarget] = useState<number | null>(gate ? null : (search.select ?? null));

  useEffect(() => {
    document.title = `${t('player.redesign.profiles.title')} · ${t('player.documentTitle')}`;
  }, [t]);

  const done = () => {
    markProfilePicked();
    if (onPicked) onPicked();
    else void navigate({ to: '/player' });
  };
  const onSelect = async (p: PickerProfile, pin?: string) => {
    await select.mutateAsync({ id: p.id, pin });
    done();
  };

  if (!loaded) return <RdLoading />;

  const pinProfile = pinTarget !== null ? profiles.find((p) => p.id === pinTarget) : undefined;
  if (pinProfile) {
    return (
      <div className={cx('rd-picker', `rd-picker--${layout}`)}>
        <PinEntry profile={toPicker(pinProfile)} size={layout === 'portrait' ? 96 : 132} onCancel={() => setPinTarget(null)} onSubmit={(pin) => onSelect(toPicker(pinProfile), pin)} />
      </div>
    );
  }

  const manageAllowed = canManage;
  if (editing && manageAllowed) {
    return <ProfileEditor layout={layout} profile={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />;
  }

  const isManaging = managing && manageAllowed;
  return (
    <ProfilePicker
      layout={layout}
      profiles={profiles.map(toPicker)}
      activeId={activeId}
      onSelect={onSelect}
      canAdd={manageAllowed}
      onAdd={() => setEditing('new')}
      managing={isManaging}
      onEdit={(p) => setEditing(profiles.find((x) => x.id === p.id) ?? null)}
      onClose={gate ? undefined : () => void navigate({ to: '/player' })}
      footer={
        manageAllowed ? (
          <button type="button" className={cx('rd-btn', isManaging ? 'rd-btn--primary' : 'rd-btn--secondary', 'rd-picker__manage')} onClick={() => setManaging(!isManaging)}>
            {isManaging ? t('player.redesign.profiles.done') : t('player.redesign.profiles.manage')}
          </button>
        ) : null
      }
    />
  );
}

const ANY = 'any';

/** Add or edit one profile (owner only). */
function ProfileEditor({ profile, layout, onDone }: { profile: HouseholdProfile | null; layout: 'wide' | 'portrait'; onDone: () => void }) {
  const t = useT();
  const nameId = useId();
  const pinId = useId();
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const remove = useDeleteProfile();
  const [name, setName] = useState(profile?.name ?? '');
  const [color, setColor] = useState<string>(profile?.color ?? HOUSEHOLD_PROFILE_COLORS[0]);
  const [pinOn, setPinOn] = useState(profile?.hasPin ?? false);
  const [pin, setPin] = useState('');
  const [limits, setLimits] = useState<ContentRestrictions | null>(profile?.contentRestrictions ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isOwner = profile?.isOwner ?? false;
  const busy = create.isPending || update.isPending || remove.isPending;

  const trimmed = name.trim();
  const pinNeeded = pinOn && (!profile?.hasPin || pin.length > 0);
  const pinValid = !pinNeeded || /^\d{4}$/.test(pin);
  const canSave = trimmed.length > 0 && trimmed.length <= 24 && pinValid && !busy;

  const save = async () => {
    if (!canSave) return;
    const body: HouseholdProfileUpdate = { name: trimmed, color, initial: trimmed[0]!.toUpperCase() };
    if (pinOn && pin) body.pin = pin;
    if (!pinOn && profile?.hasPin) body.pin = null;
    if (!isOwner) body.contentRestrictions = limits;
    if (profile) await update.mutateAsync({ id: profile.id, body });
    else await create.mutateAsync({ ...body, name: trimmed, pin: pinOn && pin ? pin : null });
    onDone();
  };

  const movieCap = limits?.maxCertification.movie ?? ANY;
  const tvCap = limits?.maxCertification.tv ?? ANY;
  const setCap = (kind: 'movie' | 'tv', v: string) => {
    const base: ContentRestrictions = limits ?? { maxCertification: { movie: null, tv: null }, hideAdultContent: false };
    const next = { ...base, maxCertification: { ...base.maxCertification, [kind]: v === ANY ? null : v } } as ContentRestrictions;
    setLimits(!next.maxCertification.movie && !next.maxCertification.tv && !next.hideAdultContent ? null : next);
  };
  const mode = layout === 'portrait' ? 'sheet' : 'cycle';
  const any = t('player.redesign.profiles.anyRating');

  return (
    <div className={cx('rd-picker', 'rd-picker--edit', `rd-picker--${layout}`)}>
      <h1 className="rd-picker__title">{profile ? t('player.redesign.profiles.editTitle') : t('player.redesign.profiles.add')}</h1>
      <form
        className="rd-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ProfileAvatar color={color} initial={(trimmed[0] ?? '?').toUpperCase()} size={layout === 'portrait' ? 96 : 120} className="rd-editor__avatar" />
        <label className="rd-editor__field" htmlFor={nameId}>
          <span className="rd-editor__label">{t('player.redesign.profiles.name')}</span>
          <input id={nameId} className="rd-editor__input" value={name} maxLength={24} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset className="rd-editor__field">
          <legend className="rd-editor__label">{t('player.redesign.profiles.color')}</legend>
          <div className="rd-swatches">
            {HOUSEHOLD_PROFILE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={cx('rd-swatch', c === color && 'is-on')}
                style={{ background: c }}
                aria-pressed={c === color}
                aria-label={t('player.redesign.profiles.colorN', { n: HOUSEHOLD_PROFILE_COLORS.indexOf(c) + 1 })}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </fieldset>
        <div className="rd-settings__opts rd-editor__opts">
          <ToggleRow label={t('player.redesign.profiles.pin')} desc={t('player.redesign.profiles.pinDesc')} checked={pinOn} onChange={setPinOn} />
          {pinOn ? (
            <label className="rd-editor__field" htmlFor={pinId}>
              <span className="rd-editor__label">{profile?.hasPin ? t('player.redesign.profiles.newPin') : t('player.redesign.profiles.pin')}</span>
              <input
                id={pinId}
                className="rd-editor__input rd-editor__input--pin"
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="new-password"
                maxLength={4}
                value={pin}
                aria-invalid={!pinValid && pin.length > 0 ? true : undefined}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              />
            </label>
          ) : null}
          {!isOwner ? (
            <>
              <ChoiceRow
                label={t('player.redesign.profiles.movieLimit')}
                value={movieCap}
                options={[{ value: ANY, label: any }, ...MOVIE_CERTIFICATIONS.map((c) => ({ value: c, label: c }))]}
                mode={mode}
                onChange={(v) => setCap('movie', v)}
              />
              <ChoiceRow
                label={t('player.redesign.profiles.tvLimit')}
                value={tvCap}
                options={[{ value: ANY, label: any }, ...TV_CERTIFICATIONS.map((c) => ({ value: c, label: c }))]}
                mode={mode}
                onChange={(v) => setCap('tv', v)}
              />
            </>
          ) : null}
        </div>
        <div className="rd-editor__buttons">
          <button type="submit" className="rd-btn rd-btn--primary" disabled={!canSave}>
            {t('player.redesign.profiles.save')}
          </button>
          <button type="button" className="rd-btn rd-btn--secondary" onClick={onDone}>
            {t('player.redesign.cancel')}
          </button>
        </div>
        {profile && !isOwner ? (
          confirmDelete ? (
            <div className="rd-editor__confirm" role="alertdialog" aria-label={t('player.redesign.profiles.deleteConfirm', { name: profile.name })}>
              <p>{t('player.redesign.profiles.deleteConfirm', { name: profile.name })}</p>
              <div className="rd-editor__buttons">
                <button
                  type="button"
                  className="rd-btn rd-btn--danger"
                  disabled={busy}
                  onClick={() => void remove.mutateAsync(profile.id).then(onDone)}
                >
                  {t('player.redesign.profiles.delete')}
                </button>
                <button type="button" className="rd-btn rd-btn--secondary" onClick={() => setConfirmDelete(false)}>
                  {t('player.redesign.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="rd-linkbtn rd-editor__delete" onClick={() => setConfirmDelete(true)}>
              {t('player.redesign.profiles.delete')}
            </button>
          )
        ) : null}
      </form>
    </div>
  );
}
