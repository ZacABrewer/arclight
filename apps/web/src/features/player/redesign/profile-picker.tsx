import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../../arclight/cx.js';
import { Lockup } from '../../../arclight/lockup.js';
import { ApiError } from '../../../api/client.js';
import { useT } from '../../../i18n/index.js';
import { ProfileAvatar } from './profile-avatar.js';
import { RdIcon } from './icons.js';

// "Who's watching?" (redesign spec §4.2, §4.4, the template's Profiles screen): touch and mouse.
// The owner profile also gets an Add tile and the pencil Manage button, which turns the tiles
// into edit mode (features spec §1).
// A profile with a PIN asks for it in a 4-dot field typed on the system number pad (§9 Q5: four
// digits; five wrong tries lock it for 15 minutes, enforced by the server).

export interface PickerProfile {
  id: number;
  name: string;
  color: string;
  initial: string;
  hasPin: boolean;
}

export interface ProfilePickerProps {
  profiles: readonly PickerProfile[];
  activeId?: number | null | undefined;
  /** Switch; rejects with the api error (pin-required, pin-wrong, pin-locked). */
  onSelect: (profile: PickerProfile, pin?: string) => Promise<void>;
  /** The owner profile is active: show the Add profile tile (while below `max`). */
  canAdd?: boolean | undefined;
  /** The account's profile limit (the server's); no limit when absent. */
  max?: number | undefined;
  onAdd?: (() => void) | undefined;
  /** Edit mode: tapping a profile edits it instead of switching. */
  managing?: boolean | undefined;
  onEdit?: ((profile: PickerProfile) => void) | undefined;
  /** The pencil "Manage profiles" / "Done" button toggles edit mode (owner only: pass it with canManage). */
  onManage?: (() => void) | undefined;
  /** Move focus to this profile's tile (the one just added or edited). */
  focusId?: number | null | undefined;
  layout: 'wide' | 'portrait';
  /** An extra slot under the Manage button. */
  footer?: ReactNode;
  /** Back to the page this came from (the picker opened from the avatar). */
  onClose?: (() => void) | undefined;
}

export const PIN_LENGTH = 4;

/** Phone landscape: the wide picker scaled to the height (96 px tiles below 430 px). */
const SHORT_QUERY = '(max-height: 429.98px)';

