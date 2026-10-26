import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PASSWORD_MASK } from '@arclight/shared';
import { SchemaForm } from './schema-form.js';
import { TestButton } from './test-result.js';
import type { FieldDefinition, FormValues } from './types.js';
import { getPath, initialValues, setPath, validateFields, visibleFields } from './values.js';

const FIELDS: FieldDefinition[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'settings.port', label: 'Port', type: 'number', min: 1, max: 65535, default: 8080 },
  { name: 'settings.password', label: 'Password', type: 'password' },
  { name: 'enable', label: 'Enable', type: 'checkbox', default: true },
  {
    name: 'settings.initialState',
    label: 'Initial State',
    type: 'select',
    default: 'start',
    options: [
      { value: 'start', label: 'Started' },
      { value: 'pause', label: 'Paused' },
    ],
  },
  { name: 'settings.urlBase', label: 'URL Base', type: 'text', advanced: true },
];

/** Controlled harness that exposes the latest values. */
function Harness({ fields = FIELDS, initial = {}, onValues }: { fields?: FieldDefinition[]; initial?: FormValues; onValues?: (v: FormValues) => void }) {
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, initial));
  return (
    <SchemaForm
      fields={fields}
      values={values}
      onChange={(v) => {
        setValues(v);
        onValues?.(v);
      }}
      errors={validateFields(fields, values)}
    />
  );
}

describe('form values helpers', () => {
  it('reads and writes dotted paths immutably', () => {
    const src = { settings: { host: 'a' }, name: 'x' };
    const out = setPath(src, 'settings.port', 9090);
    expect(out).toEqual({ settings: { host: 'a', port: 9090 }, name: 'x' });
    expect(src).toEqual({ settings: { host: 'a' }, name: 'x' });
    expect(getPath(out, 'settings.port')).toBe(9090);
    expect(getPath(out, 'missing.deep')).toBeUndefined();
  });

  it('fills defaults only where the base has no value', () => {
    const v = initialValues(FIELDS, { settings: { port: 1234 } });
    expect(v).toMatchObject({ enable: true, settings: { port: 1234, initialState: 'start' } });
  });

  it('validates required, number range, regex and select options', () => {
    const fields: FieldDefinition[] = [
      ...FIELDS,
      { name: 'pattern', label: 'Pattern', type: 'regex' },
    ];
    const errors = validateFields(fields, { name: '  ', settings: { port: 70000, initialState: 'bogus' }, pattern: '(' });
    expect(Object.keys(errors).sort()).toEqual(['name', 'pattern', 'settings.initialState', 'settings.port']);
    expect(errors['settings.port']).toMatch(/at most 65535/);
  });

  it('treats a stored-secret mask as a present value for required password fields', () => {
    const fields: FieldDefinition[] = [{ name: 'key', label: 'Key', type: 'password', required: true }];
    expect(validateFields(fields, { key: PASSWORD_MASK })).toEqual({});
    expect(validateFields(fields, { key: '' })).toHaveProperty('key');
  });

  it('shows advanced fields when toggled or when they have an error', () => {
    expect(visibleFields(FIELDS, false).map((f) => f.name)).not.toContain('settings.urlBase');
    expect(visibleFields(FIELDS, true).map((f) => f.name)).toContain('settings.urlBase');
    expect(visibleFields(FIELDS, false, { 'settings.urlBase': 'bad' }).map((f) => f.name)).toContain('settings.urlBase');
  });
});

