import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { pickerRedirect } from './router';

describe('pickerRedirect', () => {
  const services = { qc: new QueryClient() };

  it("sends the first /player page to Who's watching? when the picker is due", async () => {
    const check = vi.fn(async () => true);
    expect(await pickerRedirect(services, 'acc', check)).toEqual({ to: '/profiles' });
    expect(check).toHaveBeenCalledWith(services.qc, 'acc');
  });

  it('lets the page load otherwise', async () => {
    expect(await pickerRedirect(services, 'acc', async () => false)).toBeNull();
  });
});
