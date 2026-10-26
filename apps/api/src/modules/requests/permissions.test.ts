import { describe, expect, it } from 'vitest';
import { hasAnyPermission, Permission as P } from '@arclight/shared';
import { canAutoApprove, canAutoRequest, canRequest, canViewAllRequests, effectivePermissions, isQuotaExempt } from './permissions.js';

describe('permission checks', () => {
  it('ADMIN passes everything and an empty list always passes', () => {
    expect(hasAnyPermission(P.ADMIN, [P.MANAGE_ISSUES])).toBe(true);
    expect(hasAnyPermission(0, [])).toBe(true);
    expect(hasAnyPermission(P.REQUEST, [P.MANAGE_REQUESTS])).toBe(false);
  });

  it('REQUEST covers both media types; the per-type flags cover one', () => {
    expect(canRequest(P.REQUEST, 'movie', false)).toBe(true);
    expect(canRequest(P.REQUEST, 'series', false)).toBe(true);
    expect(canRequest(P.REQUEST_MOVIE, 'movie', false)).toBe(true);
    expect(canRequest(P.REQUEST_MOVIE, 'series', false)).toBe(false);
    expect(canRequest(P.REQUEST_TV, 'series', false)).toBe(true);
  });

  it('4K requests need the 4K flags; REQUEST alone is not enough', () => {
    expect(canRequest(P.REQUEST, 'movie', true)).toBe(false);
    expect(canRequest(P.REQUEST_4K, 'series', true)).toBe(true);
    expect(canRequest(P.REQUEST_4K_MOVIE, 'movie', true)).toBe(true);
    expect(canRequest(P.REQUEST_4K_MOVIE, 'series', true)).toBe(false);
  });

  it('auto-approve flags do not cross between the 4K and normal tracks', () => {
    expect(canAutoApprove(P.AUTO_APPROVE, 'movie', false)).toBe(true);
    expect(canAutoApprove(P.AUTO_APPROVE, 'movie', true)).toBe(false);
    expect(canAutoApprove(P.AUTO_APPROVE_4K, 'movie', false)).toBe(false);
    expect(canAutoApprove(P.AUTO_APPROVE_TV, 'movie', false)).toBe(false);
    expect(canAutoApprove(P.AUTO_APPROVE_4K_TV, 'series', true)).toBe(true);
  });

  it('MANAGE_REQUESTS auto-approves both tracks and sees every request', () => {
    expect(canAutoApprove(P.MANAGE_REQUESTS, 'series', true)).toBe(true);
    expect(canAutoApprove(P.MANAGE_REQUESTS, 'movie', false)).toBe(true);
    expect(canViewAllRequests(P.MANAGE_REQUESTS)).toBe(true);
    expect(canViewAllRequests(P.REQUEST_VIEW)).toBe(true);
    expect(canViewAllRequests(P.REQUEST)).toBe(false);
  });

  it('MANAGE_USERS is quota exempt; MANAGE_REQUESTS alone is not', () => {
    expect(isQuotaExempt(P.MANAGE_USERS)).toBe(true);
    expect(isQuotaExempt(P.MANAGE_REQUESTS)).toBe(false);
    expect(isQuotaExempt(P.ADMIN)).toBe(true);
  });

  it('auto-request follows the AUTO_REQUEST family', () => {
    expect(canAutoRequest(P.AUTO_REQUEST, 'series')).toBe(true);
    expect(canAutoRequest(P.AUTO_REQUEST_MOVIE, 'series')).toBe(false);
    expect(canAutoRequest(P.AUTO_REQUEST_TV, 'series')).toBe(true);
  });

  it('the role decides the ADMIN bit', () => {
    expect(effectivePermissions({ role: 'admin', permissions: P.REQUEST })).toBe(P.REQUEST | P.ADMIN);
    expect(effectivePermissions({ role: 'user', permissions: P.ADMIN | P.REQUEST })).toBe(P.REQUEST);
  });
});