describe('SchemaForm rendering', () => {
  it('renders a control per field type', () => {
    render(<Harness />);
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).type).toBe('text');
    expect((screen.getByLabelText(/^Port/) as HTMLInputElement).type).toBe('number');
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).type).toBe('password');
    expect(screen.getByRole('switch', { name: /^Enable/ })).toBeTruthy();
    expect((screen.getByLabelText(/^Initial State/) as HTMLSelectElement).value).toBe('start');
  });

  it('hides advanced fields until "Show advanced" is switched on', () => {
    render(<Harness />);
    expect(screen.queryByLabelText(/URL Base/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Show advanced' }));
    expect(screen.getByLabelText(/URL Base/)).toBeTruthy();
  });

  it('writes typed values back through dotted paths, keeping numbers numeric', () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} />);
    fireEvent.change(screen.getByLabelText(/^Port/), { target: { value: '9091' } });
    expect(onValues).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ port: 9091 }) }));
    fireEvent.change(screen.getByLabelText(/^Initial State/), { target: { value: 'pause' } });
    expect(getPath(onValues.mock.lastCall?.[0], 'settings.initialState')).toBe('pause');
  });

  it('shows the required error inline', () => {
    render(<Harness />);
    expect(screen.getByRole('alert').textContent).toBe('Name is required');
  });

  it('converts scaled number fields between stored and shown units', () => {
    const onValues = vi.fn();
    const fields: FieldDefinition[] = [{ name: 'seedTime', label: 'Seed time', type: 'number', scale: 60_000, unit: 'min' }];
    render(<Harness fields={fields} initial={{ seedTime: 1_800_000 }} onValues={onValues} />);
    const input = screen.getByLabelText('Seed time') as HTMLInputElement;
    expect(input.value).toBe('30');
    fireEvent.change(input, { target: { value: '45' } });
    expect(onValues).toHaveBeenLastCalledWith({ seedTime: 2_700_000 });
  });

  it('renders multiSelect as a checkbox group', () => {
    const onValues = vi.fn();
    const fields: FieldDefinition[] = [
      { name: 'kinds', label: 'Kinds', type: 'multiSelect', options: [{ value: 'trailer', label: 'Trailer' }, { value: 'sample', label: 'Sample' }] },
    ];
    render(<Harness fields={fields} initial={{ kinds: ['trailer'] }} onValues={onValues} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sample' }));
    expect(onValues).toHaveBeenLastCalledWith({ kinds: ['trailer', 'sample'] });
  });
});

describe('password mask round-trip', () => {
  const fields: FieldDefinition[] = [{ name: 'settings.password', label: 'Password', type: 'password' }];

  it('shows a stored secret as an empty input with an "unchanged" placeholder and keeps the mask', () => {
    const onValues = vi.fn();
    render(<Harness fields={fields} initial={{ settings: { password: PASSWORD_MASK } }} onValues={onValues} />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toMatch(/unchanged/);
    // Untouched: the value submitted is still the mask, so the api keeps the stored password.
    expect(onValues).not.toHaveBeenCalled();
  });

  it('replaces the mask when typing and sends an empty string when cleared', () => {
    const onValues = vi.fn();
    render(<Harness fields={fields} initial={{ settings: { password: PASSWORD_MASK } }} onValues={onValues} />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hunter2' } });
    expect(onValues).toHaveBeenLastCalledWith({ settings: { password: 'hunter2' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(onValues).toHaveBeenLastCalledWith({ settings: { password: '' } });
    expect(input.placeholder).not.toMatch(/unchanged/);
  });
});

describe('TestButton', () => {
  it('renders the outcome with warnings inline', async () => {
    render(<TestButton onTest={async () => ({ ok: true, message: 'version 5.0', warnings: ['Category missing'], errors: [] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const status = await screen.findByText('Test passed');
    expect(status.parentElement?.textContent).toContain('version 5.0');
    expect(screen.getByText(/Category missing/)).toBeTruthy();
  });

  it('shows a thrown error as a failed test', async () => {
    render(
      <TestButton
        onTest={async () => {
          throw new Error('connection refused');
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Test failed')).toBeTruthy();
    expect(screen.getByText('connection refused')).toBeTruthy();
  });

  it('does not call the test when beforeTest blocks it', async () => {
    const onTest = vi.fn();
    render(<TestButton beforeTest={() => false} onTest={onTest} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(onTest).not.toHaveBeenCalled());
  });
});
