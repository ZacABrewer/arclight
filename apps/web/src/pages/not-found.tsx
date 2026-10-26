import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Button } from '../arclight/index.js';
import { useAuth } from '../auth/auth-context.js';
import { useBackdropOptions } from '../layout/shell-options.js';
import { t } from '../i18n/index.js';

/** Page 09: mono 404, plain explanation, the way back. The vanishing point moves right. */
export function NotFoundPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  useBackdropOptions({ vx: 0.78, horizon: 0.65, circuit: false });
  useEffect(() => {
    document.title = t('notFound.pageNotFoundArclight');
  }, []);
  const path = typeof location === 'undefined' ? '' : location.pathname;
  return (
    <section className="nf" aria-labelledby="nf-title">
      <div className="nf__code al-num" aria-hidden="true">
        404
      </div>
      <h1 id="nf-title" className="nf__title">
        {t('notFound.pageNotFound')}
      </h1>
      <p className="nf__body">
        {t('notFound.thisPageDoesntExistOr')}
        {path ? (
          <>
            {' '}
            <span className="al-num nf__path">{path}</span>
          </>
        ) : null}
      </p>
      <div className="nf__actions">
        <Button variant="primary" onClick={() => void router.navigate({ to: '/' })}>
          {t('notFound.goToDashboard')}
        </Button>
        {isAdmin ? (
          // There is no bug tracker in the app; the logs are where a problem gets reported from.
          <Button variant="secondary" onClick={() => void router.navigate({ to: '/system/logs' })}>
            {t('notFound.reportAProblem')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
