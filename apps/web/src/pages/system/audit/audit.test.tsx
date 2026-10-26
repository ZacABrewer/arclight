import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuditEvent, AuditPage } from '@arclight/shared';
import { auditApi, auditQuery } from '../../../api/audit.js';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { EMPTY_AUDIT_FILTER, activeAuditFilters, auditTone, toAuditFilter } from './audit-page.js';

afterEach(() => vi.unstubAllGlobals());

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: 1,
  time: '2026-10-25T10:00:00.000Z',
  userId: 1,
  username: 'admin',
  ip: '192.168.1.20',
  action: 'settings.update',
  target: 'metadata',
  method: 'PUT',
  route: '/api/v1/settings/metadata',
  statusCode: 200,
  details: null,
  ...over,
});

function page(records: AuditEvent[], total = records.length, pageNo = 1): AuditPage {
  return { page: pageNo, pageSize: 50, totalRecords: total, records };
}

function baseRoutes(extra: Record<string, unknown> = {}) {
  return {
    '/api/v1/audit': (_: RequestInit | undefined, url: URL) =>
      url.searchParams.get('page') === '2'
        ? page([event({ id: 99, action: 'series.delete', target: 'Severance' })], 51, 2)
        : page([event(), event({ id: 2, action: 'login.failed', username: 'mallory', userId: null, statusCode: 401, method: 'POST', route: '/api/v1/auth/login', target: null })], 51),
    '/api/v1/audit/actions': ['login.failed', 'series.delete', 'settings.update'],
    '/api/v1/settings/audit': { enabled: true, retentionDays: 90 },
    'PUT /api/v1/settings/audit': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
    ...extra,
  };
}

describe('audit helpers', () => {
  it('turns the bar into an api filter with an exclusive end day', () => {
    expect(toAuditFilter({ user: ' admin ', action: 'settings', from: '2026-10-01', to: '2026-10-31' })).toEqual({
      user: 'admin',
      action: 'settings',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
    expect(toAuditFilter(EMPTY_AUDIT_FILTER)).toEqual({});
    expect(toAuditFilter({ ...EMPTY_AUDIT_FILTER, from: 'not-a-date' })).toEqual({});
  });

  it('counts active filters', () => {
    expect(activeAuditFilters(EMPTY_AUDIT_FILTER)).toBe(0);
    expect(activeAuditFilters({ user: 'a', action: '', from: '2026-01-01', to: '' })).toBe(2);
  });

  it('tones failures as danger and deletes as warn', () => {
    expect(auditTone({ action: 'login.failed', statusCode: null })).toBe('danger');
    expect(auditTone({ action: 'settings.update', statusCode: 500 })).toBe('danger');
    expect(auditTone({ action: 'series.delete', statusCode: 204 })).toBe('warn');
    expect(auditTone({ action: 'settings.update', statusCode: 200 })).toBe('neutral');
  });

  it('builds the CSV link with only the filters that are set', () => {
    expect(auditQuery({ user: '', action: 'login', from: undefined })).toEqual({ action: 'login' });
    expect(auditApi.exportUrl({ user: 'admin', action: '' })).toBe('/api/v1/audit/export?user=admin');
    expect(auditApi.exportUrl({})).toBe('/api/v1/audit/export');
  });
});

describe('System → Audit', () => {
  it('lists events with action chips, the total and a CSV export link', async () => {
    stubApi(baseRoutes());
    renderAt('/system/audit');
    expect(await screen.findByText('mallory')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Audit events' });
    expect(within(table).getByText('login.failed')).toBeTruthy();
    expect(within(table).getByText('POST /api/v1/auth/login')).toBeTruthy();
    expect(within(table).getByText('401')).toBeTruthy();
    expect(screen.getByText('51')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toBe('/api/v1/audit/export');
  });

  it('filters by action and carries the filter into the export link', async () => {
    const api = stubApi(baseRoutes());
    renderAt('/system/audit');
    await screen.findByText('mallory');
    await screen.findByRole('option', { name: 'series.delete' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Action' }), { target: { value: 'series.delete' } });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toBe('/api/v1/audit/export?action=series.delete'));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/audit')).toBe(true));
    const fetchMock = vi.mocked(fetch);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('action=series.delete'))).toBe(true));
  });

  it('filters by user and date range, then clears', async () => {
    stubApi(baseRoutes());
    renderAt('/system/audit');
    await screen.findByText('mallory');
    fireEvent.change(screen.getByRole('textbox', { name: 'User' }), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-02' } });
    const fetchMock = vi.mocked(fetch);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('user=admin') && String(u).includes('from=2026-10-01') && String(u).includes('to=2026-10-03'))).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect((screen.getByRole('textbox', { name: 'User' }) as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toBe('/api/v1/audit/export'));
  });

  it('pages through the log', async () => {
    stubApi(baseRoutes());
    renderAt('/system/audit');
    await screen.findByText('mallory');
    expect(screen.getByText(/Page/).textContent).toContain('1');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Severance')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
  });

  it('turns recording off through the audit settings', async () => {
    const api = stubApi(baseRoutes());
    renderAt('/system/audit');
    const toggle = await screen.findByRole('switch', { name: 'Record changes' });
    expect(screen.getByText('90 d')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/audit')?.body).toEqual({ enabled: false, retentionDays: 90 }));
  });

  it('shows an error block when the log cannot be read', async () => {
    stubApi(baseRoutes({ '/api/v1/audit': () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }) }));
    renderAt('/system/audit');
    expect(await screen.findByText("Couldn't load the audit log")).toBeTruthy();
  });
});
