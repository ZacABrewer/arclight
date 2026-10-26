import { describe, expect, it } from 'vitest';
import { MediaServerSettings } from '@arclight/shared';
import { settings } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { getSection, setSection } from '../settings/service.js';
import { mediaServerView, migrateLegacyMediaServer, saveMediaServerView } from './legacy.js';

const ids = () => {
  let n = 0;
  return () => `srv${++n}`;
};

describe('legacy mediaServer view over the media servers list', () => {
  it('moves a stored legacy value into the list once and removes the legacy row', async () => {
    const db = await createTestDb();
    setSection(db, 'mediaServer', MediaServerSettings.parse({ kind: 'jellyfin', url: 'http://jf.lan:8096/', apiKey: 'k', createUsersOnLogin: false }));
    setSection(db, 'mediaServers', {
      servers: [{ id: 'old', kind: 'plex', name: 'Plex', url: 'http://plex:32400', apiKey: 'p', enabled: true, usedForAvailability: false, usedForRetention: true, usedForRefresh: false, loginEnabled: false, createUsersOnLogin: false }],
    });
    expect(migrateLegacyMediaServer(db, ids())).toBe(true);
    const servers = getSection(db, 'mediaServers').servers;
    expect(servers.map((s) => s.id)).toEqual(['srv1', 'old']);
    expect(servers[0]).toMatchObject({ kind: 'jellyfin', name: 'Jellyfin', url: 'http://jf.lan:8096', loginEnabled: true, createUsersOnLogin: false, usedForAvailability: true });
    expect(db.select().from(settings).all().some((r) => r.key === 'mediaServer')).toBe(false);
    expect(migrateLegacyMediaServer(db, ids())).toBe(false);
    expect(getSection(db, 'mediaServers').servers).toHaveLength(2);
    expect(mediaServerView(db)).toMatchObject({ kind: 'jellyfin', apiKey: 'k', loginEnabled: true });
  });

  it('reuses a list entry with the same kind and URL', async () => {
    const db = await createTestDb();
    setSection(db, 'mediaServers', {
      servers: [{ id: 'a', kind: 'emby', name: 'Den', url: 'http://emby:8096', apiKey: 'e', enabled: true, usedForAvailability: true, usedForRetention: true, usedForRefresh: false, loginEnabled: false, createUsersOnLogin: false }],
    });
    setSection(db, 'mediaServer', MediaServerSettings.parse({ kind: 'emby', url: 'http://emby:8096', apiKey: 'e' }));
    migrateLegacyMediaServer(db, ids());
    expect(getSection(db, 'mediaServers').servers).toEqual([expect.objectContaining({ id: 'a', loginEnabled: true, createUsersOnLogin: true, usedForRetention: true })]);
  });

  it('the view prefers the first login-enabled server; saving updates it in place and keeps purpose flags', async () => {
    const db = await createTestDb();
    setSection(db, 'mediaServers', {
      servers: [
        { id: 'a', kind: 'plex', name: 'Plex', url: 'http://plex', apiKey: 'p', enabled: true, usedForAvailability: true, usedForRetention: false, usedForRefresh: false, loginEnabled: false, createUsersOnLogin: false },
        { id: 'b', kind: 'jellyfin', name: 'JF', url: 'http://jf', apiKey: 'j', enabled: true, usedForAvailability: false, usedForRetention: true, usedForRefresh: true, loginEnabled: true, createUsersOnLogin: true },
      ],
    });
    expect(mediaServerView(db)).toMatchObject({ kind: 'jellyfin', name: 'JF' });
    saveMediaServerView(db, MediaServerSettings.parse({ kind: 'jellyfin', url: 'http://jf2/', apiKey: 'j2', name: 'JF', createUsersOnLogin: false }));
    const b = getSection(db, 'mediaServers').servers.find((s) => s.id === 'b');
    expect(b).toMatchObject({ url: 'http://jf2', apiKey: 'j2', usedForRetention: true, usedForRefresh: true, createUsersOnLogin: false });
    // kind null: login is switched off on a server still used elsewhere (not deleted).
    saveMediaServerView(db, MediaServerSettings.parse({ kind: null }));
    expect(getSection(db, 'mediaServers').servers.find((s) => s.id === 'b')).toMatchObject({ loginEnabled: false });
  });

  it('appends a server when the list is empty and removes it again with kind null', async () => {
    const db = await createTestDb();
    expect(mediaServerView(db).kind).toBeNull();
    saveMediaServerView(db, MediaServerSettings.parse({ kind: 'emby', url: 'http://emby', apiKey: 'e' }), undefined, ids());
    expect(getSection(db, 'mediaServers').servers).toEqual([expect.objectContaining({ id: 'srv1', name: 'Emby', usedForAvailability: true, loginEnabled: true })]);
    saveMediaServerView(db, MediaServerSettings.parse({ kind: null }));
    expect(getSection(db, 'mediaServers').servers).toEqual([]);
  });
});
