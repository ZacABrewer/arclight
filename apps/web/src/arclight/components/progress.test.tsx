import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Meter, Ring, Trail, meterIsLive } from './Progress.js';
import { Stepper, stepState } from './Navigation.js';

describe('Meter', () => {
  it('has no glow class when not live', () => {
    render(<Meter value={40} label="Storage" />);
    expect(screen.getByRole('progressbar', { name: 'Storage' }).className).not.toContain('al-meter--live');
  });

  it('glows only while live and active', () => {
    render(<Meter value={40} live label="Upload" />);
    expect(screen.getByRole('progressbar', { name: 'Upload' }).className).toContain('al-meter--live');
  });

  it('stops glowing at 100% even when live', () => {
    render(<Meter value={100} live label="Done" />);
    expect(screen.getByRole('progressbar', { name: 'Done' }).className).not.toContain('al-meter--live');
    expect(meterIsLive(100, true)).toBe(false);
    expect(meterIsLive(99, true)).toBe(true);
    expect(meterIsLive(10, false)).toBe(false);
  });

  it('warn tone, clamped value and mono value text', () => {
    render(<Meter value={140} tone="warn" label="/media/tv" valueText="0.9 TB free" />);
    const bar = screen.getByRole('progressbar', { name: '/media/tv' });
    expect(bar.className).toContain('al-meter--warn');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.style.getPropertyValue('--p')).toBe('100%');
    expect(screen.getByText('0.9 TB free').getAttribute('data-tone')).toBe('warn');
  });
});

describe('Trail', () => {
  it.each([
    ['active', 'active'],
    ['paused', 'paused'],
    ['stalled', 'stalled'],
    ['failed', 'failed'],
  ] as const)('%s → data-state="%s"', (state, attr) => {
    render(<Trail value={50} state={state} label="t" />);
    expect(screen.getByRole('progressbar').getAttribute('data-state')).toBe(attr);
  });

  it('complete and queued use the flat default (no data-state, no glow)', () => {
    render(
      <>
        <Trail value={100} state="complete" label="c" />
        <Trail value={30} state="queued" label="q" />
      </>,
    );
    expect(screen.getByRole('progressbar', { name: 'c' }).hasAttribute('data-state')).toBe(false);
    const q = screen.getByRole('progressbar', { name: 'q' });
    expect(q.hasAttribute('data-state')).toBe(false);
    expect(q.getAttribute('aria-valuenow')).toBe('0');
  });

  it('only the active trail carries the flowing light packet (v1.1 .al-trail[data-state="active"])', () => {
    const states = ['active', 'paused', 'stalled', 'failed', 'complete', 'queued'] as const;
    render(
      <>
        {states.map((s) => (
          <Trail key={s} value={50} state={s} label={s} />
        ))}
      </>,
    );
    const flowing = states.filter((s) => screen.getByRole('progressbar', { name: s }).matches('.al-trail[data-state="active"]'));
    expect(flowing).toEqual(['active']);
  });

  it('shows the mono percentage when asked', () => {
    render(<Trail value={68.4} showValue label="Andor" />);
    expect(screen.getByText('68%')).toBeTruthy();
  });
});

describe('Ring', () => {
  it('renders the value in the centre and as aria-valuenow', () => {
    render(<Ring value={68} label="Season" />);
    expect(screen.getByRole('progressbar', { name: 'Season' }).getAttribute('aria-valuenow')).toBe('68');
    expect(screen.getByText('68%')).toBeTruthy();
  });
});

describe('Stepper', () => {
  const steps = ['Admin account', 'TMDB key', 'Root folders', 'Download client', 'Indexer', 'VPN'].map((label, i) => ({ id: String(i), label }));

  it('derives done / active / todo from the current index', () => {
    expect(stepState(0, 2)).toBe('done');
    expect(stepState(2, 2)).toBe('active');
    expect(stepState(5, 2)).toBe('todo');
    const { container } = render(<Stepper steps={steps} current={2} />);
    const states = Array.from(container.querySelectorAll('.al-step')).map((li) => li.getAttribute('data-state'));
    expect(states).toEqual(['done', 'done', 'active', 'todo', 'todo', 'todo']);
    expect(container.querySelector('[aria-current="step"]')!.textContent).toContain('Root folders');
  });

  it('honours explicit per-step state', () => {
    const { container } = render(<Stepper steps={[{ id: 'a', label: 'A', state: 'done' }, { id: 'b', label: 'B' }]} current={0} />);
    expect(container.querySelector('.al-step')!.getAttribute('data-state')).toBe('done');
  });

  it('only done steps are clickable', async () => {
    const onStepClick = vi.fn();
    render(<Stepper steps={steps} current={2} onStepClick={onStepClick} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]!);
    expect(onStepClick).toHaveBeenCalledWith(1);
  });
});
