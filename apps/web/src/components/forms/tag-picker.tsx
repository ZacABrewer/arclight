import { useQuery } from '@tanstack/react-query';
import { libraryApi } from '../../api/library.js';
import type { FieldRendererProps } from './types.js';
import { t } from '../../i18n/index.js';

// Query key matches libraryKeys.library.tags so the library pages share the cache.
const TAGS_KEY = ['library', 'tags'] as const;

export interface TagPickerProps {
  id?: string;
  value: readonly number[];
  onChange: (ids: number[]) => void;
}

/** Toggle tags for every known tag. Empty selection means "applies to everything". */
export function TagPicker({ id, value, onChange }: TagPickerProps) {
  const tags = useQuery({ queryKey: TAGS_KEY, queryFn: libraryApi.tags.list, staleTime: 60_000 });
  if (tags.isPending) return <span className="al-caption">{t('components.forms.tagPicker.loadingTags')}</span>;
  if (tags.isError || tags.data.length === 0) {
    return (
      <span id={id} className="al-caption">
        {t('components.forms.tagPicker.noTagsYet')}
      </span>
    );
  }
  return (
    <div id={id} className="al-tag-toggles" role="group" aria-label={t('common.tags')}>
      {tags.data.map((item) => {
        const on = value.includes(item.id);
        return (
          <button
            key={item.id}
            type="button"
            className="al-tag al-tag-toggle"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== item.id) : [...value, item.id])}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** Schema-form renderer for a `tags` field (the api describes it as text; it holds ids). */
export function tagRenderer({ id, value, onChange }: FieldRendererProps) {
  const ids = Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
  return <TagPicker id={id} value={ids} onChange={onChange} />;
}

/** Labels for tag ids, for read-only display on cards. */
export function useTagLabels(): (ids: readonly number[]) => string[] {
  const tags = useQuery({ queryKey: TAGS_KEY, queryFn: libraryApi.tags.list, staleTime: 60_000 });
  return (ids) => ids.map((id) => tags.data?.find((entry) => entry.id === id)?.label ?? `#${id}`);
}
