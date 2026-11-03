import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useT } from '@web/i18n/index';
import { cx } from '@web/arclight/cx';
import { useActiveProfile, useProfileSettings } from '../../households/api';
import { usePickProfile } from '../../households/use-pick';
import { Lockup } from '@web/arclight/lockup';
import { RdIcon } from '@web/features/player/redesign/icons';
import { ProfileAvatar } from '@web/features/player/redesign/profile-avatar';
import { canAddProfile, parseProfilesSearch } from '@web/features/player/redesign/profile-session';
import { PinPad, TvPanel } from '../profile-parts';
import { TvStage } from '../stage';
import { HOME_PATH, tvRuntime } from '../tv-runtime';
import { Editor, focusTileSoon } from './manage-profiles';
import '../tv.css';

// "Who's watching?" on TV (template "profiles", §4.3, §9 Q3/Q5; features spec §1): the lockup
// top-left, the title, one row of 132 px avatars with names. The avatar circle takes focus and its
// name lights up with it. A final round "Add profile" tile while the owner profile is active and
// there is room opens the full new-profile page; the new profile is not switched to, its tile takes
// focus. A profile with a PIN opens the PIN pad. Choosing goes to Home with focus on the hero's Play.
// Under the row, for the owner profile, the pencil "Manage profiles" button turns the tiles into edit
// mode (choosing one opens its page); Back leaves edit mode first. `?manage=1` arrives in edit mode,
// `&add=1` with the new-profile page open (Settings > Profiles > Add profile).

const BACK_KEYS = new Set(['Escape', 'GoBack', 'BrowserBack']);

export function TvProfilesScreen() {
  const t = useT();
  const navigate = useNavigate();
  const settings = useProfileSettings();
  const search = parseProfilesSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const { profile: active, profiles, canManage, max } = useActiveProfile();
  const [managing, setManaging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const lastTile = useRef<HTMLElement | null>(null);
  const picker = usePickProfile(() => {
    tvRuntime()?.focus.forget();
    void navigate({ to: HOME_PATH });
  });
  const canAdd = canAddProfile({ canManage, count: profiles.length, max });
  const isManaging = managing && canManage;

  // Arriving with ?manage=1 (and &add=1): once the profiles are in.
  const arrived = useRef(false);
  const loaded = profiles.length > 0;
  useEffect(() => {
    if (!loaded || arrived.current) return;
    arrived.current = true;
    if (!search.manage || !canManage) return;
    setManaging(true);
    if (search.add && canAdd) setAdding(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const editing = editingId !== null ? (profiles.find((p) => p.id === editingId) ?? null) : null;

  // Edit mode is a scope, so the remote's Back reaches it as Escape: back to pick mode.
  const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isManaging || !BACK_KEYS.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    setManaging(false);
  };
  // Up from the button goes back to the tile that was focused last, not the nearest one.
  const onManageKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const tile = lastTile.current;
    if (e.key !== 'ArrowUp' || !tile?.isConnected) return;
    e.preventDefault();
    const fm = tvRuntime()?.focus;
    if (fm) fm.focus(tile, 'up');
    else tile.focus();
  };

  return (
    <TvStage focusStyle={settings.focusStyle} reduceMotion={settings.reduceMotion} className={settings.reduceMotion ? 'tv-motion-off' : undefined}>
      <div className={cx('tv-profiles', isManaging && 'is-managing')} data-tv-scope={isManaging ? '' : undefined} onKeyDown={onRootKey}>
        <Lockup height={22} className="tv-profiles__logo" />
        <h1 className="tv-profiles__title">{isManaging ? t('player.redesign.profiles.manageTitle') : t('app.tv.whoIsWatching')}</h1>
        <div className="tv-profiles__row" data-tv-row="">
          {profiles.map((p) => (
            <div key={p.id} className="tv-prof">
              <button
                type="button"
                className="tv-prof__avatar"
                data-tv-key={`prof-${p.id}`}
                data-tv-autofocus={p.id === active?.id ? '' : undefined}
                data-tv-r="66"
                onFocus={(e) => (lastTile.current = e.currentTarget)}
                onClick={() => (isManaging ? setEditingId(p.id) : picker.pick(p))}
                aria-label={isManaging ? t('player.redesign.profiles.editNamed', { name: p.name }) : p.name}
              >
                <ProfileAvatar color={p.color} initial={p.initial} size={132} />
                {isManaging ? (
                  <span className="tv-prof__scrim" aria-hidden="true">
                    <RdIcon name="pencil" size={36} />
                  </span>
                ) : p.hasPin ? (
                  <span className="tv-prof__badge" aria-hidden="true">
                    <RdIcon name="lock" size={16} />
                  </span>
                ) : null}
              </button>
              <span className="tv-prof__name">{p.name}</span>
            </div>
          ))}
          {canAdd ? (
            <div className="tv-prof">
              <button
                type="button"
                className="tv-prof__add"
                data-tv-key="prof-add"
                data-tv-r="66"
                onFocus={(e) => (lastTile.current = e.currentTarget)}
                onClick={() => setAdding(true)}
                aria-label={t('app.tv.addProfile')}
              >
                <RdIcon name="plus" size={48} />
              </button>
              <span className="tv-prof__name">{t('app.tv.addProfile')}</span>
            </div>
          ) : null}
        </div>
        {canManage ? (
          <div className="tv-profiles__manage" data-tv-row="">
            <button type="button" className={cx('tv-prof-manage', isManaging && 'is-on')} data-tv-key="prof-manage" onClick={() => setManaging(!isManaging)} onKeyDown={onManageKey}>
              <span className="tv-prof-manage__icon" aria-hidden="true">
                <RdIcon name={isManaging ? 'check' : 'pencil'} size={20} />
              </span>
              <span className="tv-prof-manage__label">{isManaging ? t('player.redesign.profiles.done') : t('player.redesign.profiles.manage')}</span>
            </button>
          </div>
        ) : null}
        {picker.message && !picker.pinFor ? (
          <div className="tv-pin__msg" role="status">
            {picker.message}
          </div>
        ) : null}
      </div>
      {picker.pinFor ? (
        <TvPanel label={t('app.tv.pin.enterFor', { name: picker.pinFor.name })} onClose={picker.cancel}>
          <PinPad
            title={t('app.tv.pin.enterFor', { name: picker.pinFor.name })}
            message={picker.message}
            locked={picker.locked}
            busy={picker.busy}
            resetKey={picker.resetKey}
            onComplete={picker.submitPin}
          />
        </TvPanel>
      ) : null}
      {editing && isManaging ? <Editor key={editing.id} p={editing} onGone={() => setEditingId(null)} /> : null}
      {adding && canAdd ? (
        <Editor
          key="new"
          profiles={profiles}
          onGone={(created) => {
            setAdding(false);
            if (created) focusTileSoon(`prof-${created.id}`);
          }}
        />
      ) : null}
    </TvStage>
  );
}
