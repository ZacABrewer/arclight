import type { BuiltinCategoryPath } from '@media-tron/shared';
import { Button } from '../../../components/button.js';
import { Input } from '../../../components/form.js';
import type { FieldRendererProps } from '../../../components/forms/types.js';

// Editor for the Built-in client's `settings.categories`: an array of {name, savePath} rows.
// The schema serves it as a 'text' field whose value is the array, so it needs its own control.

/** Whatever the form holds -> an array of rows (tolerates a missing or malformed value). */
export function toCategoryRows(value: unknown): BuiltinCategoryPath[] {
  if (!Array.isArray(value)) return [];
  return value.map((row: unknown) => {
    const r = (row !== null && typeof row === 'object' ? row : {}) as Partial<Record<keyof BuiltinCategoryPath, unknown>>;
    return { name: typeof r.name === 'string' ? r.name : '', savePath: typeof r.savePath === 'string' ? r.savePath : '' };
  });
}

/** Save body: trimmed rows, fully empty rows dropped. */
export function cleanCategories(value: unknown): BuiltinCategoryPath[] {
  return toCategoryRows(value)
    .map((r) => ({ name: r.name.trim(), savePath: r.savePath.trim() }))
    .filter((r) => r.name !== '' || r.savePath !== '');
}

export function CategoriesEditor({ id, value, onChange }: FieldRendererProps) {
  const rows = toCategoryRows(value);
  const update = (i: number, patch: Partial<BuiltinCategoryPath>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div id={id} className="stack-sm" role="group" aria-label="Category folders">
      {rows.length === 0 ? <p className="field-hint">No per-category folders.</p> : null}
      {rows.map((row, i) => (
        <div key={i} className="chip-stack">
          <Input aria-label={`Category ${i + 1} name`} placeholder="category" value={row.name} onChange={(e) => update(i, { name: e.currentTarget.value })} />
          <Input
            aria-label={`Category ${i + 1} save path`}
            placeholder="/downloads/category"
            value={row.savePath}
            onChange={(e) => update(i, { savePath: e.currentTarget.value })}
          />
          <Button size="sm" variant="ghost" aria-label={`Remove category ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => onChange([...rows, { name: '', savePath: '' }])}>
          Add category
        </Button>
      </div>
    </div>
  );
}

export const categoriesRenderer = (props: FieldRendererProps) => <CategoriesEditor {...props} />;
