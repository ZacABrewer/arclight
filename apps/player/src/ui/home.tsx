import { useT } from '@web/i18n/index';
import { PlayerHome } from '@web/features/player/ui/player-home';
import { Banner } from '@web/arclight/index';
import { useNet } from '../app/context';
import { DownloadList } from './downloads';

/** Home: "continue listening" from the server; offline, what is downloaded. */
export function AppHome() {
  const t = useT();
  const net = useNet();
  if (net.online) return <PlayerHome />;
  return (
    <div className="app-page">
      <Banner tone="warn">{t('app.offlineHelp')}</Banner>
      <h1 className="app-page__title">{t('app.home.offlineTitle')}</h1>
      <DownloadList onlyReady />
    </div>
  );
}
