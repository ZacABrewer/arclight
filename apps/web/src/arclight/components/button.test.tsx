import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, LinkButton } from './Button.js';
import { Icon } from './Icon.js';

describe('Button', () => {
  it.each(['primary', 'secondary', 'ghost', 'danger'] as const)('variant %s maps to .al-btn--%s', (variant) => {
    render(<Button variant={variant}>Go</Button>);
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn.className.split(' ')).toEqual(expect.arrayContaining(['al-btn', `al-btn--${variant}`]));
  });

  it('defaults to secondary, md and type=button', () => {
    render(<Button>Refresh</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toBe('al-btn al-btn--secondary');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it.each([
    ['sm', 'al-btn--sm'],
    ['lg', 'al-btn--lg'],
  ] as const)('size %s adds %s (32/46px)', (size, cls) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole('button').className).toContain(cls);
  });

  it('md size adds no size modifier (38px default)', () => {
    render(<Button size="md">Go</Button>);
    expect(screen.getByRole('button').className).not.toMatch(/al-btn--(sm|lg)/);
  });

  it('loading disables, sets aria-busy and shows the busy glyph instead of the icon', async () => {
    const onClick = vi.fn();
    render(
      <Button loading icon={<Icon name="plus" />} onClick={onClick}>
        Saving
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Saving' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('al-btn-spinner')).toBeTruthy();
    expect(btn.querySelector('[data-icon="plus"]')).toBeNull();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('disabled buttons do not fire', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Delete
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('icon without children becomes a square icon button', () => {
    render(<Button aria-label="Refresh" icon={<Icon name="refresh" />} size="sm" />);
    const btn = screen.getByRole('button', { name: 'Refresh' });
    expect(btn.className).toContain('al-btn--icon');
    expect(btn.className).toContain('al-btn--sm');
  });

  it('danger-solid carries both danger classes', () => {
    render(<Button variant="danger-solid">Delete series</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('al-btn--danger');
    expect(cls).toContain('al-btn--danger-solid');
  });

  it('fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Approve</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('LinkButton renders an anchor with button classes', () => {
    render(
      <LinkButton href="/" variant="primary">
        Go to dashboard
      </LinkButton>,
    );
    const a = screen.getByRole('link', { name: 'Go to dashboard' });
    expect(a.className).toContain('al-btn--primary');
  });
});
