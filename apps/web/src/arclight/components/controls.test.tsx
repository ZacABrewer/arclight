import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Checkbox, Segmented, Toggle } from './Controls.js';
import { Field, Input } from './Input.js';
import { SelectMenu } from './Select.js';
import { AccordionItem, FilterBar, Paginator, Tabs } from './Navigation.js';
import { DatePicker, monthGrid, toIsoDate } from './DatePicker.js';
import { Derezz } from './Derezz.js';
import { Pane, FloatBar } from './Pane.js';
import { EmptyState } from './States.js';
import { PathPickerField } from './PathPickerField.js';
import { Poster } from './Media.js';

afterEach(() => {
  // @ts-expect-error — drop any matchMedia mock
  delete window.matchMedia;
});

describe('Checkbox / Toggle / Segmented', () => {
  it('sets the indeterminate DOM property and aria-checked=mixed', () => {
    render(<Checkbox aria-label="All" indeterminate readOnly />);
    const cb = screen.getByRole('checkbox', { name: 'All' }) as HTMLInputElement;
    expect(cb.indeterminate).toBe(true);
    expect(cb.getAttribute('aria-checked')).toBe('mixed');
  });

  it('toggle is a switch that works uncontrolled', async () => {
    render(<Toggle label="Use hardlinks" name="hardlinks" />);
    const sw = screen.getByRole('switch', { name: 'Use hardlinks' }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await userEvent.click(screen.getByText('Use hardlinks'));
    expect(sw.checked).toBe(true);
  });

  it('segmented uses aria-pressed and arrow keys', async () => {
    function Harness() {
      const [v, setV] = useState('series');
      return <Segmented aria-label="Type" value={v} onChange={setV} options={[{ value: 'series', label: 'Series' }, { value: 'movies', label: 'Movies' }]} />;
    }
    render(<Harness />);
    const series = screen.getByRole('button', { name: 'Series' });
    expect(series.getAttribute('aria-pressed')).toBe('true');
    series.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Movies' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Movies' }));
  });
});

describe('Field', () => {
  it('wires id, hint and error into the control', () => {
    render(
      <Field label="API key" hint="From themoviedb.org" error="TMDB rejected this key (401)">
        <Input mono />
      </Field>,
    );
    const input = screen.getByLabelText('API key');
    expect(input.className).toContain('al-input--mono');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('-error');
    expect(screen.getByRole('alert').textContent).toBe('TMDB rejected this key (401)');
  });
});

