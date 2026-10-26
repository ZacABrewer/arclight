import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArclightGallery } from './gallery.js';
import { STATUS_LABELS } from './tokens.js';

describe('ArclightGallery', () => {
  it('renders every section and the full status vocabulary', () => {
    render(<ArclightGallery />);
    for (const title of ['Buttons', 'Inputs and selection', 'Status, tags, protocol', 'Progress', 'Surfaces', 'Overlays', 'Tables', 'Structure', 'States and data', 'Forms and pickers', 'Imagery and motion', 'Icons and chrome']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    for (const label of Object.values(STATUS_LABELS)) {
      expect(screen.getAllByText((t) => t.startsWith(label)).length).toBeGreaterThan(0);
    }
  });

  it('opens the 1100px modal from the overlays section', async () => {
    render(<ArclightGallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Modal 1100' }));
    expect(screen.getByRole('dialog', { name: 'Modal 1100' }).className).toContain('al-modal--1100');
  });
});
