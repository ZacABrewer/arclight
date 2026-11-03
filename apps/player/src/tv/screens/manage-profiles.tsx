import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  HOUSEHOLD_PROFILE_COLORS,
  MOVIE_CERTIFICATIONS,
  TV_CERTIFICATIONS,
  type ContentRestrictions,
  type HouseholdProfile,
  type HouseholdProfileUpdate,
} from '@arclight/shared';
import { useT } from '@web/i18n/index';
import { householdKeys, householdsApi, useActiveProfile } from '../../households/api';
import { ProfileAvatar } from '../../kit/profile-avatar';
import { NameKeyboard, PinPad, TvPanel } from '../profile-parts';
import { cycle } from './settings';

// Settings > Profiles > Manage profiles (§9 Q4), owner profile only: the profiles as on the picker
// plus "Add profile"; choosing one opens its page with Name, Colour, PIN, the Kids limit (not on
// the owner profile, §9 Q29) and Delete. Every change saves at once.

type Panel = { kind: 'name' } | { kind: 'pin'; step: 'first' | 'confirm'; first?: string; mismatch?: boolean } | { kind: 'delete' } | { kind: 'add' };

const MOVIE_LIMITS = [null, ...MOVIE_CERTIFICATIONS.filter((c) => c !== 'NR')] as const;
const TV_LIMITS = [null, ...TV_CERTIFICATIONS] as const;

export function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toLocaleUpperCase();
}

function limits(p: HouseholdProfile): ContentRestrictions {
  return p.contentRestrictions ?? { maxCertification: { movie: null, tv: null }, hideAdultContent: false };
}

function Editor({ p, onGone }: { p: HouseholdProfile; onGone: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [panel, setPanel] = useState<Panel | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: householdKeys.profiles() });
  const update = useMutation({ mutationFn: (body: HouseholdProfileUpdate) => householdsApi.update(p.id, body), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => householdsApi.remove(p.id),
    onSuccess: async () => {
      setPanel(null);
      await refresh();
      onGone();
    },
  });
  const save = (body: HouseholdProfileUpdate, after?: () => void) => update.mutate(body, { onSuccess: () => after?.() });
  const lim = limits(p);
  const limitLabel = (v: string | null) => v ?? t('app.tv.manage.noLimit');

  return (
    <TvPanel className="tv-manage__editor" label={p.name} onClose={onGone}>
      <div className="tv-manage__head">
        <ProfileAvatar color={p.color} initial={p.initial} size={64} />
        <h1 className="tv-h1">{p.name}</h1>
      </div>
      <button type="button" className="tv-opt" data-tv-key="mp-name" data-tv-autofocus="" onClick={() => setPanel({ kind: 'name' })}>
        <span className="tv-opt__text">
          <span className="tv-opt__label">{t('app.tv.profileName')}</span>
        </span>
        <span className="tv-opt__action">
          {p.name}
          <span className="tv-chev" aria-hidden="true">
            ›
          </span>
        </span>
      </button>
      <div className="tv-opt" data-tv-row="">
        <span className="tv-opt__text">
          <span className="tv-opt__label">{t('app.tv.manage.colour')}</span>
        </span>
        <span className="tv-swatches">
          {HOUSEHOLD_PROFILE_COLORS.map((c, i) => (
            <button key={c} type="button" className="tv-swatch" data-tv-key={`mp-color-${i}`} data-tv-r="17" style={{ background: c }} aria-pressed={c.toLowerCase() === p.color.toLowerCase()} aria-label={c} onClick={() => save({ color: c })} />
          ))}
        </span>
      </div>
      <button type="button" className="tv-opt" data-tv-key="mp-pin" onClick={() => setPanel({ kind: 'pin', step: 'first' })}>
        <span className="tv-opt__text">
          <span className="tv-opt__label">{t('app.tv.manage.pin')}</span>
        </span>
        <span className="tv-opt__action">
          {t(p.hasPin ? 'app.tv.manage.changePin' : 'app.tv.manage.setPin')}
          <span className="tv-chev" aria-hidden="true">
            ›
          </span>
        </span>
      </button>
      {p.hasPin ? (
        <button type="button" className="tv-opt" data-tv-key="mp-pin-off" onClick={() => save({ pin: null })}>
          <span className="tv-opt__text">
            <span className="tv-opt__label">{t('app.tv.manage.removePin')}</span>
          </span>
        </button>
      ) : null}
      {!p.isOwner ? (
        <>
          <button
            type="button"
            className="tv-opt"
            data-tv-key="mp-movie-limit"
            onClick={() => save({ contentRestrictions: { ...lim, maxCertification: { ...lim.maxCertification, movie: cycle(MOVIE_LIMITS, lim.maxCertification.movie as (typeof MOVIE_LIMITS)[number]) } } })}
          >
            <span className="tv-opt__text">
              <span className="tv-opt__label">{t('app.tv.manage.movieLimit')}</span>
            </span>
            <span className="tv-opt__choice">
              {limitLabel(lim.maxCertification.movie)}
              <span className="tv-chev" aria-hidden="true">
                ›
              </span>
            </span>
          </button>
          <button
            type="button"
            className="tv-opt"
            data-tv-key="mp-tv-limit"
            onClick={() => save({ contentRestrictions: { ...lim, maxCertification: { ...lim.maxCertification, tv: cycle(TV_LIMITS, lim.maxCertification.tv as (typeof TV_LIMITS)[number]) } } })}
          >
            <span className="tv-opt__text">
              <span className="tv-opt__label">{t('app.tv.manage.tvLimit')}</span>
            </span>
            <span className="tv-opt__choice">
              {limitLabel(lim.maxCertification.tv)}
              <span className="tv-chev" aria-hidden="true">
                ›
              </span>
            </span>
          </button>
          <button type="button" className="tv-opt" data-tv-key="mp-delete" onClick={() => setPanel({ kind: 'delete' })}>
            <span className="tv-opt__text">
              <span className="tv-opt__label tv-danger">{t('app.tv.manage.delete')}</span>
            </span>
          </button>
        </>
      ) : null}
      {update.isError ? (
        <div className="tv-pin__msg" role="status">
          {t('app.tv.saveFailed')}
        </div>
      ) : null}

      {panel?.kind === 'name' ? (
        <TvPanel label={t('app.tv.profileName')} onClose={() => setPanel(null)}>
          <NameKeyboard title={t('app.tv.profileName')} initial={p.name} busy={update.isPending} onDone={(name) => save({ name, initial: initialOf(name) }, () => setPanel(null))} />
        </TvPanel>
      ) : null}
      {panel?.kind === 'pin' ? (
        <TvPanel label={t('app.tv.manage.pin')} onClose={() => setPanel(null)}>
          <PinPad
            key={panel.step}
            title={t(panel.step === 'first' ? 'app.tv.manage.newPin' : 'app.tv.manage.confirmPin')}
            message={panel.mismatch ? t('app.tv.manage.pinMismatch') : null}
            busy={update.isPending}
            onComplete={(pin) => {
              if (panel.step === 'first') setPanel({ kind: 'pin', step: 'confirm', first: pin });
              else if (pin === panel.first) save({ pin }, () => setPanel(null));
              else setPanel({ kind: 'pin', step: 'first', mismatch: true });
            }}
          />
        </TvPanel>
      ) : null}
      {panel?.kind === 'delete' ? (
        <TvPanel label={t('app.tv.manage.delete')} onClose={() => setPanel(null)}>
          <div className="tv-confirm">
            <h2 className="tv-profiles__title">{t('app.tv.manage.deleteConfirm', { name: p.name })}</h2>
            <div className="tv-btns" data-tv-row="">
              <button type="button" className="tv-btn tv-btn--secondary" data-tv-key="mp-cancel" data-tv-autofocus="" onClick={() => setPanel(null)}>
                {t('app.tv.cancel')}
              </button>
              <button type="button" className="tv-btn tv-btn--primary" data-tv-key="mp-confirm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {t('app.tv.manage.delete')}
              </button>
            </div>
          </div>
        </TvPanel>
      ) : null}
    </TvPanel>
  );
}

