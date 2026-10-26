import type { z } from 'zod';
import { HealthResponse, Job, ScheduledJob, SystemStatus, ServerEvent } from '@media-tron/shared';

// Every call parses the response against the shared schema, so a contract drift between
// api and web fails loudly in dev instead of rendering undefined.
async function get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  const res = await fetch(`/api/v1${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return schema.parse(await res.json());
}

export const api = {
  systemStatus: () => get('/system/status', SystemStatus),
  health: () => get('/health', HealthResponse),
  jobs: () => get('/jobs', Job.array()),
  scheduledJobs: () => get('/jobs/scheduled', ScheduledJob.array()),
  runJob: async (name: string) => {
    const res = await fetch('/api/v1/jobs/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return Job.parse(await res.json());
  },
};

export function connectEvents(onEvent: (event: ServerEvent) => void): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let socket: WebSocket | null = null;
  let closed = false;

  const open = () => {
    socket = new WebSocket(`${proto}://${location.host}/api/v1/events`);
    socket.onmessage = (msg) => {
      const parsed = ServerEvent.safeParse(JSON.parse(String(msg.data)));
      if (parsed.success) onEvent(parsed.data);
    };
    socket.onclose = () => {
      if (!closed) setTimeout(open, 2000);
    };
  };
  open();

  return () => {
    closed = true;
    socket?.close();
  };
}
