import { useT } from '@web/i18n/index';
import { RdHomePage } from '@web/features/player/redesign/pages/home';
import { Banner } from '@web/arclight/index';
import { useNet } from '../app/context';
import { DownloadList } from './downloads';

/** Home on phones: the redesign Home (hero, rows, listening rows); offline, what is downloaded. */
export function AppHome() {
  const t = useT();
  const net = useNet();
  if (net.online) return <RdHomePage />;
  return (
    <div className="app-page">
      <Banner tone="warn">{t('app.offlineHelp')}</Banner>
      <h1 className="app-page__title">{t('app.home.offlineTitle')}</h1>
      <DownloadList onlyReady />
    </div>
  );
}
