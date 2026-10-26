import { useQuery } from '@tanstack/react-query';
import { libraryApi } from '../../api/library.js';
import type { FieldRendererProps } from './types.js';

// Query key matches libraryKeys.library.tags so the library pages share the cache.
const TAGS_KEY = ['library', 'tags'] as const;

export interface TagPickerProps {
  id?: string;
  value: readonly number[];
  onChange: (ids: number[]) => void;
}

/** Toggle chips for every known tag. Empty selection means "applies to everything". */
export function TagPicker({ id, value, onChange }: TagPickerProps) {
  const tags = useQuery({ queryKey: TAGS_KEY, queryFn: libraryApi.tags.list, staleTime: 60_000 });
  if (tags.isPending) return <span className="muted">Loading tags…</span>;
  if (tags.isError || tags.data.length === 0) {
    return (
      <span id={id} className="muted">
        No tags defined yet.
      </span>
    );
  }
  return (
    <div id={id} className="chip-group" role="group" aria-label="Tags">
      {tags.data.map((t) => {
        const on = value.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            className={`chip ${on ? 'chip-on' : ''}`}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== t.id) : [...value, t.id])}
          >
            {t.label}
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
  return (ids) => ids.map((id) => tags.data?.find((t) => t.id === id)?.label ?? `#${id}`);
}
