import { useT } from '@web/i18n/index';
import { usePlayer } from '@web/features/player/player-context';
import { QueuePanel } from '@web/features/player/ui/now-playing';

export function QueuePage() {
  const t = useT();
  const player = usePlayer();
  return (
    <div className="app-page">
      <h1 className="app-page__title">{t('app.queue.title')}</h1>
      <QueuePanel player={player} />
    </div>
  );
}
