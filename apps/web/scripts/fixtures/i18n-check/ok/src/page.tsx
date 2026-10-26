// Fixture for i18n-check.test.ts: every key is used, every locale complete.
import { t } from './i18n.js';
const STATUS = ['queued', 'failed'];
export const Page = () => (
  <p>
    {t('page.title')} {t('page.count', { count: 2 })} {STATUS.map((s) => t(`status.${s}`))}
  </p>
);
