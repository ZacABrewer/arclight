import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Rail, RAIL_ITEMS } from './Rail.js';
import { TopBar } from './TopBar.js';
import { MobileTabBar } from './MobileTabBar.js';
import { PageHeader } from './PageHeader.js';
import { ContentInset } from './ContentInset.js';

describe('Rail', () => {
  it('renders the 11 two-letter codes in kit order', () => {
    const { container } = render(<Rail active="DB" />);
    const codes = Array.from(container.querySelectorAll('.al-rail__code')).map((n) => n.textContent);
    expect(codes).toEqual(['DB', 'LB', 'DS', 'RQ', 'CL', 'WN', 'AC', 'SB', 'IX', 'ST', 'SY']);
    expect(RAIL_ITEMS).toHaveLength(11);
  });

  it('marks only the active item with aria-current and gives it the roving tab stop', () => {
    render(<Rail active="AC" />);
    const active = screen.getByRole('button', { name: 'Activity' });
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(active.tabIndex).toBe(0);
    const others = screen.getAllByRole('button').filter((b) => b !== active);
    expect(others.every((b) => b.getAttribute('aria-current') === null && b.tabIndex === -1)).toBe(true);
  });

  it('no item is current on 404 (active none), first item takes the tab stop', () => {
    render(<Rail active={null} />);
    expect(document.querySelector('[aria-current]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Dashboard' }).tabIndex).toBe(0);
  });

  it('moves focus with ArrowDown / ArrowUp / Home / End and wraps', async () => {
    render(<Rail active="DB" />);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dashboard' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Library' }));
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'System' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dashboard' }));
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'System' }));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dashboard' }));
  });

  it('activates with Enter / click and reports the code', async () => {
    const onSelect = vi.fn();
    render(<Rail active="DB" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(onSelect).toHaveBeenLastCalledWith('CL', expect.anything());
    screen.getByRole('button', { name: 'Wanted' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('WN', expect.anything());
  });

  it('renders links when items carry hrefs, and the compact variant', () => {
    const items = RAIL_ITEMS.map((i) => ({ ...i, href: `/${i.code.toLowerCase()}` }));
    const { container } = render(<Rail active="LB" items={items} compact />);
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('href')).toBe('/lb');
    expect(container.querySelector('nav')!.className).toContain('al-rail--compact');
  });
});

describe('TopBar', () => {
  it('shows connection, VPN, requests and issues as plain text', () => {
    render(<TopBar connected vpnLocation="Amsterdam" requestCount={4} issueCount={2} initials="sk" />);
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('VPN Amsterdam')).toBeTruthy();
    expect(screen.getByText('requests', { exact: false }).textContent).toBe('4 requests');
    expect(screen.getByRole('button', { name: 'Account' }).textContent).toBe('SK');
  });

  it('colours the issue count orange only when > 0', () => {
    const { container, rerender } = render(<TopBar issueCount={2} />);
    expect(container.querySelector('.al-topbar__issues')!.getAttribute('data-active')).toBe('true');
    rerender(<TopBar issueCount={0} />);
    expect(container.querySelector('.al-topbar__issues')!.hasAttribute('data-active')).toBe(false);
    expect(container.querySelector('.al-topbar__issues')!.textContent).toBe('0 issues');
  });

  it('shows the down state when disconnected', () => {
    const { container } = render(<TopBar connected={false} vpnLocation={null} />);
    expect(screen.getByText('Reconnecting')).toBeTruthy();
    expect(screen.getByText('VPN off')).toBeTruthy();
    expect(container.querySelector('.al-live')!.getAttribute('data-state')).toBe('down');
  });

  it('"/" opens search except while typing', async () => {
    const onSearch = vi.fn();
    render(
      <>
        <TopBar onSearch={onSearch} />
        <input aria-label="Other field" />
      </>,
    );
    await userEvent.keyboard('/');
    expect(onSearch).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('textbox', { name: 'Other field' }));
    await userEvent.keyboard('/');
    expect(onSearch).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect(onSearch).toHaveBeenCalledTimes(2);
  });

  it('opens the user menu slot from the avatar and closes it with Escape', async () => {
    render(<TopBar initials="SK" userLabel="Account: sam" userMenu={() => <button type="button">Sign out</button>} />);
    const avatar = screen.getByRole('button', { name: 'Account: sam' });
    await userEvent.click(avatar);
    expect(avatar.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(document.activeElement).toBe(avatar);
  });
});

describe('MobileTabBar / PageHeader / ContentInset', () => {
  it('tab bar has the five kit tabs with one active', () => {
    render(<MobileTabBar active="library" />);
    const tabs = screen.getAllByRole('button');
    expect(tabs.map((t) => t.textContent)).toEqual(['Home', 'Library', 'Discover', 'Activity', 'More']);
    expect(screen.getByRole('button', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
  });

  it('page header renders mono index, title-l, controls and actions', () => {
    render(
      <PageHeader index="01" title="Library" actions={<button type="button">Add series</button>}>
        <span>controls</span>
      </PageHeader>,
    );
    const h1 = screen.getByRole('heading', { level: 1, name: 'Library' });
    expect(h1.className).toContain('al-title-l');
    expect(document.querySelector('.al-index')!.textContent).toBe('01');
    expect(screen.getByRole('button', { name: 'Add series' }).parentElement!.className).toBe('al-page-header__actions');
  });

  it('content inset is the main landmark', () => {
    render(<ContentInset>x</ContentInset>);
    expect(screen.getByRole('main').className).toBe('al-content');
  });
});
