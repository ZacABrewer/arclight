import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MultiSelect, multiSelectSummary, type MultiSelectOption } from './multi-select.js';
import { EntityPicker } from './entity-picker.js';
import { ProtocolBadge } from './protocol-badge.js';

const options: MultiSelectOption[] = [
  { value: 5000, label: 'TV' },
  { value: 5040, label: 'TV/HD', child: true },
  { value: 2000, label: 'Movies' },
];

function Harness({ onChange }: { onChange?: (v: number[]) => void }) {
  const [value, setValue] = useState<number[]>([]);
  return (
    <MultiSelect
      label="Categories"
      options={options}
      value={value}
      emptyLabel="All categories"
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe('MultiSelect', () => {
  it('opens a square checkbox list and toggles options on and off', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Categories: All categories' });
    expect(trigger.className).toContain('al-selectmenu__button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const group = screen.getByRole('group', { name: 'Categories' });
    const tv = within(group).getByRole('checkbox', { name: 'TV' });
    expect(tv.className).toContain('al-check');
    fireEvent.click(tv);
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Movies' }));
    expect(onChange).toHaveBeenLastCalledWith([5000, 2000]);
    expect(screen.getByRole('button', { name: 'Categories: TV, Movies' })).toBeTruthy();
    expect(within(group).getByRole('checkbox', { name: 'TV/HD' }).closest('label')!.className).toContain('mt-multi__option--child');

    fireEvent.click(within(group).getByRole('checkbox', { name: 'TV' }));
    expect(onChange).toHaveBeenLastCalledWith([2000]);
    fireEvent.click(within(group).getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith([]);

    // Esc closes and returns focus to the trigger.
    fireEvent.keyDown(within(group).getByRole('checkbox', { name: 'TV' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Categories' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Categories: All categories' }));
  });

  it('summarises the choice', () => {
    expect(multiSelectSummary(options, [], 'Any')).toBe('Any');
    expect(multiSelectSummary(options, [5040])).toBe('TV/HD');
    expect(multiSelectSummary(options, [5000, 5040, 2000])).toBe('3 selected');
  });
});

describe('EntityPicker', () => {
  it('filters with the keyboard and chooses with Enter', () => {
    const onChange = vi.fn();
    render(
      <EntityPicker
        aria-label="Series"
        value={null}
        onChange={onChange}
        options={[
          { id: 1, label: 'The Expanse', detail: '2015' },
          { id: 2, label: 'Severance', detail: '2022' },
          { id: 3, label: 'Silo', detail: '2023' },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: 'Series' });
    expect(button.className).toContain('al-selectmenu__button');
    fireEvent.click(button);
    const box = screen.getByRole('combobox', { name: 'Search Series' });
    expect(box.className).toContain('al-input');
    fireEvent.change(box, { target: { value: 's' } });
    const opts = screen.getAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual(['The Expanse 2015', 'Severance 2022', 'Silo 2023']);
    fireEvent.change(box, { target: { value: 'si' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Silo 2023']);
    fireEvent.change(box, { target: { value: 'se' } });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(2);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('ProtocolBadge', () => {
  it('renders the kit TOR / NZB badge', () => {
    render(
      <>
        <ProtocolBadge protocol="torrent" />
        <ProtocolBadge protocol="usenet" />
      </>,
    );
    const tor = screen.getByText('TOR');
    const nzb = screen.getByText('NZB');
    expect(tor.className).toContain('al-proto');
    expect(nzb.className).toContain('al-proto');
    expect(tor.getAttribute('title')).toBe('Torrent');
    expect(nzb.getAttribute('title')).toBe('Usenet');
  });
});
