import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  HOUSEHOLD_PROFILE_COLORS,
  MOVIE_CERTIFICATIONS,
  TV_CERTIFICATIONS,
  type ContentRestrictions,
  type HouseholdProfile,
  type HouseholdProfileCreate,
  type HouseholdProfileUpdate,
} from '@arclight/shared';
import { useT } from '@web/i18n/index';
import { householdKeys, householdsApi, useActiveProfile } from '../../households/api';
import { ProfileAvatar } from '@web/features/player/redesign/profile-avatar';
import { firstFreeColor } from '@web/features/player/redesign/profile-session';
import { NameKeyboard, PinPad, TvPanel } from '../profile-parts';
import { tvRuntime } from '../tv-runtime';
import { cycle } from './settings';

// Settings > Profiles > Manage profiles (§9 Q4), owner profile only: the profiles as on the picker
// plus "Add profile"; choosing one opens its page with Name, Colour, PIN, the Kids limit (not on
// the owner profile, §9 Q29) and Delete. Every change saves at once. "Add profile" opens the same
// page for a profile that does not exist yet (features spec §1, D3): the choices are kept until
// Save creates it with all of them.

type Panel = { kind: 'name' } | { kind: 'pin'; step: 'first' | 'confirm'; first?: string; mismatch?: boolean } | { kind: 'delete' };

const MOVIE_LIMITS = [null, ...MOVIE_CERTIFICATIONS.filter((c) => c !== 'NR')] as const;
const TV_LIMITS = [null, ...TV_CERTIFICATIONS] as const;

export function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toLocaleUpperCase();
}

function limits(p: Pick<HouseholdProfile, 'contentRestrictions'>): ContentRestrictions {
  return p.contentRestrictions ?? { maxCertification: { movie: null, tv: null }, hideAdultContent: false };
}

/** A new profile's choices before Save. */
export interface ProfileDraft {
  name: string;
  color: string;
  pin: string | null;
  contentRestrictions: ContentRestrictions | null;
}

/** What Save sends for a new profile. */
export function createBody(d: ProfileDraft): HouseholdProfileCreate {
  const name = d.name.trim();
  return { name, initial: initialOf(name), color: d.color, pin: d.pin, contentRestrictions: d.contentRestrictions };
}

/** A change made on the page, kept in the draft of a profile not created yet. */
export function applyToDraft(d: ProfileDraft, body: HouseholdProfileUpdate): ProfileDraft {
  return {
    name: body.name ?? d.name,
    color: body.color ?? d.color,
    pin: body.pin !== undefined ? body.pin : d.pin,
    contentRestrictions: body.contentRestrictions !== undefined ? body.contentRestrictions : d.contentRestrictions,
  };
}

export type EditorProps =
  | { p: HouseholdProfile; onGone: () => void }
  | { p?: undefined; profiles: HouseholdProfile[]; onGone: (created?: HouseholdProfile) => void };

/** A profile's page; without `p`, a new profile's (with Save), whose colour starts on a free one. */
export function Editor(props: EditorProps) {
  const t = useT();
  const qc = useQueryClient();
  const existing = props.p;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(() => ({
    name: '',
    color: props.p ? props.p.color : firstFreeColor(props.profiles),
    pin: null,
    contentRestrictions: null,
  }));
  const refresh = () => qc.invalidateQueries({ queryKey: householdKeys.profiles() });
  const update = useMutation({ mutationFn: (body: HouseholdProfileUpdate) => householdsApi.update(existing!.id, body), onSuccess: refresh });
  const create = useMutation({
    mutationFn: (body: HouseholdProfileCreate) => householdsApi.create(body),
    onSuccess: async (created) => {
      await refresh();
      props.onGone(created);
    },
  });
  const remove = useMutation({
    mutationFn: () => householdsApi.remove(existing!.id),
    onSuccess: async () => {
      setPanel(null);
      await refresh();
      props.onGone();
    },
  });
  const save = (body: HouseholdProfileUpdate, after?: () => void) => {
    if (existing) update.mutate(body, { onSuccess: () => after?.() });
    else {
      setDraft((d) => applyToDraft(d, body));
      after?.();
    }
  };
  const p = existing ?? {
    name: draft.name,
    color: draft.color,
    initial: draft.name.trim() ? initialOf(draft.name) : '?',
    hasPin: draft.pin !== null,
    isOwner: false,
    contentRestrictions: draft.contentRestrictions,
  };
  const title = p.name || t('app.tv.addProfile');
  const busy = update.isPending || create.isPending;
  const lim = limits(p);
  const limitLabel = (v: string | null) => v ?? t('app.tv.manage.noLimit');

  return (
    <TvPanel className="tv-manage__editor" label={title} onClose={() => props.onGone()}>
      <div className="tv-manage__head">
        <ProfileAvatar color={p.color} initial={p.initial} size={64} />
        <h1 className="tv-h1">{title}</h1>
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
          {existing ? (
            <button type="button" className="tv-opt" data-tv-key="mp-delete" onClick={() => setPanel({ kind: 'delete' })}>
              <span className="tv-opt__text">
                <span className="tv-opt__label tv-danger">{t('app.tv.manage.delete')}</span>
              </span>
            </button>
          ) : null}
        </>
      ) : null}
      {existing ? null : (
        <div className="tv-btns tv-manage__save" data-tv-row="">
          <button type="button" className="tv-btn tv-btn--primary" data-tv-key="mp-save" disabled={!draft.name.trim() || create.isPending} onClick={() => create.mutate(createBody(draft))}>
            {t('common.save')}
          </button>
        </div>
      )}
      {update.isError || create.isError ? (
        <div className="tv-pin__msg" role="status">
          {t('app.tv.saveFailed')}
        </div>
      ) : null}

      {panel?.kind === 'name' ? (
        <TvPanel label={t('app.tv.profileName')} onClose={() => setPanel(null)}>
          <NameKeyboard title={t('app.tv.profileName')} initial={p.name} busy={busy} onDone={(name) => save({ name, initial: initialOf(name) }, () => setPanel(null))} />
        </TvPanel>
      ) : null}
      {panel?.kind === 'pin' ? (
        <TvPanel label={t('app.tv.manage.pin')} onClose={() => setPanel(null)}>
          <PinPad
            key={panel.step}
            title={t(panel.step === 'first' ? 'app.tv.manage.newPin' : 'app.tv.manage.confirmPin')}
            message={panel.mismatch ? t('app.tv.manage.pinMismatch') : null}
            busy={busy}
            onComplete={(pin) => {
              if (panel.step === 'first') setPanel({ kind: 'pin', step: 'confirm', first: pin });
              else if (pin === panel.first) save({ pin }, () => setPanel(null));
              else setPanel({ kind: 'pin', step: 'first', mismatch: true });
            }}
          />
        </TvPanel>
      ) : null}
      {panel?.kind === 'delete' && existing ? (
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
  const { profiles, canManage, max } = useActiveProfile();
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
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
          <Editor
            key="new"
            profiles={profiles}
            onGone={(created) => {
              setAdding(false);
              if (created) focusTileSoon(`mp-${created.id}`);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** After a panel closes (it hands focus back first): focus the tile with this key once it is drawn. */
export function focusTileSoon(key: string, tries = 20): void {
  const attempt = (left: number) => {
    const el = document.querySelector<HTMLElement>(`[data-tv-key="${key}"]`);
    if (el) {
      const fm = tvRuntime()?.focus;
      if (fm) fm.focus(el, undefined, true);
      else el.focus();
    } else if (left > 0) window.setTimeout(() => attempt(left - 1), 50);
  };
  window.setTimeout(() => attempt(tries), 0);
}
