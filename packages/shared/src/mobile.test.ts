import { describe, expect, it } from 'vitest';
import { MobileDeviceInput, MobileDeviceListQuery, MobileDeviceResource, mobilePairingUri } from './mobile.js';

describe('mobile contracts', () => {
  it('builds the pairing URI the app understands', () => {
    expect(mobilePairingUri('https://arclight.example.com:8443/base')).toBe('arclight-admin://pair?url=https%3A%2F%2Farclight.example.com%3A8443%2Fbase');
  });

  it('validates the registerPush() result', () => {
    const ok = MobileDeviceInput.parse({ relayDeviceId: ' d1 ', relaySecret: 'x'.repeat(16), platform: 'android' });
    expect(ok).toEqual({ relayDeviceId: 'd1', relaySecret: 'x'.repeat(16), platform: 'android', deviceName: '' });
    expect(MobileDeviceInput.safeParse({ relayDeviceId: 'd', relaySecret: 'short', platform: 'ios' }).success).toBe(false);
    expect(MobileDeviceInput.parse({ relayDeviceId: 'd', relaySecret: 'x'.repeat(16), platform: 'ios', appId: 'com.moviemethat.arclight.admin' }).appId).toBe('com.moviemethat.arclight.admin');
    expect(MobileDeviceInput.safeParse({ relayDeviceId: 'd', relaySecret: 'x'.repeat(16), platform: 'ios', appId: 'not an id' }).success).toBe(false);
    expect(MobileDeviceInput.safeParse({ relayDeviceId: 'd', relaySecret: 'x'.repeat(16), platform: 'web' }).success).toBe(false);
  });

  it('has no relay secret in the resource and parses ?all', () => {
    expect(Object.keys(MobileDeviceResource.shape)).not.toContain('relaySecret');
    expect(MobileDeviceListQuery.parse({ all: 'true' })).toEqual({ all: true });
    expect(MobileDeviceListQuery.parse({})).toEqual({ all: false });
  });
});
