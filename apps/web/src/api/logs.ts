import { LogFile, LogPage, LogRecord, type LogQueryInput } from '@media-tron/shared';
import { API_BASE, request, type QueryParams } from './client.js';
import { backoffDelay } from './events.js';

// Paths mirror apps/api/src/modules/logs/routes.ts.

export const logsApi = {
  list: (query: Partial<LogQueryInput>) => request('/log', LogPage, { query: query as QueryParams }),
  files: () => request('/log/file', LogFile.array()),
  clear: () => request('/log', null, { method: 'DELETE' }),
  fileUrl: (name: string) => `${API_BASE}/log/file/${encodeURIComponent(name)}`,
};

export function logStreamUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc.host}${API_BASE}/log/stream`;
}

/** Opens the live log WebSocket, reconnecting with backoff. Returns a disposer. */
export function connectLogStream(onRecord: (record: LogRecord) => void, onOpenChange?: (open: boolean) => void): () => void {
  let socket: WebSocket | null = null;
  let disposed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    socket = new WebSocket(logStreamUrl());
    socket.onopen = () => {
      attempt = 0;
      onOpenChange?.(true);
    };
    socket.onmessage = (msg: MessageEvent) => {
      try {
        const parsed = LogRecord.safeParse(JSON.parse(String(msg.data)));
        if (parsed.success) onRecord(parsed.data);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      onOpenChange?.(false);
      if (disposed) return;
      attempt += 1;
      timer = setTimeout(open, backoffDelay(attempt));
    };
  };
  open();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
