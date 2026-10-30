import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogLevel, type LogFile, type LogRecord } from '@arclight/shared';
import { connectLogStream, logsApi } from '../../api/logs.js';
import {
  Button,
  Chip,
  EmptyState,
  ErrorBlock,
  FilterBar,
  LinkButton,
  LiveDot,
  Pane,
  Paginator,
  Select,
  Table,
  Tabs,
  Toggle,
  type Column,
} from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { ListSearchCount, ListSearchEmpty, ListSearchInput, useListSearch } from '../../components/list-search.js';
import { useSelection } from '../../components/bulk-actions.js';
import { BulkBar } from '../../components/media/bulk-bar.js';
import { tableSelection } from '../../components/resource-bulk-actions.js';
import { useSystemStatus } from '../../hooks/system.js';
import { relativeTime } from '../../lib/format.js';
import { formatBytes, formatStamp } from './format.js';
import { formatContext, LEVEL_LABELS, LEVEL_TONES, mergeLive, visibleRecords, type LogFilter } from './logs-model.js';
import { SystemHeader } from './system-header.js';
import { t } from '../../i18n/index.js';

const PAGE_SIZE = 50;
export const logKeys = {
  all: ['logs'] as const,
  page: (page: number, filter: LogFilter) => ['logs', 'page', page, filter] as const,
  files: ['logs', 'files'] as const,
};

function useRefValue<T>(value: T): { readonly current: T } {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}

function LogMessage({ r }: { r: LogRecord }) {
  const ctx = formatContext(r);
  if (!ctx) return <span className="sys-log__msg">{r.message}</span>;
  return (
    <details className="sys-log__details">
      <summary className="sys-log__msg">{r.message || <span className="sys-muted">{t('system.logs.noMessage')}</span>}</summary>
      <pre className="sys-log__context">{ctx}</pre>
    </details>
  );
}

/** Live-tail status: the dot glows only while records are streaming in (rule 1). */
export function TailStatus({ tailing, connected, paused, fresh }: { tailing: boolean; connected: boolean; paused: boolean; fresh: number }) {
  const live = tailing && connected && !paused;
  return (
    <span className="sys-tail" aria-live="polite" data-live={live || undefined}>
      {live ? <LiveDot /> : <span className="sys-tail__dot" aria-hidden="true" />}
      {!tailing ? t('system.logs.notTailing') : !connected ? t('system.logs.connecting') : paused ? t('status.paused') : t('system.logs.tailing')}
      {fresh ? (
        <>
          {' · '}
          <span className="al-num">{fresh}</span> {t('system.logs.new')}
        </>
      ) : null}
    </span>
  );
}

function EventsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [level, setLevel] = useState<LogLevel | ''>('');
  // The search lives in the URL (`?q=`) and is sent to GET /log as `search`; the live tail
  // applies the same rule client side (logs-model matchesLogFilter).
  const { q: search, setQ: setSearch, active: searching } = useListSearch();
  const [page, setPage] = useState(1);
  // A new search starts on page 1.
  const [searched, setSearched] = useState(search);
  if (searched !== search) {
    setSearched(search);
    setPage(1);
  }
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState<LogRecord[]>([]);
  const [held, setHeld] = useState<LogRecord[]>([]);
  const [connected, setConnected] = useState(false);
  // The stream callback reads `paused` through a ref so toggling does not reconnect.
  const pausedRef = useRefValue(paused);
  const filter: LogFilter = { ...(level ? { level } : {}), ...(search ? { search } : {}) };

  const logs = useQuery({
    queryKey: logKeys.page(page, filter),
    queryFn: () => logsApi.list({ page, pageSize: PAGE_SIZE, ...filter }),
    placeholderData: keepPreviousData,
  });

  // A fresh fetch already contains whatever streamed in before it.
  useEffect(() => {
    setLive([]);
  }, [logs.dataUpdatedAt]);

  useEffect(() => {
    if (!follow) return;
    const dispose = connectLogStream((record) => {
      if (pausedRef.current) setHeld((h) => mergeLive(h, [record]));
      else setLive((l) => mergeLive(l, [record]));
    }, setConnected);
    return () => {
      dispose();
      setConnected(false);
    };
  }, [follow, pausedRef]);

  const clear = useMutation({
    mutationFn: logsApi.clear,
    meta: { errorTitle: t('system.logs.couldNotClearLogs') },
    onSuccess: async () => {
      setLive([]);
      setHeld([]);
      setPage(1);
      await qc.invalidateQueries({ queryKey: logKeys.all });
    },
  });

  const fetched = logs.data?.records ?? [];
  const rows = follow && page === 1 ? visibleRecords(fetched, live, filter, PAGE_SIZE) : fetched;
  const fresh = rows.length > 0 && follow && page === 1 ? rows.filter((r) => r.id > (fetched[0]?.id ?? 0)).length : 0;
  const pageCount = logs.data ? Math.ceil(logs.data.totalRecords / PAGE_SIZE) : 1;
  const rowKeys = rows.map((r) => r.id);
  const selection = useSelection(rowKeys);
  // A new search clears the selection (rows the search hides are not copied).
  const selectionRef = useRefValue(selection);
  useEffect(() => {
    selectionRef.current.clear();
  }, [search, selectionRef]);
  const copySelected = () => {
    const picked = rows.filter((r) => selection.has(r.id));
    const text = picked
      .map((r) => [r.time, r.level.toUpperCase(), r.component ? `[${r.component}]` : '', r.message, r.context ? JSON.stringify(r.context) : ''].filter(Boolean).join(' '))
      .join('\n');
    void navigator.clipboard.writeText(text).then(
      () => {
        toast.push({ tone: 'ok', title: t('system.logs.copiedCount', { count: picked.length }), durationMs: 3_000 });
        selection.clear();
      },
      () => toast.push({ tone: 'error', title: t('system.logs.copyFailed') }),
    );
  };

  const columns: Column<LogRecord>[] = [
    {
      key: 'time',
      header: t('common.time'),
      width: '170px',
      mono: true,
      cell: (r) => (
        <time dateTime={r.time} title={relativeTime(r.time)}>
          {formatStamp(r.time)}
        </time>
      ),
    },
    { key: 'level', header: t('system.logs.level'), width: '96px', cell: (r) => <Chip tone={LEVEL_TONES[r.level]}>{LEVEL_LABELS[r.level]}</Chip> },
    { key: 'component', header: t('system.logs.component'), width: '150px', mono: true, muted: true, cell: (r) => r.component ?? '—' },
    { key: 'message', header: t('system.logs.message'), mono: true, cell: (r) => <LogMessage r={r} /> },
  ];

  return (
    <Pane flush>
      <FilterBar
        onClear={level || search ? () => (setLevel(''), setSearch(''), setPage(1)) : undefined}
        activeCount={(level ? 1 : 0) + (search ? 1 : 0)}
        end={
          <>
            <ListSearchCount active={searching} shown={logs.data?.totalRecords} />
            <TailStatus tailing={follow} connected={connected} paused={paused} fresh={fresh} />
            {follow ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (paused) {
                    setLive((l) => mergeLive(l, held));
                    setHeld([]);
                  }
                  setPaused(!paused);
                }}
              >
                {paused ? t('system.logs.resumeValue', { value: held.length ? ` (${held.length} new)` : '' }) : t('system.logs.pause')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void logs.refetch()} loading={logs.isFetching}>
              {t('common.refresh')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => clear.mutate()} loading={clear.isPending}>
              {t('system.logs.clearLogs')}
            </Button>
          </>
        }
      >
        <Select
          aria-label={t('system.logs.minimumLevel')}
          value={level}
          onChange={(e) => {
            setLevel(e.currentTarget.value as LogLevel | '');
            setPage(1);
          }}
          options={[{ value: '', label: t('system.logs.allLevels') }, ...LogLevel.options.map((l) => ({ value: l, label: t('system.logs.valueAndAbove', { value: LEVEL_LABELS[l] }) }))]}
        />
        <ListSearchInput value={search} onChange={setSearch} label={t('system.logs.searchLogs')} placeholder={t('listSearch.ph.logs')} />
        <Toggle label={t('system.logs.liveTail')} checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
      </FilterBar>
      {logs.isError ? (
        <div className="sys-pad">
          <ErrorBlock title={t('system.logs.couldntLoadLogs')} onRetry={() => void logs.refetch()} />
        </div>
      ) : (
        <>
          <Table
            caption={t('system.logs.logEntries')}
            className="sys-log"
            density="dense"
            columns={columns}
            rows={logs.data ? rows : undefined}
            rowKey={(r) => r.id}
            loading={logs.isPending}
            sortable={false}
            manualSort
            {...tableSelection(selection)}
            rowLabel={(r) => t('components.bulkActions.selectName', { name: r.message })}
            empty={
              searching ? (
                <ListSearchEmpty query={search} onClear={() => setSearch('')} />
              ) : (
                <EmptyState title={t('system.logs.noLogEntries')}>{level ? t('system.logs.nothingMatchesTheseFilters') : t('system.logs.theInMemoryLogIs')}</EmptyState>
              )
            }
          />
          {pageCount > 1 ? (
            <div className="sys-foot">
              <Paginator page={page} pageCount={pageCount} onPageChange={setPage} />
            </div>
          ) : null}
          <BulkBar
            count={selection.count}
            total={rowKeys.length}
            onSelectAll={() => selection.set(rowKeys)}
            onClear={selection.clear}
            actions={[{ id: 'copy', label: t('system.logs.copySelected'), onSelect: copySelected }]}
          />
        </>
      )}
    </Pane>
  );
}

