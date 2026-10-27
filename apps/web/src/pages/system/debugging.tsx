import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { DEBUG_COMMANDS, LogLevel, type DebugCommandResult, type DebugSnapshot } from '@arclight/shared';
import { debugApi } from '../../api/debug.js';
import { logsApi } from '../../api/logs.js';
import { Button, Chip, EmptyState, ErrorBlock, FilterBar, Icon, Input, KeyValue, Meter, Pane, Select, Skeleton, Textarea, Toggle, type KeyValueItem } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { t } from '../../i18n/index.js';
import { copyText, downloadText } from '../../lib/clipboard.js';
import { appendCommand, engineLine, logLine, memoryShare, pushHistory, resultsText, resultText, snapshotText, vpnLine } from './debugging-model.js';
import { formatBytes } from './format.js';
import { LEVEL_LABELS } from './logs-model.js';
import { SystemHeader } from './system-header.js';
import './debugging.css';

const SNAPSHOT_INTERVAL_MS = 5000;
const LOG_LINES = 200;

export const debugKeys = {
  snapshot: ['debug', 'snapshot'] as const,
  logs: (level: string, search: string) => ['debug', 'logs', level, search] as const,
};

/** Copy with a toast either way; over plain http this uses the execCommand fallback. */
function useCopy() {
  const toast = useToast();
  return async (text: string, what: string) => {
    const ok = await copyText(text);
    if (ok) toast.push({ tone: 'ok', title: t('system.debugging.copiedValue', { value: what }), durationMs: 2500 });
    else toast.error(t('system.debugging.couldNotCopy'), t('system.debugging.selectTheTextAndCopy'));
    return ok;
  };
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function SnapshotPane() {
  const [paused, setPaused] = useState(false);
  const copy = useCopy();
  const snap = useQuery({
    queryKey: debugKeys.snapshot,
    queryFn: debugApi.snapshot,
    refetchInterval: paused ? false : SNAPSHOT_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
  const s = snap.data;
  return (
    <Pane
      title={t('system.debugging.liveSnapshot')}
      actions={
        <div className="dbg-actions">
          <Toggle size="sm" label={t('system.debugging.autoRefresh')} checked={!paused} onChange={(e) => setPaused(!e.currentTarget.checked)} />
          <Button size="sm" variant="ghost" icon={<Icon name="copy" />} disabled={!s} onClick={() => s && void copy(snapshotText(s), t('system.debugging.snapshot'))}>
            {t('common.copy')}
          </Button>
        </div>
      }
    >
      {snap.isPending ? (
        <Skeleton lines={6} />
      ) : snap.isError || !s ? (
        <ErrorBlock title={t('system.debugging.couldntReadTheSnapshot')} onRetry={() => void snap.refetch()} />
      ) : (
        <SnapshotView s={s} />
      )}
    </Pane>
  );
}

function SnapshotView({ s }: { s: DebugSnapshot }) {
  const share = memoryShare(s);
  const used = s.cgroup.usage ?? s.memory.rss;
  const m = s.memory;
  const items: KeyValueItem[] = [
    {
      key: 'memory',
      label: share === null ? t('system.debugging.processMemoryRss') : t('system.debugging.containerMemory'),
      value:
        share === null ? (
          formatBytes(m.rss)
        ) : (
          <Meter
            value={share}
            tone={share >= 90 ? 'danger' : share >= 75 ? 'warn' : 'default'}
            label={t('system.debugging.containerMemory')}
            valueText={t('system.debugging.usedOfLimit', { used: formatBytes(used), limit: formatBytes(s.cgroup.limit) })}
          />
        ),
    },
    ...(share === null ? [] : [{ key: 'rss', label: t('system.debugging.processMemoryRss'), value: formatBytes(m.rss) }]),
    { key: 'heap', label: t('system.debugging.heap'), value: t('system.debugging.usedOfLimit', { used: formatBytes(m.heapUsed), limit: formatBytes(m.heapTotal) }) },
    { key: 'external', label: t('system.debugging.externalArrayBuffers'), value: `${formatBytes(m.external)} · ${formatBytes(m.arrayBuffers)}` },
    {
      key: 'cgroup',
      label: t('system.debugging.cgroup'),
      value:
        s.cgroup.version === null
          ? t('system.debugging.notReadable')
          : `v${s.cgroup.version} · anon ${formatBytes(s.cgroup.anon)} · file ${formatBytes(s.cgroup.file)}${s.cgroup.limit === null ? ` · ${t('system.debugging.noLimit')}` : ''}`,
    },
    {
      key: 'lag',
      label: t('system.debugging.eventLoopLagP99'),
      value: s.eventLoopLagP99Ms === null ? t('system.debugging.notMeasured') : `${s.eventLoopLagP99Ms.toFixed(1)} ms`,
    },
    {
      key: 'handles',
      label: t('system.debugging.activeHandles'),
      value: s.handles.available
        ? `${s.handles.total} · ${formatBytes(s.handles.queuedBytes)} ${t('system.debugging.queued')} · ${s.handles.byType
            .slice(0, 4)
            .map((h) => `${h.type} ${h.count}`)
            .join(', ')}`
        : t('system.debugging.notAvailable'),
    },
    { key: 'engine', label: t('common.torrentEngine'), value: engineLine(s) },
    { key: 'vpn', label: t('common.vpn'), value: vpnLine(s, true) },
    { key: 'runtime', label: t('system.debugging.runtime'), value: `${s.version} · ${s.node} · ${s.platform}/${s.arch}${s.isDocker ? ' · docker' : ''}` },
  ];
  return <KeyValue items={items} />;
}

function ResultBlock({ r, onCopy }: { r: DebugCommandResult; onCopy: (r: DebugCommandResult) => void }) {
  return (
    <section className="dbg-result" data-ok={r.ok || undefined} aria-label={r.command} data-testid="debug-result">
      <header className="dbg-result__head">
        <code className="dbg-result__cmd">{r.command}</code>
        <Chip tone={r.ok ? 'accent' : 'danger'}>{r.ok ? t('system.debugging.ok') : t('status.failed')}</Chip>
        <span className="dbg-result__ms al-num">{Math.round(r.durationMs)} ms</span>
        <span className="dbg-spacer" />
        <Button size="sm" variant="ghost" icon={<Icon name="copy" />} onClick={() => onCopy(r)} aria-label={t('system.debugging.copyOutputOfValue', { value: r.command })}>
          {t('common.copy')}
        </Button>
      </header>
      <pre className="dbg-pre">{r.output}</pre>
    </section>
  );
}

function ConsolePane({ results, setResults }: { results: DebugCommandResult[]; setResults: (r: DebugCommandResult[]) => void }) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const area = useRef<HTMLTextAreaElement>(null);
  const copy = useCopy();
  const run = useMutation({
    mutationFn: debugApi.run,
    meta: { errorTitle: t('system.debugging.couldntRunTheCommands') },
    onSuccess: (res) => setResults(res.results),
  });

  const submit = () => {
    if (!input.trim() || run.isPending) return;
    setHistory((h) => pushHistory(h, input));
    setCursor(-1);
    run.mutate(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
      return;
    }
    const el = e.currentTarget;
    if (e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0 && cursor + 1 < history.length) {
      e.preventDefault();
      setCursor(cursor + 1);
      setInput(history[cursor + 1]!);
    } else if (e.key === 'ArrowDown' && cursor >= 0 && el.selectionStart === el.value.length) {
      e.preventDefault();
      setCursor(cursor - 1);
      setInput(cursor - 1 >= 0 ? history[cursor - 1]! : '');
    }
  };

  const insert = (cmd: string) => {
    setInput((v) => appendCommand(v, cmd));
    area.current?.focus();
  };

  return (
    <Pane
      title={t('system.debugging.console')}
      actions={
        results.length > 0 ? (
          <Button size="sm" variant="ghost" icon={<Icon name="copy" />} onClick={() => void copy(resultsText(results), t('system.debugging.allResults'))}>
            {t('system.debugging.copyAll')}
          </Button>
        ) : null
      }
    >
      <div className="dbg-console">
        <p className="dbg-hint">{t('system.debugging.consoleHint')}</p>
        <Textarea
          ref={area}
          mono
          rows={5}
          className="dbg-input"
          aria-label={t('system.debugging.commands')}
          placeholder={t('system.debugging.pasteOrTypeCommands')}
          value={input}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            setInput(e.currentTarget.value);
            setCursor(-1);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="dbg-chips" role="group" aria-label={t('system.debugging.insertACommand')}>
          {DEBUG_COMMANDS.map((c) => (
            <button key={c} type="button" className="dbg-chip" onClick={() => insert(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="dbg-actions">
          <Button variant="primary" onClick={submit} loading={run.isPending} disabled={!input.trim()}>
            {t('system.debugging.run')}
          </Button>
          <span className="dbg-hint">{t('system.debugging.runShortcut')}</span>
          {input ? (
            <Button variant="ghost" size="sm" onClick={() => setInput('')}>
              {t('system.debugging.clearInput')}
            </Button>
          ) : null}
        </div>
        {results.length > 0 ? (
          <div className="dbg-results" aria-live="polite">
            {results.map((r, i) => (
              <ResultBlock key={`${i}-${r.command}`} r={r} onCopy={(x) => void copy(resultText(x), x.command)} />
            ))}
          </div>
        ) : null}
      </div>
    </Pane>
  );
}

function LogsPane() {
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const copy = useCopy();
  const logs = useQuery({
    queryKey: debugKeys.logs(level, search),
    queryFn: () => logsApi.list({ page: 1, pageSize: LOG_LINES, ...(level ? { level } : {}), ...(search ? { search } : {}) }),
    placeholderData: keepPreviousData,
  });
  // Newest at the bottom, like a terminal.
  const lines = (logs.data?.records ?? []).map(logLine).reverse();
  const text = lines.join('\n');
  return (
    <Pane
      flush
      title={t('common.logs')}
      actions={
        <div className="dbg-actions">
          <Button size="sm" variant="ghost" icon={<Icon name="copy" />} disabled={!lines.length} onClick={() => void copy(text, t('system.debugging.valueLogLines', { value: lines.length }))}>
            {t('common.copy')}
          </Button>
          <Button size="sm" variant="ghost" disabled={!lines.length} onClick={() => downloadText(`arclight-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, `${text}\n`)}>
            {t('system.debugging.downloadTxt')}
          </Button>
        </div>
      }
    >
      <FilterBar
        onClear={level || searchText ? () => (setLevel(''), setSearchText('')) : undefined}
        activeCount={(level ? 1 : 0) + (searchText ? 1 : 0)}
        end={
          <Button size="sm" variant="ghost" onClick={() => void logs.refetch()} loading={logs.isFetching}>
            {t('common.refresh')}
          </Button>
        }
      >
        <Select
          aria-label={t('system.logs.minimumLevel')}
          value={level}
          onChange={(e) => setLevel(e.currentTarget.value as LogLevel | '')}
          options={[{ value: '', label: t('system.logs.allLevels') }, ...LogLevel.options.map((l) => ({ value: l, label: t('system.logs.valueAndAbove', { value: LEVEL_LABELS[l] }) }))]}
        />
        <Input aria-label={t('system.logs.searchLogs')} type="search" placeholder={t('system.logs.searchMessages')} value={searchText} onChange={(e) => setSearchText(e.currentTarget.value)} />
      </FilterBar>
      <div className="sys-pad">
        {logs.isError ? (
          <ErrorBlock title={t('system.logs.couldntLoadLogs')} onRetry={() => void logs.refetch()} />
        ) : logs.isPending ? (
          <Skeleton lines={6} />
        ) : lines.length === 0 ? (
          <EmptyState title={t('system.logs.noLogEntries')}>{level || search ? t('system.logs.nothingMatchesTheseFilters') : t('system.logs.theInMemoryLogIs')}</EmptyState>
        ) : (
          <pre className="dbg-pre dbg-pre--logs" data-testid="debug-logs">
            {text}
          </pre>
        )}
      </div>
    </Pane>
  );
}

/** System → Debugging: live process snapshot, the read-only diagnostic console and recent logs. */
export function SystemDebuggingPage() {
  const [results, setResults] = useState<DebugCommandResult[]>([]);
  const copy = useCopy();
  const report = useMutation({
    mutationFn: () => debugApi.run('report'),
    meta: { errorTitle: t('system.debugging.couldntBuildTheReport') },
    onSuccess: async (res) => {
      setResults(res.results);
      const r = res.results[0];
      if (r) await copy(r.output, t('system.debugging.debugReport'));
    },
  });
  return (
    <>
      <SystemHeader
        title={t('nav.debugging')}
        subtitle={t('system.debugging.subtitle')}
        actions={
          <Button variant="primary" icon={<Icon name="copy" />} loading={report.isPending} onClick={() => report.mutate()}>
            {t('system.debugging.copyDebugReport')}
          </Button>
        }
      />
      <div className="dbg-page">
        <SnapshotPane />
        <ConsolePane results={results} setResults={setResults} />
        <LogsPane />
      </div>
    </>
  );
}
