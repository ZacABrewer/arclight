import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../db/test-utils.js';
import { downloadClients, indexers } from '../../db/schema.js';
import { buildDocument, importDocument } from './engine.js';
import { parseConfigText } from './overlay.js';

// Keeps the full example in docs/OPERATIONS.md honest: it must import into an empty database.

const DOC = fileURLToPath(new URL('../../../../../docs/OPERATIONS.md', import.meta.url));

function example(): unknown {
  const text = readFileSync(DOC, 'utf8');
  const block = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => b.startsWith('version: 1'));
  if (!block) throw new Error('no full example in OPERATIONS.md');
  return parseConfigText(block);
}

describe('docs/OPERATIONS.md example', () => {
  it('imports cleanly into an empty database and is then idempotent', async () => {
    const db = await createTestDb();
    const out = importDocument(db, example());
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.applied).toBe(true);
    const proxied = db.select().from(indexers).all().find((i) => i.name === 'Torznab via proxy')!;
    expect(proxied.downloadClientId).toBe(db.select().from(downloadClients).get()!.id);
    expect(importDocument(db, example()).changes).toEqual([]);
    expect(importDocument(db, buildDocument(db)).changes).toEqual([]);
  });

  it('implementation checks: wrong protocol is an error, bad client settings a warning', async () => {
    const out = importDocument(await createTestDb(), {
      downloadClients: {
        A: { implementation: 'qbittorrent', protocol: 'usenet', settings: { host: 'q', port: 8080, useSsl: false, username: '', password: '', category: 'x' } },
        B: { implementation: 'sabnzbd', protocol: 'usenet', settings: { host: 'sab', port: 'not-a-port' } },
      },
    });
    expect(out.errors).toEqual([{ path: 'downloadClients.A.protocol', message: 'qbittorrent downloads torrent' }]);
    expect(out.warnings.map((w) => w.path)).toEqual(['downloadClients.B.settings']);
  });
});
