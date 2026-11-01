import type { ReactNode } from 'react';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { isNative } from '../platform/capacitor.js';

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg className={small ? 'mark small' : 'mark'} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id="arclight-g" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#2f7bff" />
          <stop offset="1" stopColor="#6ef6ff" />
        </linearGradient>
      </defs>
      <path d="M48,22 L76,50 L48,78" fill="none" stroke="url(#arclight-g)" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" opacity=".45" />
      <path d="M24,22 L52,50 L24,78" fill="none" stroke="url(#arclight-g)" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  back: 'M15 5l-7 7 7 7',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.3 2.5h4l.4-2.5c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4z',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  trash: 'M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
} as const;

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function TopBar({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="topbar">
      {onBack ? (
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      ) : (
        <Mark small />
      )}
      <h1>{title}</h1>
      {right}
    </header>
  );
}

export function Notice({ kind, children }: { kind: 'error' | 'warn' | 'ok'; children: ReactNode }) {
  return (
    <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export const haptic = {
  tap: () => (isNative() ? Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined) : undefined),
  success: () => (isNative() ? Haptics.notification({ type: NotificationType.Success }).catch(() => undefined) : undefined),
  error: () => (isNative() ? Haptics.notification({ type: NotificationType.Error }).catch(() => undefined) : undefined),
};
