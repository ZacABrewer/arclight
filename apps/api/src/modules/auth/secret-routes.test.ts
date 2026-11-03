import { describe, expect, it } from 'vitest';
import { apiKeyScopeAllows } from './hook.js';
import type { RequestAuth } from './service.js';

const key = (scope: 'read' | 'admin') => ({ user: { id: 1 }, via: 'userkey', isAdmin: true, appAccess: [], apiKeyScope: scope }) as unknown as RequestAuth;

describe('folder browser needs an admin-scope key (DATA-46)', () => {
  it.each(['/api/v1/filesystem', '/api/v3/filesystem'])('%s', (route) => {
    expect(apiKeyScopeAllows(key('read'), 'GET', route)).toBe(false);
    expect(apiKeyScopeAllows(key('admin'), 'GET', route)).toBe(true);
  });
});
