import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Job } from '@media-tron/shared';
import { api, connectEvents } from './api.js';

// Phase 0 dashboard: proves the api, the contract, the scheduler and the live feed all
// work end to end. Real pages replace this in Phase 1; the Tron theme is Phase 5.
export function App() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['system'], queryFn: api.systemStatus, refetchInterval: 30_000 });
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs });
  const scheduled = useQuery({ queryKey: ['jobs', 'scheduled'], queryFn: api.scheduledJobs });
  const run = useMutation({ mutationFn: api.runJob });

  useEffect(
    () =>
      connectEvents((event) => {
        if (event.type === 'job') {
          qc.setQueryData<Job[]>(['jobs'], (prev = []) => {
            const rest = prev.filter((j) => j.id !== event.job.id);
            return [event.job, ...rest].slice(0, 50);
          });
          if (event.job.status !== 'running') void qc.invalidateQueries({ queryKey: ['jobs', 'scheduled'] });
        }
        if (event.type === 'health') qc.setQueryData(['health'], event.health);
      }),
    [qc],
  );

  return (
    <main>
      <header>
        <h1>Media-Tron</h1>
        <span className="muted">
          {status.data ? `v${status.data.version} · up ${formatUptime(status.data.uptimeSeconds)}` : 'connecting…'}
        </span>
      </header>

      <section>
        <h2>
          Health <Badge tone={health.data?.status ?? 'ok'}>{health.data?.status ?? '…'}</Badge>
        </h2>
        {health.data && health.data.checks.length === 0 ? (
          <p className="muted">No issues.</p>
        ) : (
          <ul>
            {health.data?.checks.map((c) => (
              <li key={c.source}>
                <strong>{c.source}</strong>: {c.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Scheduled jobs</h2>
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Interval</th>
              <th>Last run</th>
              <th>Next run</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {scheduled.data?.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td>
                  <code>{s.interval}</code>
                </td>
                <td>{s.lastRun ? relative(s.lastRun) : '—'}</td>
                <td>{s.nextRun ? relative(s.nextRun) : '—'}</td>
                <td>
                  <button onClick={() => run.mutate(s.name)} disabled={run.isPending}>
                    Run now
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Recent runs</h2>
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Duration</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {jobs.data?.map((j) => (
              <tr key={j.id}>
                <td>{j.name}</td>
                <td>
                  <Badge tone={j.status}>{j.status}</Badge>
                </td>
                <td>{j.trigger}</td>
                <td>{j.durationMs == null ? '—' : `${j.durationMs} ms`}</td>
                <td className="muted">{j.message ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function relative(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const unit = abs < 60 ? [abs, 's'] : abs < 3600 ? [abs / 60, 'm'] : [abs / 3600, 'h'];
  const text = `${Math.round(unit[0] as number)}${unit[1]}`;
  return diff < 0 ? `${text} ago` : `in ${text}`;
}
