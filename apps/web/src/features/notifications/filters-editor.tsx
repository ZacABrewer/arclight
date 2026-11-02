import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NotificationFilters, NotificationMediaType } from '@arclight/shared';
import { usersApi } from '../../api/auth.js';
import { authKeys } from '../../auth/guard.js';
import { Checkbox, Field } from '../../arclight/index.js';
import { TermList } from '../../components/forms/term-list.js';
import { t } from '../../i18n/index.js';
import { MEDIA_TYPES, mediaTypeLabel } from './labels.js';
import './notifications.css';

export const EMPTY_FILTERS: NotificationFilters = { mediaTypes: [], qualities: [], users: [] };

/** A connection's filters, tolerating rows saved before filters existed. */
export function filtersOf(source: unknown): NotificationFilters {
  const f = (source && typeof source === 'object' ? source : {}) as Partial<NotificationFilters>;
  return {
    mediaTypes: Array.isArray(f.mediaTypes) ? f.mediaTypes : [],
    qualities: Array.isArray(f.qualities) ? f.qualities : [],
    users: Array.isArray(f.users) ? f.users : [],
  };
}

function toggle<T>(list: readonly T[], item: T, on: boolean): T[] {
  return on ? (list.includes(item) ? [...list] : [...list, item]) : list.filter((x) => x !== item);
}

/** Users the request/issue filter can pick: the user list, plus ids it no longer has. */
function UserFilter({ value, onChange }: { value: readonly number[]; onChange: (next: number[]) => void }) {
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list, retry: false, staleTime: 60_000 });
  if (users.isPending) return <span className="al-caption">{t('notify.filters.loadingUsers')}</span>;
  const known = users.data ?? [];
  const missing = value.filter((id) => !known.some((u) => u.id === id));
  const entries = [...known.map((u) => ({ id: u.id, label: u.displayName || u.username })), ...missing.map((id) => ({ id, label: t('notify.filters.userId', { id }) }))];
  if (entries.length === 0) return <span className="al-caption">{t('notify.filters.noUsers')}</span>;
  return (
    <div className="al-tag-toggles">
      {entries.map((u) => {
        const on = value.includes(u.id);
        return (
          <button key={u.id} type="button" className="al-tag al-tag-toggle" aria-pressed={on} onClick={() => onChange(toggle(value, u.id, !on))}>
            {u.label}
          </button>
        );
      })}
    </div>
  );
}

/** Media kind, quality and user filters on top of a connection's event flags. */
export function FiltersEditor({ value, onChange }: { value: NotificationFilters; onChange: (next: NotificationFilters) => void }) {
  const id = useId();
  return (
    <div className="al-notify-section">
      <p className="al-caption">{t('notify.filters.intro')}</p>
      <fieldset className="al-event-flags">
        <legend className="al-label">{t('notify.filters.mediaTypes')}</legend>
        <div className="al-check-grid">
          {MEDIA_TYPES.map((type: NotificationMediaType) => (
            <Checkbox
              key={type}
              label={mediaTypeLabel(type)}
              checked={value.mediaTypes.includes(type)}
              onChange={(e) => onChange({ ...value, mediaTypes: toggle(value.mediaTypes, type, e.currentTarget.checked) })}
            />
          ))}
        </div>
        <p className="al-caption">{t('notify.filters.mediaTypesHint')}</p>
      </fieldset>
      <Field label={t('notify.filters.qualities')} hint={t('notify.filters.qualitiesHint')} htmlFor={`${id}-q`}>
        <TermList id={`${id}-q`} value={value.qualities} onChange={(qualities) => onChange({ ...value, qualities: qualities.slice(0, 100) })} placeholder={t('notify.filters.qualityPlaceholder')} />
      </Field>
      <fieldset className="al-event-flags">
        <legend className="al-label">{t('notify.filters.users')}</legend>
        <UserFilter value={value.users} onChange={(users) => onChange({ ...value, users })} />
        <p className="al-caption">{t('notify.filters.usersHint')}</p>
      </fieldset>
    </div>
  );
}
