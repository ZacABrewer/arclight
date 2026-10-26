import { useEffect, useState } from 'react';
import { systemApi } from '../api/system.js';
import { Banner, Button } from '../arclight/index.js';
import { useRestart } from '../hooks/backup.js';
import { useSystemStatus } from '../hooks/system.js';
import { t } from '../i18n/index.js';

/** Polls until the api answers with a new start time, then reloads the page. */
function useReloadWhenBack(previousStart: string | null, reload: () => void, intervalMs = 2000) {
  useEffect(() => {
    if (previousStart === null) return;
    const timer = setInterval(() => {
      systemApi.status().then(
        (s) => {
          if (s.startTime !== previousStart) reload();
        },
        () => undefined, // still down
      );
    }, intervalMs);
    return () => clearInterval(timer);
  }, [previousStart, reload, intervalMs]);
}

const reloadPage = () => window.location.reload();

/** Warn banner at the top of the content when /system/status says a restart is needed. */
export function RestartBanner({ reload = reloadPage, pollMs = 2000 }: { reload?: () => void; pollMs?: number }) {
  const status = useSystemStatus();
  const restart = useRestart();
  const [waitingOn, setWaitingOn] = useState<string | null>(null);
  useReloadWhenBack(waitingOn, reload, pollMs);

  if (!status.data?.restartRequired && waitingOn === null) return null;
  if (waitingOn !== null) {
    return <Banner className="al-shell-banner">{t('layout.restartBanner.restartingArclightThisPageReloads')}</Banner>;
  }
  return (
    <Banner
      tone="warn"
      className="al-shell-banner"
      action={
        <Button size="sm" variant="primary" loading={restart.isPending} onClick={() => restart.mutate(undefined, { onSuccess: () => setWaitingOn(status.data?.startTime ?? '') })}>
          {t('layout.restartBanner.restartNow')}
        </Button>
      }
    >
      {t('layout.restartBanner.restartRequiredABackupWas')}
    </Banner>
  );
}
