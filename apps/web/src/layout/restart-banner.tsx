import { useEffect, useState } from 'react';
import { systemApi } from '../api/system.js';
import { Button } from '../components/button.js';
import { useRestart } from '../hooks/backup.js';
import { useSystemStatus } from '../hooks/system.js';

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

/** Shown under the top bar when /system/status says state changed that only a restart picks up. */
export function RestartBanner({ reload = reloadPage, pollMs = 2000 }: { reload?: () => void; pollMs?: number }) {
  const status = useSystemStatus();
  const restart = useRestart();
  const [waitingOn, setWaitingOn] = useState<string | null>(null);
  useReloadWhenBack(waitingOn, reload, pollMs);

  if (!status.data?.restartRequired && waitingOn === null) return null;
  return (
    <div className="restart-banner" role="status">
      {waitingOn !== null ? (
        <span>Restarting Arclight… this page reloads when it is back.</span>
      ) : (
        <>
          <span>
            <strong>Restart required.</strong> A backup was restored; restart Arclight to load it.
          </span>
          <Button
            size="sm"
            variant="primary"
            loading={restart.isPending}
            onClick={() => restart.mutate(undefined, { onSuccess: () => setWaitingOn(status.data?.startTime ?? '') })}
          >
            Restart now
          </Button>
        </>
      )}
    </div>
  );
}
