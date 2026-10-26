import { useState, type DragEvent } from 'react';
import { qualityById, type QualityProfileItem } from '@media-tron/shared';
import { Button } from '../../../components/button.js';
import { Input } from '../../../components/form.js';
import { cx } from '../../../lib/cx.js';
import { groupItems, itemId, itemName, moveItem, setAllowed, ungroupItem } from './quality-profile-model.js';

export interface QualityItemListProps {
  /** Display order: best first. */
  items: readonly QualityProfileItem[];
  onChange: (items: QualityProfileItem[]) => void;
}

/** Orderable list of qualities/groups: drag rows or use the arrows; tick to allow; group/ungroup. */
export function QualityItemList({ items, onChange }: QualityItemListProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [groupName, setGroupName] = useState('');

  const update = (next: QualityProfileItem[]) => {
    setSelected([]);
    onChange(next);
  };

  const onDragStart = (index: number) => (e: DragEvent) => {
    setDragFrom(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };
  const onDrop = (index: number) => (e: DragEvent) => {
    e.preventDefault();
    const from = dragFrom ?? Number(e.dataTransfer.getData('text/plain'));
    if (Number.isInteger(from) && from !== index) update(moveItem(items, from, index));
    setDragFrom(null);
    setDragOver(null);
  };

  const canGroup = selected.length >= 2 && groupName.trim() !== '';

  return (
    <div className="quality-items">
      <p className="field-hint">Best first. Drag to reorder (or use the arrows); tick to allow. Members of a group rank equal.</p>
      <ol className="quality-item-list" aria-label="Qualities">
        {items.map((item, index) => {
          const name = itemName(item);
          return (
            <li
              key={`${item.kind}-${itemId(item)}`}
              className={cx('quality-item', !item.allowed && 'quality-item-off', dragOver === index && 'quality-item-over')}
              draggable
              onDragStart={onDragStart(index)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(index);
              }}
              onDragLeave={() => setDragOver((v) => (v === index ? null : v))}
              onDrop={onDrop(index)}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              data-testid="quality-item"
            >
              <span className="drag-handle" aria-hidden="true">
                ⋮⋮
              </span>
              <input
                type="checkbox"
                aria-label={`Select ${name} for grouping`}
                checked={selected.includes(index)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setSelected((s) => (on ? [...s, index] : s.filter((i) => i !== index)));
                }}
              />
              <label className="quality-item-name">
                <input
                  type="checkbox"
                  aria-label={`Allow ${name}`}
                  checked={item.allowed}
                  onChange={(e) => update(setAllowed(items, index, e.currentTarget.checked))}
                />
                <span>{name}</span>
                {item.kind === 'group' ? (
                  <span className="muted quality-item-members">{item.qualityIds.map((q) => qualityById(q).name).join(', ')}</span>
                ) : null}
              </label>
              <span className="quality-item-actions">
                {item.kind === 'group' ? (
                  <Button size="sm" variant="ghost" onClick={() => update(ungroupItem(items, index))}>
                    Ungroup
                  </Button>
                ) : null}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Move ${name} up`}
                  disabled={index === 0}
                  onClick={() => update(moveItem(items, index, index - 1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Move ${name} down`}
                  disabled={index === items.length - 1}
                  onClick={() => update(moveItem(items, index, index + 1))}
                >
                  ↓
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="row">
        <Input
          aria-label="New group name"
          placeholder="Group name"
          value={groupName}
          onChange={(e) => setGroupName(e.currentTarget.value)}
        />
        <Button
          size="sm"
          disabled={!canGroup}
          onClick={() => {
            update(groupItems(items, selected, groupName));
            setGroupName('');
          }}
        >
          Group selected ({selected.length})
        </Button>
      </div>
    </div>
  );
}
