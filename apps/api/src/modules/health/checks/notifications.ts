import { finding, type HealthCheckDef } from '../types.js';

/** Enabled connections whose stored settings no longer validate. */
export const notificationConfigCheck: HealthCheckDef = {
  id: 'NotificationConfigCheck',
  async run(deps) {
    const bad = deps.notifications.misconfigured();
    if (bad.length === 0) return [];
    return [
      finding(
        this.id,
        'warning',
        `Notifications misconfigured: ${bad.map((b) => b.name).join(', ')}. Edit and save them to fix their settings`,
        'notifications-misconfigured',
      ),
    ];
  },
};

/** Connections whose last delivery failed ("all vs some" over enabled connections). */
export const notificationStatusCheck: HealthCheckDef = {
  id: 'NotificationStatusCheck',
  async run(deps) {
    const enabled = deps.notifications.enabled();
    const failing = enabled.filter((n) => n.consecutiveFailures > 0);
    if (failing.length === 0) return [];
    if (failing.length === enabled.length) {
      return [
        finding(this.id, 'error', 'All notifications are unavailable due to failures', 'notifications-are-unavailable-due-to-failures'),
      ];
    }
    return [
      finding(
        this.id,
        'warning',
        `Notifications unavailable due to failures: ${failing.map((n) => n.name).join(', ')}`,
        'notifications-are-unavailable-due-to-failures',
      ),
    ];
  },
};
