import { useState } from 'react';
import { useCreateTag, useTags } from '../../hooks/library.js';
import { Button, Checkbox, Input } from '../../arclight/index.js';
import './media-kit.css';
import { t } from '../../i18n/index.js';

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
      <div className="mk-row" role="group" aria-label={t('common.tags')}>
        {(tags.data ?? []).map((item) => (
          <Checkbox key={item.id} label={item.label} checked={value.includes(item.id)} onChange={() => toggle(item.id)} />
        ))}
        {tags.data?.length === 0 ? <span className="mk-muted">{t('components.media.tagPicker.noTagsYet')}</span> : null}
      </div>
      <div className="mk-row" style={{ flexWrap: 'nowrap' }}>
        <Input
          aria-label={t('components.media.tagPicker.newTag')}
          placeholder={t('components.media.tagPicker.newTag')}
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
          {t('components.media.tagPicker.addTag')}
        </Button>
      </div>
    </div>
  );
}
