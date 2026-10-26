import { useConnection } from '../lib/connection.js';

const LABELS = { open: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting' } as const;

/** Dot + label driven by the WebSocket feed state. */
export function ConnectionIndicator() {
  const { state, retryInMs, connectedAt } = useConnection();
  const title =
    state === 'open'
      ? `Live updates connected${connectedAt ? ` since ${new Date(connectedAt).toLocaleTimeString()}` : ''}`
      : state === 'reconnecting' && retryInMs != null
        ? `Connection lost; retrying in ${Math.ceil(retryInMs / 1000)}s`
        : 'Connecting to live updates';
  return (
    <span className={`conn conn-${state}`} title={title} role="status" aria-live="polite">
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-label">{LABELS[state]}</span>
    </span>
  );
}
