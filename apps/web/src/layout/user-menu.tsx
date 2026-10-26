import type { ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import type { Session, User } from '@arclight/shared';
import { Menu, type MenuItem } from '../arclight/index.js';
import { displayNameOf, useAuth } from '../auth/auth-context.js';
import { t } from '../i18n/index.js';

/** Two-letter avatar initials: "Sam Kade" → "SK", "admin" → "AD". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

function roleLine(user: User | null, session: Session): string {
  if (user) return user.role === 'admin' ? t('common.admin') : t('common.user');
  if (session.via === 'bypass') return t('layout.userMenu.noSignInNeeded');
  if (session.via === 'apikey') return t('common.apiKey');
  return t('layout.userMenu.signedIn');
}

export interface UserMenuModel {
  initials: string;
  label: string;
  menu: ((close: () => void) => ReactNode) | undefined;
}

/** Avatar initials, accessible name and menu (profile, security, shortcuts, sign out). */
export function useUserMenu(onShortcuts: () => void): UserMenuModel {
  const { session, user, isAdmin, logout } = useAuth();
  const router = useRouter();
  if (!session) return { initials: '?', label: t('common.account'), menu: undefined };
  const name = displayNameOf(user, session);

  const items: MenuItem[] = [];
  if (user) items.push({ id: 'profile', label: t('layout.userMenu.profileAndNotifications'), onSelect: () => void router.navigate({ to: '/profile' }) });
  if (isAdmin) items.push({ id: 'security', label: t('layout.userMenu.securitySettings'), onSelect: () => void router.navigate({ to: '/settings/security' }) });
  items.push({ id: 'shortcuts', label: t('common.keyboardShortcuts'), onSelect: onShortcuts });
  if (isAdmin) items.push({ id: 'design', label: t('layout.userMenu.designSystem'), onSelect: () => void router.navigate({ to: '/design' }) });
  if (session.via === 'session') {
    items.push({
      id: 'signout',
      label: t('layout.userMenu.signOut'),
      separatorBefore: true,
      onSelect: () =>
        void (async () => {
          await logout();
          await router.navigate({ to: '/login', replace: true });
        })(),
    });
  }

  return {
    initials: initialsOf(name),
    label: t('layout.userMenu.accountName', { name }),
    menu: (close) => (
      <Menu
        header={
          <>
            <strong>{name}</strong> · {roleLine(user, session)}
          </>
        }
        items={items}
        onDone={close}
      />
    ),
  };
}
