import { useQuery } from '@tanstack/react-query';
import type { HealthResponse, RequestCount, VpnStatus } from '@arclight/shared';
import type { ConnectionState } from '../api/events.js';
import { healthApi } from '../api/health.js';
import { issuesApi } from '../api/requests.js';
import { vpnApi } from '../api/vpn.js';
import { queryKeys } from '../hooks/query-keys.js';
import { useRequestCount } from '../hooks/requests.js';
import { requestKeys } from '../hooks/request-keys.js';
import { vpnKeys } from '../hooks/vpn.js';
import { useConnection } from '../lib/connection.js';

// The top bar's plain-text status cluster: live dot + "Connected" / "Reconnecting…", VPN
// location, pending requests (admins) and issues (orange when > 0). Pure part first so the
// states can be tested without a network.

export interface StatusClusterInput {
  connection: ConnectionState;
  isAdmin: boolean;
  /** undefined while loading or when the caller may not read it. */
  vpn?: VpnStatus | undefined;
  requests?: RequestCount | undefined;
  health?: HealthResponse | undefined;
  /** Open user-reported issues (shown to role user instead of health issues). */
  openIssues?: number | undefined;
}

export interface StatusCluster {
  connected: boolean;
  disconnectedLabel: string;
  /** "Amsterdam" → "VPN Amsterdam"; null → "VPN off"; undefined → hidden. */
  vpnLocation: string | null | undefined;
  requestCount: number | undefined;
  issueCount: number | undefined;
  /** Where the issue count links to. */
  issuesHref: '/system/health' | '/issues';
}

/** Where the VPN exits, for the top bar. Country first (the kit shows a place name). */
export function vpnLocationOf(vpn: VpnStatus | undefined): string | null | undefined {
  if (!vpn) return undefined;
  if (!vpn.enabled) return null;
  if (!vpn.connected) return 'down';
  return vpn.country ?? vpn.city ?? vpn.region ?? 'on';
}

/** Health checks that need attention (warnings and errors). */
export function healthIssueCount(health: HealthResponse | undefined): number | undefined {
  return health ? health.checks.filter((c) => c.status !== 'ok').length : undefined;
}

export function statusCluster(input: StatusClusterInput): StatusCluster {
  return {
    connected: input.connection === 'open',
    disconnectedLabel: input.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…',
    vpnLocation: input.isAdmin ? vpnLocationOf(input.vpn) : undefined,
    requestCount: input.isAdmin ? input.requests?.pending : undefined,
    issueCount: input.isAdmin ? healthIssueCount(input.health) : input.openIssues,
    issuesHref: input.isAdmin ? '/system/health' : '/issues',
  };
}

/** Live status cluster for the signed-in role. Admin-only endpoints are not called for users. */
export function useStatusCluster(isAdmin: boolean): StatusCluster {
  const { state } = useConnection();
  // Same keys as hooks/vpn and hooks/system, so live events and pages share the cache.
  const vpn = useQuery({ queryKey: vpnKeys.status, queryFn: vpnApi.status, retry: false, enabled: isAdmin });
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get, refetchInterval: 5 * 60_000, retry: false, enabled: isAdmin });
  const requests = useRequestCount(isAdmin);
  const issues = useQuery({ queryKey: requestKeys.issues.count, queryFn: issuesApi.count, retry: false, enabled: !isAdmin });
  return statusCluster({
    connection: state,
    isAdmin,
    vpn: vpn.data,
    requests: requests.data,
    health: health.data,
    openIssues: issues.data?.open,
  });
}
