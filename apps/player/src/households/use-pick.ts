import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HouseholdProfile, HouseholdProfilesResponse } from '@arclight/shared';
import { usePlayerController } from '@web/features/player/player-context';
import { useT } from '@web/i18n/index';
import { householdKeys, selectFailure, selectProfile } from './api';

// Choosing a profile on the picker (TV and phone): straight in, or the PIN pad first for a profile
// with a PIN (§9 Q5). A wrong PIN clears the pad; 5 wrong tries lock the profile on this device
// for the server's retry-after time.

export interface PickState {
  /** The profile whose PIN is being asked for. */
  pinFor: HouseholdProfile | null;
  message: string | null;
  locked: boolean;
  busy: boolean;
  /** Changes whenever the pad should clear. */
  resetKey: number;
  pick(p: HouseholdProfile): void;
  submitPin(pin: string): void;
  cancel(): void;
}

export function lockMessageMinutes(retryAfterSeconds: number): number {
  return Math.max(1, Math.ceil(retryAfterSeconds / 60));
}

export function usePickProfile(onPicked: (p: HouseholdProfile) => void): PickState {
  const t = useT();
  const qc = useQueryClient();
  const player = usePlayerController();
  const [pinFor, setPinFor] = useState<HouseholdProfile | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const done = useRef(onPicked);
  done.current = onPicked;

  // Unlock the pad when the lock runs out.
  useEffect(() => {
    if (!lockedUntil) return;
    const id = window.setTimeout(() => {
      setLockedUntil(0);
      setMessage(null);
    }, Math.max(0, lockedUntil - Date.now()));
    return () => window.clearTimeout(id);
  }, [lockedUntil]);

  const attempt = async (p: HouseholdProfile, pin?: string) => {
    setBusy(true);
    try {
      const run = () => selectProfile(qc, p, pin);
      // The queue is per profile: a switch hands the player over (the same profile just goes on).
      const activeId = qc.getQueryData<HouseholdProfilesResponse>(householdKeys.profiles())?.activeProfileId;
      const chosen = await (player && p.id !== activeId ? player.switchProfile(run) : run());
      setPinFor(null);
      setMessage(null);
      done.current(chosen);
    } catch (err) {
      const f = selectFailure(err);
      setPinFor(p);
      setResetKey((k) => k + 1);
      if (f.kind === 'pin-required') setMessage(pin ? t('app.tv.pin.wrong') : null);
      else if (f.kind === 'pin-wrong') setMessage(t('app.tv.pin.wrong'));
      else if (f.kind === 'pin-locked') {
        setLockedUntil(Date.now() + f.retryAfterSeconds * 1000);
        setMessage(t('app.tv.pin.locked', { count: lockMessageMinutes(f.retryAfterSeconds) }));
      } else {
        // A profile without a PIN that fails: stay on the picker with nothing opened.
        if (!pin && !p.hasPin) setPinFor(null);
        setMessage(t('app.tv.pin.failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  return {
    pinFor,
    message,
    locked: lockedUntil > 0,
    busy,
    resetKey,
    pick: (p) => {
      if (busy) return;
      setMessage(null);
      if (p.hasPin) {
        setPinFor(p);
        setResetKey((k) => k + 1);
      } else void attempt(p);
    },
    submitPin: (pin) => {
      if (pinFor && !busy) void attempt(pinFor, pin);
    },
    cancel: () => {
      setPinFor(null);
      if (!lockedUntil) setMessage(null);
    },
  };
}