function useShortScreen(): boolean {
  const [short, setShort] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SHORT_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(SHORT_QUERY);
    const on = () => setShort(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return short;
}

export function ProfilePicker({ profiles, activeId, onSelect, canAdd, max, onAdd, managing, onEdit, onManage, focusId, layout, footer, onClose }: ProfilePickerProps) {
  const t = useT();
  const [pinFor, setPinFor] = useState<PickerProfile | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grid = useRef<HTMLUListElement>(null);
  const short = useShortScreen();
  const size = layout === 'portrait' || short ? 96 : 132;
  const showAdd = Boolean(canAdd && onAdd) && (max === undefined || profiles.length < max);

  // Back (Escape) in edit mode returns to pick mode first.
  const manageRef = useRef(onManage);
  manageRef.current = onManage;
  useEffect(() => {
    if (!managing || pinFor) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      manageRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [managing, pinFor]);

  useEffect(() => {
    if (focusId == null) return;
    grid.current?.querySelector<HTMLElement>(`[data-profile-id="${focusId}"]`)?.focus();
  }, [focusId, profiles]);

  const pick = async (p: PickerProfile) => {
    if (managing) {
      onEdit?.(p);
      return;
    }
    setError(null);
    if (p.hasPin && p.id !== activeId) {
      setPinFor(p);
      return;
    }
    setBusy(p.id);
    try {
      await onSelect(p);
    } catch (err) {
      if (err instanceof ApiError && err.message === 'pin-required') setPinFor(p);
      else setError(t('player.redesign.profiles.couldNotSwitch'));
    } finally {
      setBusy(null);
    }
  };

  if (pinFor) {
    return (
      <div className={cx('rd-picker', `rd-picker--${layout}`)}>
        <PinEntry profile={pinFor} size={size} onCancel={() => setPinFor(null)} onSubmit={(pin) => onSelect(pinFor, pin)} />
      </div>
    );
  }

  return (
    <div className={cx('rd-picker', `rd-picker--${layout}`, managing && 'is-managing')}>
      {layout === 'wide' ? <Lockup height={22} label="Arclight" className="rd-picker__brand" /> : null}
      {onClose ? (
        <button type="button" className="rd-iconbtn rd-picker__close" aria-label={t('player.redesign.close')} onClick={onClose}>
          <RdIcon name="close" />
        </button>
      ) : null}
      <h1 className="rd-picker__title">{managing ? t('player.redesign.profiles.manageTitle') : t('player.redesign.profiles.title')}</h1>
      <ul className="rd-picker__grid" ref={grid}>
        {profiles.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className={cx('rd-picker__profile', managing && 'is-managing')}
              data-profile-id={p.id}
              aria-busy={busy === p.id || undefined}
              aria-label={managing ? t('player.redesign.profiles.editNamed', { name: p.name }) : undefined}
              onClick={() => void pick(p)}
            >
              <span className="rd-picker__avatar">
                <ProfileAvatar color={p.color} initial={p.initial} size={size} />
                {managing ? (
                  <span className="rd-picker__edit-scrim" aria-hidden="true">
                    <RdIcon name="pencil" size={Math.round(size * 0.27)} />
                  </span>
                ) : p.hasPin ? (
                  <span className="rd-picker__badge" aria-hidden="true">
                    <RdIcon name="lock" size={16} />
                  </span>
                ) : null}
              </span>
              <span className="rd-picker__name">{p.name}</span>
            </button>
          </li>
        ))}
        {showAdd ? (
          <li>
            <button type="button" className="rd-picker__profile rd-picker__profile--add" onClick={onAdd}>
              <span className="rd-picker__add" style={{ width: size, height: size }}>
                <RdIcon name="plus" size={Math.round(size * 0.3)} />
              </span>
              <span className="rd-picker__name">{t('player.redesign.profiles.add')}</span>
            </button>
          </li>
        ) : null}
      </ul>
      {error ? (
        <p className="rd-picker__error" role="alert">
          {error}
        </p>
      ) : null}
      {onManage ? (
        <button type="button" className={cx('rd-picker__manage', managing && 'is-on')} onClick={onManage}>
          <span className="rd-picker__manage-icon" aria-hidden="true">
            <RdIcon name={managing ? 'check' : 'pencil'} size={20} />
          </span>
          <span className="rd-picker__manage-label">{managing ? t('player.redesign.profiles.done') : t('player.redesign.profiles.manage')}</span>
        </button>
      ) : null}
      {footer}
    </div>
  );
}

/** The 4-dot PIN field over a hidden numeric input (the system number pad on phones). */
export function PinEntry({ profile, size, onCancel, onSubmit }: { profile: PickerProfile; size: number; onCancel: () => void; onSubmit: (pin: string) => Promise<void> }) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Focus on open, and again once a refused try re-enables the field (a disabled input cannot take
  // focus, so focusing in the catch would close the number pad after a wrong PIN).
  useEffect(() => {
    if (!busy) input.current?.focus();
  }, [busy]);

  const submit = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (err) {
      setPin('');
      const code = err instanceof ApiError ? err.message : '';
      if (code === 'pin-locked' || (err instanceof ApiError && err.status === 429)) setError(t('player.redesign.pin.locked'));
      else if (code === 'pin-wrong') setError(t('player.redesign.pin.wrong'));
      else setError(t('player.redesign.profiles.couldNotSwitch'));
    } finally {
      setBusy(false);
    }
  };

  const onChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPin(digits);
    if (error) setError(null);
    if (digits.length === PIN_LENGTH && !busy) void submit(digits);
  };

  return (
    <div className="rd-pin">
      <ProfileAvatar color={profile.color} initial={profile.initial} size={Math.round(size * 0.72)} />
      <h1 className="rd-picker__title" id={`${id}-t`}>
        {t('player.redesign.pin.title', { name: profile.name })}
      </h1>
      <label className="rd-pin__field" htmlFor={id}>
        <input
          ref={input}
          id={id}
          className="rd-pin__input"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={PIN_LENGTH}
          value={pin}
          disabled={busy}
          aria-labelledby={`${id}-t`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-e` : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <span className={cx('rd-pin__dots', error && 'is-error')} aria-hidden="true">
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span key={i} className={cx('rd-pin__dot', i < pin.length && 'is-on')} />
          ))}
        </span>
      </label>
      {error ? (
        <p className="rd-picker__error" id={`${id}-e`} role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="rd-btn rd-btn--secondary" onClick={onCancel}>
        {t('player.redesign.cancel')}
      </button>
    </div>
  );
}
