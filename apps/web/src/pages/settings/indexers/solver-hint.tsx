import { Link } from '@tanstack/react-router';
import './indexers.css';
import { t } from '../../../i18n/index.js';

/** "Needs a challenge solver. Set up" — shown when a definition needs one and no solver proxy exists. */
export function SolverHint({ as = 'p' }: { as?: 'p' | 'span' }) {
  const Tag = as;
  return (
    <Tag className="al-card-line al-solver-hint" role="note">
      {t('settings.indexers.solverHint.needsAChallengeSolver')}
      <Link to="/settings/solver" className="al-link">
        {t('settings.indexers.solverHint.setUp')}
      </Link>
    </Tag>
  );
}
