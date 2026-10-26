import type { Indexer, TorrentEngineState } from '@arclight/shared';
import { Link } from '@tanstack/react-router';
import { Chip, ErrorBlock, KeyValue, Pane, ProtocolBadge, Skeleton, type ChipTone, type KeyValueItem } from '../../arclight/index.js';
import { useIndexerList } from '../../hooks/indexers.js';
import { useSystemStatus } from '../../hooks/system.js';
import { useTorrentStatus } from '../../hooks/torrent.js';
import { formatRate, formatSpan, formatStamp } from './format.js';
import { SystemHeader } from './system-header.js';
import { t } from '../../i18n/index.js';

const ENGINE_LABEL: Record<TorrentEngineState, [string, ChipTone]> = {
  get running() {
    return [t('common.running'), 'accent'] as [string, ChipTone];
  },
  get starting() {
    return [t('system.status.starting'), 'neutral'] as [string, ChipTone];
  },
  get lockdown() {
    return [t('system.status.lockdown'), 'warn'] as [string, ChipTone];
  },
  get error() {
    return [t('status.failed'), 'danger'] as [string, ChipTone];
  },
  get disabled() {
    return [t('common.disabled'), 'muted'] as [string, ChipTone];
  },
};

/** The built-in engine's live numbers (moved here from the old dashboard card). */
function EnginePane() {
  const engine = useTorrentStatus();
  const s = engine.data;
  if (engine.isError || !s) return null;
  const [label, tone] = ENGINE_LABEL[s.state];
  const items: KeyValueItem[] = [{ label: t('common.state'), value: <Chip tone={tone}>{label}</Chip>, mono: false }];
  if (s.state !== 'disabled') {
    items.push(
      { label: t('common.download'), value: formatRate(s.downloadRate) },
      { label: t('common.upload'), value: formatRate(s.uploadRate) },
      { label: t('system.status.torrents'), value: `${s.torrents.downloading} downloading · ${s.torrents.seeding} seeding · ${s.torrents.total} total` },
      { label: t('common.peers'), value: String(s.peers) },
    );
  }
  if (s.state === 'lockdown') {
    items.push({ label: t('system.status.cause'), value: t('system.status.vpnDownTorrentsArePaused', { value: s.lockdownReason ? ` (${s.lockdownReason})` : '' }), mono: false });
  }
  return (
    <Pane
      title={t('common.torrentEngine')}
      actions={
        <Link to="/settings/torrent" className="al-link">
          {t('common.settings')}
        </Link>
      }
    >
      <KeyValue items={items} />
    </Pane>
  );
}

/** Indexer health as a chip: paused until a time, recently failing, or OK. */
export function indexerChip(i: Pick<Indexer, 'status'>, now: number = Date.now()): { tone: ChipTone; label: string } {
  const st = i.status;
  const till = st?.disabledTill ? new Date(st.disabledTill).getTime() : NaN;
  if (Number.isFinite(till) && till > now) return { tone: 'warn', label: t('system.status.pausedRetryInSpan', { span: formatSpan(till - now) }) };
  if (st && st.failureCount > 0) return { tone: 'warn', label: t('system.status.failurecountRecentFailures', { failureCount: st.failureCount }) };
  return { tone: 'accent', label: t('system.status.ok') };
}

function IndexersPane() {
  const list = useIndexerList();
  if (list.isError) return null;
  const rows = list.data ?? [];
  return (
    <Pane
      title={t('common.indexers')}
      actions={
        <Link to="/indexers" className="al-link">
          {t('system.status.manage')}
        </Link>
      }
    >
      {list.isLoading ? (
        <Skeleton lines={3} />
      ) : rows.length === 0 ? (
        <p className="sys-muted">{t('system.status.noIndexersYet')}</p>
      ) : (
        <ul className="sys-list">
          {rows.map((i) => {
            const chip = indexerChip(i);
            return (
              <li key={i.id}>
                <span className="sys-list__name">{i.name}</span>
                <ProtocolBadge protocol={i.protocol} />
                <Chip tone={chip.tone}>{chip.label}</Chip>
              </li>
            );
          })}
        </ul>
      )}
    </Pane>
  );
}

export function SystemStatusPage() {
  const status = useSystemStatus();
  return (
    <>
      <SystemHeader title={t('common.status')} />
      {status.isPending ? (
        <Pane>
          <Skeleton lines={5} />
        </Pane>
      ) : status.isError ? (
        <ErrorBlock title={t('system.status.couldntReadTheSystemStatus')} onRetry={() => void status.refetch()} />
      ) : (
        <div className="sys-cols">
          <Pane title={t('system.status.about')}>
            <KeyValue
              items={[
                { label: t('common.version'), value: status.data.version },
                { label: t('system.status.started'), value: formatStamp(status.data.startTime) },
                { label: t('system.status.uptime'), value: formatSpan(status.data.uptimeSeconds * 1000) },
                { label: t('system.status.docker'), value: status.data.isDocker ? t('common.yes') : t('common.no') },
              ]}
            />
          </Pane>
          <Pane title={t('common.runtime')}>
            <KeyValue
              items={[
                { label: t('system.status.node'), value: status.data.runtime.node },
                { label: t('system.status.platform'), value: status.data.runtime.platform },
                { label: t('system.status.architecture'), value: status.data.runtime.arch },
              ]}
            />
          </Pane>
          <Pane title={t('system.status.paths')}>
            <KeyValue
              items={[
                { label: t('system.status.config'), value: status.data.paths.config },
                { label: t('system.status.database'), value: status.data.paths.database },
                { label: t('common.logs'), value: status.data.paths.logs },
              ]}
            />
          </Pane>
          <EnginePane />
          <IndexersPane />
        </div>
      )}
    </>
  );
}
