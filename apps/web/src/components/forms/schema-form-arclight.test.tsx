import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { PASSWORD_MASK } from '@arclight/shared';
import { SchemaForm, STORED_SECRET_PLACEHOLDER } from './schema-form.js';
import { TestButton } from './test-result.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { TermList } from './term-list.js';
import type { FieldDefinition, FormValues } from './types.js';
import { initialValues } from './values.js';

const FIELDS: FieldDefinition[] = [
  { name: 'host', label: 'Host', type: 'text', helpText: 'Hostname or IP.', required: true },
  { name: 'port', label: 'Port', type: 'number', unit: 'tcp' },
  { name: 'apiKey', label: 'API key', type: 'password' },
  { name: 'enable', label: 'Enable', type: 'checkbox', helpText: 'Use this client for grabs' },
  { name: 'pattern', label: 'Pattern', type: 'regex' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
  { name: 'urlBase', label: 'URL base', type: 'text', advanced: true },
];

function Harness({ inline = true, showAdvanced, initial = {}, onValues }: { inline?: boolean; showAdvanced?: boolean; initial?: FormValues; onValues?: (v: FormValues) => void }) {
  const [values, setValues] = useState<FormValues>(() => initialValues(FIELDS, initial));
  return (
    <SchemaForm
      fields={FIELDS}
      values={values}
      inline={inline}
      showAdvanced={showAdvanced}
      onChange={(v) => {
        setValues(v);
        onValues?.(v);
      }}
    />
  );
}

describe('SchemaForm on Arclight controls', () => {
  it('lays settings forms out as 220px FormRows with captions', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('.al-form-grid')).toBeTruthy();
    expect(container.querySelectorAll('.al-form-row').length).toBe(6);
    expect(screen.getByText('Hostname or IP.').className).toContain('al-form-row__caption');
  });

  it('stacks dialog forms with al-field', () => {
    const { container } = render(<Harness inline={false} />);
    expect(container.querySelectorAll('.al-field').length).toBe(6);
    expect(container.querySelector('.al-form-row')).toBeNull();
  });

  it('uses kit classes: al-input, mono numbers and regex, al-toggle switch, textarea', () => {
    render(<Harness />);
    expect(screen.getByLabelText(/^Host/).className).toContain('al-input');
    expect(screen.getByLabelText('Port').className).toContain('al-input--mono');
    expect(screen.getByLabelText('Pattern').className).toContain('al-input--mono');
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
    const sw = screen.getByRole('switch', { name: 'Enable' });
    expect(sw.parentElement?.querySelector('.al-toggle')).toBeTruthy();
  });

  it('puts toggle captions inline beside the switch', () => {
    render(<Harness />);
    const caption = screen.getByText('Use this client for grabs');
    expect(caption.parentElement?.className).toContain('al-form-row__control--inline');
  });

  it('shows the unit as a mono hint inside the number input', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Port');
    expect(input.parentElement?.className).toContain('al-input-affix');
    expect(input.parentElement?.textContent).toBe('tcp');
  });

  it('respects a controlled advanced toggle and draws none of its own', () => {
    const { rerender } = render(<Harness showAdvanced={false} />);
    expect(screen.queryByRole('switch', { name: 'Show advanced' })).toBeNull();
    expect(screen.queryByLabelText(/URL base/)).toBeNull();
    rerender(<Harness showAdvanced />);
    expect(screen.getByLabelText(/URL base/)).toBeTruthy();
    expect(screen.getByText('ADVANCED')).toBeTruthy();
  });

  it('marks required fields and shows inline errors in the row', () => {
    render(<SchemaForm fields={FIELDS} values={{}} onChange={() => {}} errors={{ host: 'Host is required' }} inline />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Host is required');
    expect(alert.className).toContain('al-form-row__error');
    expect(screen.getByLabelText(/^Host/).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('password mask round-trip (Arclight)', () => {
  it('shows a stored secret as empty with the stored placeholder and keeps the mask untouched', () => {
    const onValues = vi.fn();
    render(<Harness initial={{ apiKey: PASSWORD_MASK }} onValues={onValues} />);
    const input = screen.getByLabelText('API key') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(STORED_SECRET_PLACEHOLDER);
    expect(input.dataset.stored).toBe('true');
    fireEvent.change(screen.getByLabelText(/^Host/), { target: { value: 'nas' } });
    expect(onValues).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: PASSWORD_MASK, host: 'nas' }));
  });

  it('replaces the mask when typing and clears the secret with an empty string', () => {
    const onValues = vi.fn();
    render(<Harness initial={{ apiKey: PASSWORD_MASK }} onValues={onValues} />);
    const input = screen.getByLabelText('API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 's3cret' } });
    expect(onValues).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 's3cret' }));
    expect(input.dataset.stored).toBeUndefined();
    fireEvent.change(input, { target: { value: '' } });
    expect(onValues).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: '' }));
  });
});

describe('TestButton (Arclight)', () => {
  it('is a secondary button and renders a passed chip inline', async () => {
    render(<TestButton onTest={async () => ({ ok: true, message: 'v4.6', warnings: [], errors: [] })} />);
    const btn = screen.getByRole('button', { name: 'Test' });
    expect(btn.className).toContain('al-btn--secondary');
    fireEvent.click(btn);
    const chip = await screen.findByText('Test passed');
    expect(chip.closest('.al-chip')).toBeTruthy();
    expect(screen.getByRole('status').dataset.ok).toBe('true');
  });

  it('renders failures with a danger chip and the cause', async () => {
    render(<TestButton onTest={async () => ({ ok: false, warnings: ['Slow response'], errors: ['Unauthorized'] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const chip = await screen.findByText('Test failed');
    expect(chip.closest('.al-chip')?.getAttribute('data-status')).toBe('failed');
    expect(screen.getByText('Unauthorized')).toBeTruthy();
    expect(screen.getByText('Slow response')).toBeTruthy();
  });
});

describe('ConfirmDialog and TermList', () => {
  it('confirm uses a solid danger button that names the action', async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ConfirmDialog open title="Delete indexer" confirmLabel="Delete indexer" onCancel={() => {}} onConfirm={onConfirm} />);
    const btn = screen.getByRole('button', { name: 'Delete indexer' });
    expect(btn.className).toContain('al-btn--danger');
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalled();
  });

  it('term list renders removable mono tags', () => {
    const onChange = vi.fn();
    render(<TermList value={['x265', '/HDR/']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove x265' }));
    expect(onChange).toHaveBeenCalledWith(['/HDR/']);
  });
});
