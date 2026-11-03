import { describe, expect, it } from 'vitest';
import { RssListSettings } from './import-lists.js';
import { PushSubscriptionInput } from './push.js';
import { GluetunProviderSettings } from './vpn.js';

// DATA-52: URL settings accept only http(s); push endpoints only https.
describe('URL schemes', () => {
  it('refuses non-http schemes in URL settings', () => {
    expect(RssListSettings.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(RssListSettings.safeParse({ url: 'ftp://lists.example.com/a' }).success).toBe(false);
    expect(RssListSettings.safeParse({ url: 'https://lists.example.com/a' }).success).toBe(true);
    expect(GluetunProviderSettings.safeParse({ type: 'gluetun', controlUrl: 'gopher://x.example' }).success).toBe(false);
  });

  it('requires https push endpoints', () => {
    const keys = { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) };
    expect(PushSubscriptionInput.safeParse({ endpoint: 'http://fcm.googleapis.com/x', keys }).success).toBe(false);
    expect(PushSubscriptionInput.safeParse({ endpoint: 'https://fcm.googleapis.com/x', keys }).success).toBe(true);
  });
});
