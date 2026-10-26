// Fixture for i18n-check.test.ts: uses a key en.json lacks; en.json has an unused key.
import { t } from './i18n.js';
export const Page = () => (
  <p>
    {t('page.title')} {t('page.count', { count: 2 })} {t('page.notInCatalog')}
  </p>
);
