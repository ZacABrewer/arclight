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
  Input,
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
import { useSystemStatus } from '../../hooks/system.js';
import { relativeTime } from '../../lib/format.js';
import { formatBytes, formatStamp } from './format.js';
import { formatContext, LEVEL_LABELS, LEVEL_TONES, mergeLive, visibleRecords, type LogFilter } from './logs-model.js';
import { SystemHeader } from './system-header.js';

const PAGE_SIZE = 50;
export const logKeys = {
  all: ['logs'] as const,
  page: (page: number, filter: LogFilter) => ['logs', 'page', page, filter] as const,
  files: ['logs', 'files'] as const,
};

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

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
      <summary className="sys-log__msg">{r.message || <span className="sys-muted">(no message)</span>}</summary>
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
      {!tailing ? 'Not tailing' : !connected ? 'Connecting…' : paused ? 'Paused' : 'Tailing'}
      {fresh ? (
        <>
          {' · '}
          <span className="al-num">{fresh}</span> new
        </>
      ) : null}
    </span>
  );
}

function EventsTab() {
  const qc = useQueryClient();
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const [page, setPage] = useState(1);
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
    meta: { errorTitle: 'Could not clear logs' },
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

  const columns: Column<LogRecord>[] = [
    {
      key: 'time',
      header: 'Time',
      width: '170px',
      mono: true,
      cell: (r) => (
        <time dateTime={r.time} title={relativeTime(r.time)}>
          {formatStamp(r.time)}
        </time>
      ),
    },
    { key: 'level', header: 'Level', width: '96px', cell: (r) => <Chip tone={LEVEL_TONES[r.level]}>{LEVEL_LABELS[r.level]}</Chip> },
    { key: 'component', header: 'Component', width: '150px', mono: true, muted: true, cell: (r) => r.component ?? '—' },
    { key: 'message', header: 'Message', mono: true, cell: (r) => <LogMessage r={r} /> },
  ];

  return (
    <Pane flush>
      <FilterBar
        onClear={level || searchText ? () => (setLevel(''), setSearchText(''), setPage(1)) : undefined}
        activeCount={(level ? 1 : 0) + (searchText ? 1 : 0)}
        end={
          <>
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
                {paused ? `Resume${held.length ? ` (${held.length} new)` : ''}` : 'Pause'}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void logs.refetch()} loading={logs.isFetching}>
              Refresh
            </Button>
            <Button size="sm" variant="danger" onClick={() => clear.mutate()} loading={clear.isPending}>
              Clear logs
            </Button>
          </>
        }
      >
        <Select
          aria-label="Minimum level"
          value={level}
          onChange={(e) => {
            setLevel(e.currentTarget.value as LogLevel | '');
            setPage(1);
          }}
          options={[{ value: '', label: 'All levels' }, ...LogLevel.options.map((l) => ({ value: l, label: `${LEVEL_LABELS[l]} and above` }))]}
        />
        <Input
          aria-label="Search logs"
          type="search"
          placeholder="Search messages"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.currentTarget.value);
            setPage(1);
          }}
        />
        <Toggle label="Live tail" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
      </FilterBar>
      {logs.isError ? (
        <div className="sys-pad">
          <ErrorBlock title="Couldn't load logs" onRetry={() => void logs.refetch()} />
        </div>
      ) : (
        <>
          <Table
            caption="Log entries"
            className="sys-log"
            density="dense"
            columns={columns}
            rows={logs.data ? rows : undefined}
            rowKey={(r) => r.id}
            loading={logs.isPending}
            sortable={false}
            manualSort
            empty={<EmptyState title="No log entries">{level || search ? 'Nothing matches these filters.' : 'The in-memory log is empty.'}</EmptyState>}
          />
          {pageCount > 1 ? (
            <div className="sys-foot">
              <Paginator page={page} pageCount={pageCount} onPageChange={setPage} />
            </div>
          ) : null}
        </>
      )}
    </Pane>
  );
}

function FilesTab() {
  const files = useQuery({ queryKey: logKeys.files, queryFn: logsApi.files });
  const status = useSystemStatus();
  const columns: Column<LogFile>[] = [
    { key: 'name', header: 'File', mono: true, sortValue: (f) => f.name, cell: (f) => f.name },
    { key: 'size', header: 'Size', mono: true, align: 'right', sortValue: (f) => f.sizeBytes, cell: (f) => formatBytes(f.sizeBytes) },
    {
      key: 'modified',
      header: 'Last written',
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
      header: <span className="al-sr-only">Download</span>,
      align: 'right',
      cell: (f) => (
        <LinkButton size="sm" variant="ghost" href={logsApi.fileUrl(f.name)} download={f.name}>
          Download
        </LinkButton>
      ),
    },
  ];
  return (
    <Pane flush>
      {files.isError ? (
        <div className="sys-pad">
          <ErrorBlock title="Couldn't list log files" onRetry={() => void files.refetch()} />
        </div>
      ) : (
        <Table
          caption="Log files"
          columns={columns}
          rows={files.data}
          rowKey={(f) => f.name}
          loading={files.isPending}
          empty={
            <EmptyState title="No log files">
              Logs are written to {status.data ? <span className="al-num">{status.data.paths.logs}</span> : 'the log folder'}.
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
      <SystemHeader title="Logs" />
      <Tabs
        aria-label="Log views"
        tabs={[
          { id: 'events', label: 'Events', content: <EventsTab /> },
          { id: 'files', label: 'Files', content: <FilesTab /> },
        ]}
      />
    </>
  );
}
