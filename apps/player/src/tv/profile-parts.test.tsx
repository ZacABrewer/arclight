import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// TvPanel covers the whole stage even when it is opened from inside a section (the title
// page's "more" button sits in the hero, whose box is far smaller than the screen).

vi.mock('@web/i18n/index', () => ({ useT: () => (k: string) => k }));

const { TvPanel } = await import('./profile-parts');

afterEach(cleanup);

// Panels open on a key press, after the stage is on screen.
function Screen({ open, onClose = () => {} }: { open: boolean; onClose?: () => void }) {
  return (
    <div data-tv-stage="" data-testid="stage">
      <section data-testid="hero" style={{ position: 'relative' }}>
        {open ? (
          <TvPanel label="More" onClose={onClose}>
            <button type="button">Mark watched</button>
          </TvPanel>
        ) : null}
      </section>
    </div>
  );
}

describe('TvPanel', () => {
  it('renders as a direct child of the stage, not inside the section that opened it', () => {
    const { rerender } = render(<Screen open={false} />);
    rerender(<Screen open />);
    const panel = screen.getByRole('dialog', { name: 'More' });
    expect(panel.parentElement).toBe(screen.getByTestId('stage'));
    expect(screen.getByTestId('hero').contains(panel)).toBe(false);
  });

  it('still closes on Back from the stage', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Screen open={false} onClose={onClose} />);
    rerender(<Screen open onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Mark watched' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders in place when there is no stage', () => {
    render(
      <div data-testid="plain">
        <TvPanel label="Pin" onClose={() => {}}>
          <span>x</span>
        </TvPanel>
      </div>,
    );
    expect(screen.getByRole('dialog', { name: 'Pin' }).parentElement).toBe(screen.getByTestId('plain'));
  });
});
