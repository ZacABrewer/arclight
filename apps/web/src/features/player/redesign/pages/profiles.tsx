import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
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
import { usePlayerController } from '../../player-context.js';
import { useAddProfileView } from '../add-profile.js';
import { useCreateProfile, useDeleteProfile, useSelectProfile, useUpdateProfile } from '../api.js';
import { useLayout } from '../layout.js';
import { ProfileAvatar } from '../profile-avatar.js';
import { PinEntry, ProfilePicker, type PickerProfile } from '../profile-picker.js';
import { redesignPaths } from '../paths.js';
import { canAddProfile, firstFreeColor, markProfilePicked, parseProfilesSearch } from '../profile-session.js';
import { ChoiceRow, ToggleRow } from '../settings-rows.js';
import { useProfilesView } from '../shell.js';
import { RdLoading } from './common.js';

// /player/profiles: "Who's watching?" (spec §4.2, §4.6, §9 Q1-Q5; features spec §1). `?select=<id>`
// opens the PIN for that profile (the avatar menu sends PIN profiles here); `?manage=1` opens edit
// mode, which only the owner profile may use: tapping a tile edits it (name, colour, PIN, content
// limit, delete) and the Add tile creates one; `&add=1` opens the new-profile editor straight away
// (the account menu's "Add profile"). Edit mode is a history entry of its own, so Back (the
// browser's, the phone's) or Escape returns to pick mode before it leaves the picker.

const toPicker = (p: HouseholdProfile): PickerProfile => ({ id: p.id, name: p.name, color: p.color, initial: p.initial, hasPin: p.hasPin });

/**
 * The picker page. `gate`: shown by the layout before the page that was asked for (no close
 * button); `onPicked` then lets that page show instead of going Home.
 */
