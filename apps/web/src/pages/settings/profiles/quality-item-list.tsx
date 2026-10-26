import { useState, type DragEvent } from 'react';
import { qualityById, type QualityProfileItem } from '@arclight/shared';
import { Button, Checkbox, Input, Toggle, cx } from '../../../arclight/index.js';
import { groupItems, itemId, itemName, moveItem, setAllowed, ungroupItem } from './quality-profile-model.js';
import './profiles.css';
import { t } from '../../../i18n/index.js';

export interface QualityItemListProps {
  /** Display order: best first. */
  items: readonly QualityProfileItem[];
  onChange: (items: QualityProfileItem[]) => void;
  /** Id of the cutoff quality or group; that row carries the CUTOFF marker. */
  cutoff?: number | undefined;
}

/**
 * Orderable list of qualities and groups: drag a row (⋮⋮) or use the move buttons; tick to
 * allow. "Group qualities" reveals selection boxes to merge rows into one equal-rank group.
 */
export function QualityItemList({ items, onChange, cutoff }: QualityItemListProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [grouping, setGrouping] = useState(false);
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
    <div className="al-qlist">
      <div className="al-qlist__bar">
        <p className="al-caption al-qlist__hint">{t('settings.profiles.qualityItemList.bestFirstDragToReorder')}</p>
        <Toggle
          size="sm"
          label={t('settings.profiles.qualityItemList.groupQualities')}
          checked={grouping}
          onChange={(e) => {
            setGrouping(e.currentTarget.checked);
            setSelected([]);
          }}
        />
      </div>
      <ol className="al-qlist__rows" aria-label={t('settings.profiles.qualityItemList.qualities')}>
        {items.map((item, index) => {
          const name = itemName(item);
          const isCutoff = cutoff !== undefined && itemId(item) === cutoff;
          return (
            <li
              key={`${item.kind}-${itemId(item)}`}
              className={cx('al-qlist__row', !item.allowed && 'is-off', dragOver === index && 'is-over', isCutoff && 'is-cutoff')}
              data-cutoff={isCutoff || undefined}
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
              <span className="al-qlist__handle" aria-hidden="true">
                ⋮⋮
              </span>
              {grouping ? (
                <Checkbox
                  aria-label={t('settings.profiles.qualityItemList.selectNameForGrouping', { name })}
                  checked={selected.includes(index)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setSelected((s) => (on ? [...s, index] : s.filter((i) => i !== index)));
                  }}
                />
              ) : null}
              <span className="al-qlist__name">
                <Checkbox aria-label={t('settings.profiles.qualityItemList.allowName', { name })} checked={item.allowed} onChange={(e) => update(setAllowed(items, index, e.currentTarget.checked))} />
                <span className="al-num">{name}</span>
                {item.kind === 'group' ? (
                  <span className="al-qlist__members">{item.qualityIds.map((q) => qualityById(q).name).join(', ')}</span>
                ) : null}
              </span>
              {isCutoff ? (
                <span className="al-qlist__cutoff" data-testid="cutoff-marker">
                  {t('settings.profiles.qualityItemList.cutoff')}
                </span>
              ) : null}
              <span className="al-qlist__actions">
                {item.kind === 'group' ? (
                  <Button size="sm" variant="ghost" onClick={() => update(ungroupItem(items, index))}>
                    {t('settings.profiles.qualityItemList.ungroup')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="al-qlist__move"
                  aria-label={t('settings.profiles.qualityItemList.moveNameUp', { name })}
                  disabled={index === 0}
                  onClick={() => update(moveItem(items, index, index - 1))}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="al-qlist__move"
                  aria-label={t('settings.profiles.qualityItemList.moveNameDown', { name })}
                  disabled={index === items.length - 1}
                  onClick={() => update(moveItem(items, index, index + 1))}
                >
                  ↓
                </Button>
              </span>
            </li>
          );
        })}
      </ol>
      {grouping ? (
        <div className="al-qlist__group">
          <Input aria-label={t('settings.profiles.qualityItemList.newGroupName')} placeholder={t('settings.profiles.qualityItemList.groupName')} value={groupName} onChange={(e) => setGroupName(e.currentTarget.value)} />
          <Button
            size="sm"
            disabled={!canGroup}
            onClick={() => {
              update(groupItems(items, selected, groupName));
              setGroupName('');
            }}
          >
            {t('settings.profiles.qualityItemList.groupSelectedSelectedcount', { selectedCount: selected.length })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
