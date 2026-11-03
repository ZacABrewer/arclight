import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useT } from '@web/i18n/index';
import { RdProfilesPage } from '@web/features/player/redesign/pages/profiles';
import { RdSettingsPage } from '@web/features/player/redesign/pages/settings';
import { ActionRow, InfoRow, ToggleRow } from '@web/features/player/redesign/settings-rows';
import { RedesignFrame } from '@web/features/player/redesign/shell';
import { useAccounts } from '../app/context';
import { APP_VERSION } from '../config';
import { getSession } from '../core/session';
import { markPicked } from '../households/state';
import { playIntroOnLaunch, setPlayIntroOnLaunch } from '../intro/launch';

// The phone shares the web /player's portrait pages (spec §4.4): "Who's watching?" with Manage
// profiles, and the profile's settings. The app keeps its own chrome and theme loading: the shell
// wraps its pages in RedesignFrame (layout and display settings, no theme), and the picker, which
// sits outside the shell, wraps itself. What only the app has (play the intro on launch, the app
// version, the device settings page) goes in as device rows.

export const DEVICE_SETTINGS_PATH = '/player/settings/app';

/** The picker. `gate`: before the first /player page of an app run (no way out but choosing). */
export function PhoneProfilesPage({ gate = false }: { gate?: boolean }) {
  const navigate = useNavigate();
  const onPicked = () => {
    // The web page marks its own flag; the app's launch gate reads this one.
    const s = getSession();
    if (s) markPicked(s.accountId);
    void navigate({ to: '/player', replace: gate });
  };
  return (
    <RedesignFrame className="rd-bare">
      <RdProfilesPage gate={gate} onPicked={onPicked} />
    </RedesignFrame>
  );
}

/** The profile's settings, plus this device's rows. */
export function PhoneSettingsPage() {
  const t = useT();
  const navigate = useNavigate();
  const { active } = useAccounts();
  const [intro, setIntro] = useState(playIntroOnLaunch);
  return (
    <RdSettingsPage
      server={active ? hostOf(active.serverUrl) : undefined}
      deviceRows={{
        display: (
          <ToggleRow
            label={t('app.tv.settings.playIntro')}
            checked={intro}
            onChange={(next) => {
              setPlayIntroOnLaunch(next);
              setIntro(next);
            }}
          />
        ),
        about: (
          <>
            <InfoRow label={t('app.tv.settings.appVersion')} value={APP_VERSION} />
            <ActionRow label={t('app.settings.device')} desc={t('app.settings.deviceDesc')} onClick={() => void navigate({ to: DEVICE_SETTINGS_PATH })} />
          </>
        ),
      }}
    />
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