function FilesTab() {
  const files = useQuery({ queryKey: logKeys.files, queryFn: logsApi.files });
  const status = useSystemStatus();
  const columns: Column<LogFile>[] = [
    { key: 'name', header: t('common.file'), mono: true, sortValue: (f) => f.name, cell: (f) => f.name },
    { key: 'size', header: t('common.size'), mono: true, align: 'right', sortValue: (f) => f.sizeBytes, cell: (f) => formatBytes(f.sizeBytes) },
    {
      key: 'modified',
      header: t('system.logs.lastWritten'),
      mono: true,
      sortValue: (f) => f.lastModified,
      cell: (f) => (
        <time dateTime={f.lastModified} title={formatStamp(f.lastModified)}>
          {relativeTime(f.lastModified)}
        </time>
      ),
    },
    {
      key: 'download',
      header: <span className="al-sr-only">{t('common.download')}</span>,
      align: 'right',
      cell: (f) => (
        <LinkButton size="sm" variant="ghost" href={logsApi.fileUrl(f.name)} download={f.name}>
          {t('common.download')}
        </LinkButton>
      ),
    },
  ];
  return (
    <Pane flush>
      {files.isError ? (
        <div className="sys-pad">
          <ErrorBlock title={t('system.logs.couldntListLogFiles')} onRetry={() => void files.refetch()} />
        </div>
      ) : (
        <Table
          caption={t('system.logs.logFiles')}
          columns={columns}
          rows={files.data}
          rowKey={(f) => f.name}
          loading={files.isPending}
          empty={
            <EmptyState title={t('system.logs.noLogFiles')}>
              {t('system.logs.logsAreWrittenTo')} {status.data ? <span className="al-num">{status.data.paths.logs}</span> : t('system.logs.theLogFolder')}.
            </EmptyState>
          }
        />
      )}
    </Pane>
  );
}

/** System → Logs: live tail of the in-memory log with filters, and the rotated log files. */
export function SystemLogsPage() {
  return (
    <>
      <SystemHeader title={t('common.logs')} />
      <Tabs
        aria-label={t('system.logs.logViews')}
        tabs={[
          { id: 'events', label: t('system.logs.events'), content: <EventsTab /> },
          { id: 'files', label: t('common.files'), content: <FilesTab /> },
        ]}
      />
    </>
  );
}
