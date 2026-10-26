import type { ReleaseProtocol } from '@arclight/shared';
import { ProtocolBadge as KitProtocolBadge } from '../arclight/index.js';

/** Square mono "TOR" / "NZB" badge (Arclight `.al-proto`), used by the queue, search and download clients. */
export function ProtocolBadge({ protocol }: { protocol: ReleaseProtocol }) {
  return <KitProtocolBadge protocol={protocol} />;
}
