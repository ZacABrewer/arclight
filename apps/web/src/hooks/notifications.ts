import { useQuery } from '@tanstack/react-query';
import type { NotificationPreviewRequest } from '@arclight/shared';
import { notificationsApi, personalDestinationsApi, type PersonalDestinationBody } from '../api/notifications.js';
import { settingsKeys, useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Delivery logs, the template editor helpers and personal destinations. Connection deliveries
// sit under the notification list key so a save or a `settings` event refreshes them too.
export const notificationKeys = {
  deliveries: (id: number) => [...settingsKeys.notifications, 'deliveries', id] as const,
  templateMeta: ['notification-templates'] as const,
  preview: (body: NotificationPreviewRequest) => ['notification-preview', body] as const,
  personalAll: (userId: number) => ['notification-destinations', userId] as const,
  personalOptions: (userId: number) => ['notification-destinations', userId, 'options'] as const,
  personalList: (userId: number) => ['notification-destinations', userId, 'list'] as const,
  personalDeliveries: (userId: number, id: number) => ['notification-destinations', userId, 'deliveries', id] as const,
};

export function useNotificationDeliveries(id: number | null) {
  return useQuery({
    queryKey: notificationKeys.deliveries(id ?? 0),
    queryFn: () => notificationsApi.deliveries(id!),
    enabled: id !== null,
    retry: false,
  });
}

export function useNotificationTemplateMeta() {
  return useQuery({ queryKey: notificationKeys.templateMeta, queryFn: notificationsApi.templateMeta, retry: false, staleTime: Infinity });
}

/** Live preview of a template; idle while `body` is null. Keeps the last result while typing. */
export function useNotificationPreview(body: NotificationPreviewRequest | null) {
  return useQuery({
    queryKey: notificationKeys.preview(body ?? { eventType: '' }),
    queryFn: () => notificationsApi.preview(body!),
    enabled: body !== null,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

export function usePersonalDestinationOptions(userId: number) {
  return useQuery({ queryKey: notificationKeys.personalOptions(userId), queryFn: () => personalDestinationsApi.options(userId), retry: false });
}

export function usePersonalDestinations(userId: number) {
  return useQuery({ queryKey: notificationKeys.personalList(userId), queryFn: () => personalDestinationsApi.list(userId), retry: false });
}

export function usePersonalDestinationDeliveries(userId: number, id: number | null) {
  return useQuery({
    queryKey: notificationKeys.personalDeliveries(userId, id ?? 0),
    queryFn: () => personalDestinationsApi.deliveries(userId, id!),
    enabled: id !== null,
    retry: false,
  });
}

export function useSavePersonalDestination(userId: number) {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: PersonalDestinationBody }) =>
      id ? personalDestinationsApi.update(userId, id, body) : personalDestinationsApi.create(userId, body),
    [notificationKeys.personalAll(userId)],
    { silent: true },
  );
}

export function useDeletePersonalDestination(userId: number) {
  return useInvalidatingMutation((id: number) => personalDestinationsApi.remove(userId, id), [notificationKeys.personalAll(userId)], {
    errorTitle: t('notify.personal.couldNotDelete'),
  });
}
