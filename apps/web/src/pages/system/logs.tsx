import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogLevel, type LogFile, type LogRecord } from '@arclight/shared';
import { connectLogStream, logsApi } from '../../api/logs.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Input, Select, Toggle } from '../../components/form.js';
import { Page } from '../../components/page.js';
import { Table, type Column } from '../../components/table.js';
import { Tabs } from '../../components/tabs.js';
import { useSystemStatus } from '../../hooks/system.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { Pager, formatBytes } from '../activity/activity-shared.js';
import { formatContext, LEVEL_TONES, mergeLive, visibleRecords, type LogFilter } from './logs-model.js';

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

function LogMessage({ r }: { r: LogRecord }) {
  const ctx = formatContext(r);
  if (!ctx) return <span className="break">{r.message}</span>;
  return (
    <details className="log-details">
      <summary className="break">{r.message || <span className="muted">(no message)</span>}</summary>
      <pre className="log-context">{ctx}</pre>
    </details>
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
    const dispose = connectLogStream(
      (record) => {
        if (pausedRef.current) setHeld((h) => mergeLive(h, [record]));
        else setLive((l) => mergeLive(l, [record]));
      },
      setConnected,
    );
    return () => {
      dispose();
      setConnected(false);
    };
  }, [follow]);

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
  const extra = rows.length > 0 && follow && page === 1 ? rows.filter((r) => r.id > (fetched[0]?.id ?? 0)).length : 0;

  const columns: Column<LogRecord>[] = [
    {
      key: 'time',
      header: 'Time',
      width: '150px',
      cell: (r) => (
        <time dateTime={r.time} title={relativeTime(r.time)} className="nowrap">
          {formatDateTime(r.time)}
        </time>
      ),
    },
    { key: 'level', header: 'Level', width: '80px', cell: (r) => <Badge tone={LEVEL_TONES[r.level]}>{r.level}</Badge> },
    { key: 'component', header: 'Component', width: '140px', cell: (r) => <span className="muted">{r.component ?? '—'}</span> },
    { key: 'message', header: 'Message', cell: (r) => <LogMessage r={r} /> },
  ];

  return (
    <Card flush>
      <div className="logs-toolbar">
        <Select
          aria-label="Minimum level"
          value={level}
          onChange={(e) => {
            setLevel(e.currentTarget.value as LogLevel | '');
            setPage(1);
          }}
          options={[{ value: '', label: 'All levels' }, ...LogLevel.options.map((l) => ({ value: l, label: `${l} and above` }))]}
        />
        <Input
          aria-label="Search logs"
          type="search"
          placeholder="Search messages…"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.currentTarget.value);
            setPage(1);
          }}
        />
        <Toggle label="Follow" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
        {follow ? (
          <Button
            size="sm"
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
        <span className="muted logs-status" aria-live="polite">
          {follow ? (connected ? (paused ? 'Paused' : 'Live') : 'Connecting…') : 'Not following'}
          {extra ? ` · ${extra} new` : ''}
        </span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" onClick={() => void logs.refetch()} loading={logs.isFetching}>
          Refresh
        </Button>
        <Button size="sm" variant="danger" onClick={() => clear.mutate()} loading={clear.isPending}>
          Clear
        </Button>
      </div>
      {logs.isError ? (
        <ErrorView error={logs.error} onRetry={() => void logs.refetch()} />
      ) : (
        <>
          <Table
            caption="Log entries"
            className="logs-table"
            columns={columns}
            rows={logs.data ? rows : undefined}
            rowKey={(r) => r.id}
            loading={logs.isPending}
            sortable={false}
            manualSort
            empty={<EmptyState title="No log entries">{level || search ? 'Nothing matches these filters.' : 'The in-memory log is empty.'}</EmptyState>}
          />
          {logs.data && logs.data.totalRecords > PAGE_SIZE ? <Pager page={page} pageSize={PAGE_SIZE} total={logs.data.totalRecords} onPage={setPage} /> : null}
        </>
      )}
    </Card>
  );
}

function useRefValue<T>(value: T): { readonly current: T } {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}

function FilesTab() {
  const files = useQuery({ queryKey: logKeys.files, queryFn: logsApi.files });
  const status = useSystemStatus();
  const columns: Column<LogFile>[] = [
    { key: 'name', header: 'File', sortValue: (f) => f.name, cell: (f) => <code>{f.name}</code> },
    { key: 'size', header: 'Size', align: 'right', sortValue: (f) => f.sizeBytes, cell: (f) => formatBytes(f.sizeBytes) },
    {
      key: 'modified',
      header: 'Last written',
      sortValue: (f) => f.lastModified,
      cell: (f) => (
        <time dateTime={f.lastModified} title={formatDateTime(f.lastModified)}>
          {relativeTime(f.lastModified)}
        </time>
      ),
    },
    {
      key: 'download',
      header: <span className="sr-only">Download</span>,
      align: 'right',
      cell: (f) => (
        <a className="btn btn-ghost btn-sm" href={logsApi.fileUrl(f.name)} download={f.name}>
          Download
        </a>
      ),
    },
  ];
  return (
    <Card flush>
      {files.isError ? (
        <ErrorView error={files.error} onRetry={() => void files.refetch()} />
      ) : (
        <Table
          caption="Log files"
          columns={columns}
          rows={files.data}
          rowKey={(f) => f.name}
          loading={files.isPending}
          empty={
            <EmptyState title="No log files">
              Logs are written to {status.data ? <code>{status.data.paths.logs}</code> : 'the log folder'}.
            </EmptyState>
          }
        />
      )}
    </Card>
  );
}

/** System → Logs: live tail of the in-memory log with filters, and the rotated log files. */
export function SystemLogsPage() {
  return (
    <Page title="Logs">
      <Tabs
        tabs={[
          { id: 'events', label: 'Events', content: <EventsTab /> },
          { id: 'files', label: 'Files', content: <FilesTab /> },
        ]}
      />
    </Page>
  );
}
