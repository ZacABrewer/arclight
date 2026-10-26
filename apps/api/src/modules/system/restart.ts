import type { AppContext } from '../../app.js';

// Process-wide "restart required" flag. Kept per context (not on AppContext itself) so any
// module can raise it and the system module can report it in /system/status.

interface RestartState {
  required: boolean;
  reasons: string[];
}

const states = new WeakMap<AppContext, RestartState>();

function stateOf(ctx: AppContext): RestartState {
  let s = states.get(ctx);
  if (!s) {
    s = { required: false, reasons: [] };
    states.set(ctx, s);
  }
  return s;
}

/** Marks that the running process holds stale state; the UI shows a restart banner. */
export function requestRestart(ctx: AppContext, reason: string): void {
  const s = stateOf(ctx);
  s.required = true;
  if (!s.reasons.includes(reason)) s.reasons.push(reason);
  ctx.log.warn({ reason }, 'restart required');
}

export function isRestartRequired(ctx: AppContext): boolean {
  return states.get(ctx)?.required ?? false;
}

export function restartReasons(ctx: AppContext): readonly string[] {
  return states.get(ctx)?.reasons ?? [];
}
