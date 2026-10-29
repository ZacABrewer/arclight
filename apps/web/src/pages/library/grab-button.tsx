import type { ReleaseDecision } from '@arclight/shared';
import { useState } from 'react';
import { Button, RejectionList } from '../../arclight/index.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { t } from '../../i18n/index.js';

/**
 * The Grab cell of the release tables. Approved releases grab on click; rejected releases the
 * server can still map to a library item (`downloadAllowed`) offer "Grab anyway" behind a
 * confirmation listing the rejections; releases it cannot map stay disabled.
 */
export function GrabButton({
  release,
  loading,
  onGrab,
}: {
  release: Pick<ReleaseDecision, 'title' | 'approved' | 'downloadAllowed' | 'rejections'>;
  loading: boolean;
  onGrab: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const override = !release.approved && release.downloadAllowed;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-label={t(override ? 'library.grabButton.grabAnywayTitle' : 'library.interactiveSearch.grabTitle', { title: release.title })}
        disabled={!release.downloadAllowed}
        loading={loading}
        onClick={() => (override ? setConfirming(true) : void onGrab().catch(() => undefined))}
      >
        {override ? t('library.grabButton.grabAnyway') : t('library.interactiveSearch.grab')}
      </Button>
      {override ? (
        <ConfirmDialog
          open={confirming}
          title={t('library.grabButton.grabRejectedRelease')}
          confirmLabel={t('library.grabButton.grabAnyway')}
          danger={false}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await onGrab();
            setConfirming(false);
          }}
        >
          <p>{t('library.grabButton.overrideExplanation', { title: release.title })}</p>
          <RejectionList reasons={release.rejections.map((x) => x.message)} />
        </ConfirmDialog>
      ) : null}
    </>
  );
}