export function RdProfilesPage({ gate = false, onPicked }: { gate?: boolean; onPicked?: () => void } = {}) {
  const t = useT();
  const navigate = useNavigate();
  const router = useRouter();
  const layout = useLayout() === 'portrait' ? 'portrait' : 'wide';
  const search = parseProfilesSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const { profiles, canManage, activeId, loaded } = useProfilesView();
  const { max } = useAddProfileView();
  const select = useSelectProfile();
  const player = usePlayerController();
  // The gate sits in front of another page's address: edit mode is local there.
  const [gateManaging, setGateManaging] = useState(false);
  const [editing, setEditing] = useState<HouseholdProfile | 'new' | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [pinTarget, setPinTarget] = useState<number | null>(gate ? null : (search.select ?? null));
  // This page pushed the edit-mode entry: Done goes back to pick mode instead of adding another.
  const pushed = useRef(false);

  useEffect(() => {
    document.title = `${t('player.redesign.profiles.title')} · ${t('player.documentTitle')}`;
  }, [t]);

  const manageAllowed = canManage;
  const canAdd = canAddProfile({ canManage, count: profiles.length, max });
  const isManaging = manageAllowed && (gate ? gateManaging : Boolean(search.manage));

  const toProfiles = (next: { manage?: 1 }, replace: boolean) => navigate({ to: redesignPaths.profiles as '/player', search: next as never, replace });
  const setManaging = (on: boolean) => {
    if (gate) setGateManaging(on);
    else if (on) {
      pushed.current = true;
      void toProfiles({ manage: 1 }, false);
    } else if (pushed.current) {
      pushed.current = false;
      router.history.back();
    } else void toProfiles({}, true);
  };

  // Arriving in edit mode (the avatar menu, Settings): pick mode goes underneath, so Back returns
  // to it first. `add=1` opens the new-profile editor and leaves the address.
  const arrived = useRef(false);
  useEffect(() => {
    if (gate || !loaded || arrived.current) return;
    arrived.current = true;
    if (!search.manage || !manageAllowed) return;
    if (search.add && canAdd) setEditing('new');
    pushed.current = true;
    void toProfiles({}, true).then(() => toProfiles({ manage: 1 }, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, loaded, search.manage, search.add, manageAllowed, canAdd]);

  // Back out of edit mode also closes the editor opened from it.
  const wasManaging = useRef(isManaging);
  useEffect(() => {
    if (wasManaging.current && !isManaging && editing && editing !== 'new') setEditing(null);
    wasManaging.current = isManaging;
  }, [isManaging, editing]);

  const done = () => {
    markProfilePicked();
    if (onPicked) onPicked();
    else void navigate({ to: '/player' });
  };
  const onSelect = async (p: PickerProfile, pin?: string) => {
    const run = () => select.mutateAsync({ id: p.id, pin });
    // The queue is per profile: a switch hands the player over (the same profile just goes on).
    await (player && p.id !== activeId ? player.switchProfile(run) : run());
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

  if (editing && manageAllowed && (editing !== 'new' || canAdd)) {
    const current = editing;
    return (
      <ProfileEditor
        key={current === 'new' ? 'new' : current.id}
        mode={current === 'new' ? 'create' : 'edit'}
        layout={layout}
        profile={current === 'new' ? null : current}
        profiles={profiles}
        onDone={(saved) => {
          setEditing(null);
          // The new (or edited) profile's tile takes focus; a new one is not switched to.
          setFocusId(saved?.id ?? (current === 'new' ? null : current.id));
        }}
      />
    );
  }

  return (
    <ProfilePicker
      layout={layout}
      profiles={profiles.map(toPicker)}
      activeId={activeId}
      onSelect={onSelect}
      canAdd={manageAllowed}
      max={max}
      onAdd={() => setEditing('new')}
      managing={isManaging}
      onEdit={(p) => setEditing(profiles.find((x) => x.id === p.id) ?? null)}
      onManage={manageAllowed ? () => setManaging(!isManaging) : undefined}
      focusId={focusId}
      onClose={gate ? undefined : () => void navigate({ to: '/player' })}
    />
  );
}

const ANY = 'any';

export interface ProfileEditorProps {
  /** create: a new profile (the Add tile); edit: `profile`. */
  mode: 'create' | 'edit';
  profile: HouseholdProfile | null;
  /** The account's profiles (a new one starts with a colour none of them has). */
  profiles: readonly HouseholdProfile[];
  layout: 'wide' | 'portrait';
  /** Closed: `saved` is the created or updated profile (nothing after Cancel or Delete). */
  onDone: (saved?: HouseholdProfile) => void;
}

/** Add or edit one profile (owner only): name, colour, PIN and, on other profiles, the content limits. */
export function ProfileEditor({ mode, profile: given, profiles, layout, onDone }: ProfileEditorProps) {
  const profile = mode === 'edit' ? given : null;
  const t = useT();
  const nameId = useId();
  const pinId = useId();
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const remove = useDeleteProfile();
  const [name, setName] = useState(profile?.name ?? '');
  const [color, setColor] = useState<string>(() => profile?.color ?? firstFreeColor(profiles));
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
    const saved = profile ? await update.mutateAsync({ id: profile.id, body }) : await create.mutateAsync({ ...body, name: trimmed, pin: pinOn && pin ? pin : null });
    onDone(saved);
  };

  const movieCap = limits?.maxCertification.movie ?? ANY;
  const tvCap = limits?.maxCertification.tv ?? ANY;
  const setCap = (kind: 'movie' | 'tv', v: string) => {
    const base: ContentRestrictions = limits ?? { maxCertification: { movie: null, tv: null }, hideAdultContent: false };
    const next = { ...base, maxCertification: { ...base.maxCertification, [kind]: v === ANY ? null : v } } as ContentRestrictions;
    setLimits(!next.maxCertification.movie && !next.maxCertification.tv && !next.hideAdultContent ? null : next);
  };
  const choiceMode = layout === 'portrait' ? 'sheet' : 'cycle';
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
                mode={choiceMode}
                onChange={(v) => setCap('movie', v)}
              />
              <ChoiceRow
                label={t('player.redesign.profiles.tvLimit')}
                value={tvCap}
                options={[{ value: ANY, label: any }, ...TV_CERTIFICATIONS.map((c) => ({ value: c, label: c }))]}
                mode={choiceMode}
                onChange={(v) => setCap('tv', v)}
              />
            </>
          ) : null}
        </div>
        <div className="rd-editor__buttons">
          <button type="submit" className="rd-btn rd-btn--primary" disabled={!canSave}>
            {t('player.redesign.profiles.save')}
          </button>
          <button type="button" className="rd-btn rd-btn--secondary" onClick={() => onDone()}>
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
                  onClick={() => void remove.mutateAsync(profile.id).then(() => onDone())}
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
