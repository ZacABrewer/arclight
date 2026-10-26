import { useState } from 'react';
import { useCreateTag, useTags } from '../../hooks/library.js';
import { Button, Checkbox, Input } from '../../arclight/index.js';
import './media-kit.css';

/** Checkbox list of existing tags plus an inline "New tag" field. */
export function TagPicker({ value, onChange }: { value: readonly number[]; onChange: (ids: number[]) => void }) {
  const tags = useTags();
  const create = useCreateTag();
  const [label, setLabel] = useState('');

  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  const add = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    create.mutate(trimmed, {
      onSuccess: (tag) => {
        onChange([...value, tag.id]);
        setLabel('');
      },
    });
  };

  return (
    <div className="mk-stack-sm">
      <div className="mk-row" role="group" aria-label="Tags">
        {(tags.data ?? []).map((t) => (
          <Checkbox key={t.id} label={t.label} checked={value.includes(t.id)} onChange={() => toggle(t.id)} />
        ))}
        {tags.data?.length === 0 ? <span className="mk-muted">No tags yet</span> : null}
      </div>
      <div className="mk-row" style={{ flexWrap: 'nowrap' }}>
        <Input
          aria-label="New tag"
          placeholder="New tag"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" onClick={add} loading={create.isPending} disabled={!label.trim()}>
          Add tag
        </Button>
      </div>
    </div>
  );
}
