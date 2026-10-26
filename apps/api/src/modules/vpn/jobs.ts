import type { Scheduler } from '../../scheduler.js';
import type { VpnService } from './service.js';

export const VPN_STATUS_JOB = 'VpnStatusCheck';

// Every minute; returns at once when the VPN is disabled or the poll interval has not passed.
export function registerVpnJobs(scheduler: Scheduler, service: VpnService): void {
  scheduler.register({ name: VPN_STATUS_JOB, cron: '* * * * *', handler: () => service.refreshIfDue() });
}
