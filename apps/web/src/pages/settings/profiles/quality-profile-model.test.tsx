import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { DelayProfile, QualityProfileInput, QualityProfileItem } from '@media-tron/shared';
import { QualityItemList } from './quality-item-list.js';
import {
  cutoffOptions,
  delayReorderRequest,
  fromDisplay,
  groupItems,
  itemName,
  moveItem,
  setFormatScore,
  toDisplay,
  ungroupItem,
  validateProfile,
} from './quality-profile-model.js';

// Quality ids from packages/shared/src/quality.ts: 4 HDTV-720p, 5 WEBDL-720p, 3 WEBDL-1080p, 7 Bluray-1080p.
const q = (qualityId: number, allowed = true): QualityProfileItem => ({ kind: 'quality', qualityId, allowed });

const profile = (over: Partial<QualityProfileInput> = {}): QualityProfileInput => ({
  name: 'HD',
  upgradeAllowed: true,
  cutoff: 3,
  items: [q(4), q(5), q(3), q(7, false)],
  minFormatScore: 0,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  formatItems: [],
  languages: [],
  ...over,
});

describe('quality profile item editing', () => {
  it('moves an item and clamps out-of-range targets', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
  });

  it('converts between api order (worst first) and display order (best first)', () => {
    const items = [q(4), q(3)];
    expect(toDisplay(items).map(itemName)).toEqual(['WEBDL-1080p', 'HDTV-720p']);
    expect(fromDisplay(toDisplay(items))).toEqual(items);
  });

  it('groups selected qualities in place with a fresh group id', () => {
    const out = groupItems([q(4), q(5), q(3, false)], [1, 2], 'WEB');
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ kind: 'group', id: 1000, name: 'WEB', qualityIds: [5, 3], allowed: true });
  });

  it('refuses to group fewer than two qualities or without a name', () => {
    const items = [q(4), q(5)];
    expect(groupItems(items, [0], 'X')).toEqual(items);
    expect(groupItems(items, [0, 1], '  ')).toEqual(items);
  });

  it('ungroups back to member qualities inheriting the allowed flag', () => {
    const grouped = groupItems([q(4), q(5, false), q(3, false)], [1, 2], 'WEB');
    expect(ungroupItem(grouped, 1)).toEqual([q(4), q(5, false), q(3, false)]);
  });

  it('offers only allowed items as cutoff', () => {
    expect(cutoffOptions(profile().items).map((o) => o.value)).toEqual([4, 5, 3]);
  });

  it('flags a cutoff that is not allowed', () => {
    expect(validateProfile(profile({ cutoff: 7 }))).toEqual({ cutoff: expect.stringMatching(/allowed/) });
    expect(validateProfile(profile())).toEqual({});
  });

  it('requires a name, an allowed quality and a positive upgrade increment', () => {
    const errors = validateProfile(profile({ name: '', items: [q(4, false)], minUpgradeFormatScore: 0 }));
    expect(Object.keys(errors).sort()).toEqual(['items', 'minUpgradeFormatScore', 'name']);
  });

  it('keeps group ids valid as cutoff after grouping', () => {
    const items = groupItems(profile().items, [1, 2], 'HD-WEB');
    expect(validateProfile(profile({ items, cutoff: 1000 }))).toEqual({});
    expect(validateProfile(profile({ items, cutoff: 5 }))).toHaveProperty('cutoff');
  });

  it('stores custom format scores sparsely', () => {
    const a = setFormatScore([], 3, 50);
    expect(a).toEqual([{ formatId: 3, score: 50 }]);
    expect(setFormatScore(a, 3, -10)).toEqual([{ formatId: 3, score: -10 }]);
    expect(setFormatScore(a, 3, 0)).toEqual([]);
  });
});

describe('delay profile reordering', () => {
  const dp = (id: number, order: number, tags: number[]): DelayProfile => ({
    id,
    order,
    tags,
    preferredProtocol: 'usenet',
    usenetDelayMinutes: 0,
    torrentDelayMinutes: 0,
    bypassIfHighestQuality: false,
    bypassIfAboveCustomFormatScore: false,
    minimumCustomFormatScore: 0,
  });
  const list = [dp(1, 1, [1]), dp(2, 2, [2]), dp(3, 3, [3]), dp(9, 4, [])];

  it('moves up to the front or after the item two above', () => {
    expect(delayReorderRequest(list, 1, 'up')).toEqual({ id: 2 });
    expect(delayReorderRequest(list, 2, 'up')).toEqual({ id: 3, afterId: 1 });
  });

  it('moves down after the next item but never below the default', () => {
    expect(delayReorderRequest(list, 0, 'down')).toEqual({ id: 1, afterId: 2 });
    expect(delayReorderRequest(list, 2, 'down')).toBeNull();
    expect(delayReorderRequest(list, 3, 'up')).toBeNull();
  });
});

describe('QualityItemList', () => {
  function Harness({ onChange }: { onChange: (items: QualityProfileItem[]) => void }) {
    const [items, setItems] = useState<QualityProfileItem[]>([q(7), q(3), q(5)]);
    return (
      <QualityItemList
        items={items}
        onChange={(next) => {
          setItems(next);
          onChange(next);
        }}
      />
    );
  }

  const names = () => screen.getAllByTestId('quality-item').map((li) => within(li).getAllByText(/./)[1]?.textContent);

  it('reorders with the arrow buttons', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move WEBDL-720p up' }));
    expect(onChange.mock.lastCall?.[0].map(itemName)).toEqual(['Bluray-1080p', 'WEBDL-720p', 'WEBDL-1080p']);
    expect(names()).toHaveLength(3);
  });

  it('reorders by drag and drop', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const rows = screen.getAllByTestId('quality-item');
    const dataTransfer = { setData: vi.fn(), getData: () => '0', effectAllowed: '' };
    fireEvent.dragStart(rows[0]!, { dataTransfer });
    fireEvent.dragOver(rows[2]!, { dataTransfer });
    fireEvent.drop(rows[2]!, { dataTransfer });
    expect(onChange.mock.lastCall?.[0].map(itemName)).toEqual(['WEBDL-1080p', 'WEBDL-720p', 'Bluray-1080p']);
  });

  it('toggles allowed and groups the selected rows', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow Bluray-1080p' }));
    expect(onChange.mock.lastCall?.[0][0].allowed).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select WEBDL-1080p for grouping' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select WEBDL-720p for grouping' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New group name' }), { target: { value: 'WEB' } });
    fireEvent.click(screen.getByRole('button', { name: /Group selected/ }));
    const last = onChange.mock.lastCall?.[0] as QualityProfileItem[];
    expect(last).toHaveLength(2);
    expect(last[1]).toMatchObject({ kind: 'group', name: 'WEB', qualityIds: [3, 5] });
  });
});