export function TvManageProfilesScreen() {
  const t = useT();
  const qc = useQueryClient();
  const { profiles, canManage, max } = useActiveProfile();
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const create = useMutation({
    mutationFn: (name: string) => householdsApi.create({ name }),
    onSuccess: async (p) => {
      setAdding(false);
      await qc.invalidateQueries({ queryKey: householdKeys.profiles() });
      setEditing(p.id);
    },
  });
  const current = profiles.find((p) => p.id === editing) ?? null;

  if (!canManage) return null;
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-manage">
        {current ? (
          <Editor key={current.id} p={current} onGone={() => setEditing(null)} />
        ) : (
          <>
            <h1 className="tv-h1">{t('app.tv.settings.manageProfiles')}</h1>
            <div className="tv-profiles__row tv-manage__row" data-tv-row="">
              {profiles.map((p, i) => (
                <div key={p.id} className="tv-prof">
                  <button type="button" className="tv-prof__avatar" data-tv-key={`mp-${p.id}`} data-tv-autofocus={i === 0 ? '' : undefined} data-tv-r="66" onClick={() => setEditing(p.id)} aria-label={p.name}>
                    <ProfileAvatar color={p.color} initial={p.initial} size={132} />
                  </button>
                  <span className="tv-prof__name">{p.name}</span>
                </div>
              ))}
              {profiles.length < max ? (
                <div className="tv-prof">
                  <button type="button" className="tv-prof__add" data-tv-key="mp-add" data-tv-r="66" onClick={() => setAdding(true)} aria-label={t('app.tv.addProfile')}>
                    +
                  </button>
                  <span className="tv-prof__name">{t('app.tv.addProfile')}</span>
                </div>
              ) : null}
            </div>
          </>
        )}
        {adding ? (
          <TvPanel label={t('app.tv.addProfile')} onClose={() => setAdding(false)}>
            <NameKeyboard title={t('app.tv.profileName')} busy={create.isPending} message={create.isError ? t('app.tv.saveFailed') : null} onDone={(name) => create.mutate(name)} />
          </TvPanel>
        ) : null}
      </div>
    </div>
  );
}
