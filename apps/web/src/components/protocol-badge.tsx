import type { ReleaseProtocol } from '@media-tron/shared';
import { Badge, type BadgeTone } from './badge.js';

const PROTOCOL_TONES: Record<ReleaseProtocol, BadgeTone> = { usenet: 'info', torrent: 'ok' };

/** Small "usenet" / "torrent" chip used by the queue and the download client settings. */
export function ProtocolBadge({ protocol }: { protocol: ReleaseProtocol }) {
  return <Badge tone={PROTOCOL_TONES[protocol]}>{protocol}</Badge>;
}