describe('SelectMenu', () => {
  it('opens with the keyboard and chooses with Enter', async () => {
    const onChange = vi.fn();
    render(
      <SelectMenu
        aria-label="Quality"
        value="uhd"
        onChange={onChange}
        options={[
          { value: 'uhd', label: 'UHD-2160' },
          { value: 'hd', label: 'HD-1080' },
          { value: 'any', label: 'Any' },
        ]}
      />,
    );
    screen.getByRole('button', { name: 'Quality' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    const list = screen.getByRole('listbox');
    expect(document.activeElement).toBe(list);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('hd');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Navigation', () => {
  it('paginator shows "Page x of y" and disables at the bounds', async () => {
    const onPageChange = vi.fn();
    const { rerender } = render(<Paginator page={1} pageCount={4} onPageChange={onPageChange} />);
    expect(screen.getByRole('navigation').textContent).toContain('Page 1 of 4');
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    rerender(<Paginator page={4} pageCount={4} onPageChange={onPageChange} />);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('tabs move with arrow keys and show counts', async () => {
    render(
      <Tabs
        tabs={[
          { id: 'q', label: 'Queue', count: 8, content: 'queue panel' },
          { id: 'h', label: 'History', content: 'history panel' },
        ]}
      />,
    );
    const queue = screen.getByRole('tab', { name: /Queue/ });
    expect(queue.querySelector('.al-tabs__count')!.textContent).toBe('8');
    queue.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('history panel');
  });

  it('accordion toggles via its trigger button', async () => {
    render(
      <AccordionItem title="Season 2" meta="8/10">
        <p>Episodes</p>
      </AccordionItem>,
    );
    const trigger = screen.getByRole('button', { name: /Season 2/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Episodes')).toBeNull();
    await userEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Episodes')).toBeTruthy();
  });

  it('filter bar shows Clear only with active filters', () => {
    const { rerender } = render(
      <FilterBar onClear={() => {}} activeCount={0}>
        <span>f</span>
      </FilterBar>,
    );
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    rerender(
      <FilterBar onClear={() => {}} activeCount={2}>
        <span>f</span>
      </FilterBar>,
    );
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });
});

describe('DatePicker', () => {
  it('builds a Monday-first 6-week grid', () => {
    const cells = monthGrid(2026, 9); // October 2026 starts on a Thursday
    expect(cells).toHaveLength(42);
    expect(toIsoDate(cells[0]!)).toBe('2026-09-28');
    expect(toIsoDate(cells[3]!)).toBe('2026-10-01');
  });

  it('selects a day and marks it aria-selected', async () => {
    function Harness() {
      const [v, setV] = useState<string | null>('2026-10-25');
      return <DatePicker value={v} onChange={setV} today="2026-10-25" />;
    }
    render(<Harness />);
    expect(screen.getByRole('gridcell', { name: '25 October 2026' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(screen.getByRole('gridcell', { name: '27 October 2026' }));
    expect(screen.getByRole('gridcell', { name: '27 October 2026' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('gridcell', { name: '1 November 2026' })).toBeTruthy();
  });
});

describe('Pane / FloatBar / EmptyState / PathPicker / Poster / Derezz', () => {
  it('chamfered panes get the clip class and lit edges', () => {
    const { container } = render(
      <Pane chamfer="both" title="Next 24 hours">
        x
      </Pane>,
    );
    const pane = container.querySelector('.al-pane')!;
    expect(pane.className).toContain('al-pane--chamfer-both');
    expect(Array.from(pane.querySelectorAll('.al-edge')).map((e) => e.className)).toEqual(['al-edge al-edge--tl', 'al-edge al-edge--br']);
    expect(screen.getByRole('heading', { name: 'Next 24 hours' }).className).toBe('al-label');
  });

  it('save float bar pluralises the change count', () => {
    render(<FloatBar variant="save" count={2} position="inline" />);
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain('2 unsaved changes');
  });

  it('empty state renders title, hint and actions', () => {
    render(
      <EmptyState title="No series yet" action={<button type="button">Add series</button>}>
        Add one or import a folder.
      </EmptyState>,
    );
    expect(screen.getByText('No series yet').className).toBe('al-empty__title');
    expect(screen.getByRole('button', { name: 'Add series' })).toBeTruthy();
  });

  it('path picker selects on click and opens on double-click', async () => {
    const onChange = vi.fn();
    const onNavigate = vi.fn();
    render(
      <PathPickerField
        value="/media"
        onChange={onChange}
        onNavigate={onNavigate}
        crumbs={[{ label: '/', path: '/' }, { label: 'media', path: '/media' }]}
        entries={[{ name: 'movies', path: '/media/movies', meta: '6.4 TB free' }]}
      />,
    );
    const row = screen.getByRole('option', { name: /movies/ });
    await userEvent.click(row);
    expect(onChange).toHaveBeenCalledWith('/media/movies');
    await userEvent.dblClick(row);
    expect(onNavigate).toHaveBeenCalledWith('/media/movies');
    await userEvent.click(screen.getByRole('button', { name: '/' }));
    expect(onNavigate).toHaveBeenLastCalledWith('/');
  });

  it('poster without art shows the stripe fallback with the title', () => {
    render(<Poster title="Severance" />);
    expect(screen.getByTestId('al-frame-fallback').textContent).toBe('Severance');
  });

  it('derezz calls onDone immediately under reduced motion', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }),
    });
    const onDone = vi.fn();
    const { container } = render(
      <Derezz active onDone={onDone}>
        <span>Foundation</span>
      </Derezz>,
    );
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild!.className).toContain('al-derezz');
  });
});
