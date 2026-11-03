import { DEFAULT_PLAYER_PATH, PlayerHost, PortalPath, addressClash, type PublicPlayerAddress, type PublicPortalSettings } from '@arclight/shared';
import { Button, FormRow, FormSection, Toggle } from '../../../arclight/index.js';
import { useRequestsSettings } from '../../../hooks/requests.js';
import { t } from '../../../i18n/index.js';
import { AddRow } from '../requests/approval-policies.js';
import '../requests/requests-settings.css';

// Settings → Player → Player address: extra paths (besides the built-in /player) and hostnames
// that show the player at their root, each optionally "Player only". Mirrors the request
// portal's address (Settings → Requests → Public portal); a path or hostname belongs to one of
// them only, so the add rows refuse what the portal already uses (the server checks again).

type PortalAddress = Pick<PublicPortalSettings, 'paths' | 'hosts'>;
export type CheckResult<K extends string> = ({ ok: true } & Record<K, string>) | { ok: false; error: string };

/** A player path typed by the admin → the stored form, or the reason it is refused. */
export function checkPlayerPath(raw: string, existing: readonly string[], portal: PortalAddress | undefined): CheckResult<'path'> {
  const parsed = PortalPath.safeParse(raw);
  if (!parsed.success) {
    const reserved = parsed.error.issues.some((i) => i.message.includes('used by Arclight'));
    return { ok: false, error: reserved ? t('player.settings.address.reserved') : t('player.settings.address.invalid') };
  }
  if (parsed.data === DEFAULT_PLAYER_PATH || existing.includes(parsed.data)) return { ok: false, error: t('player.settings.address.duplicate') };
  if (portal && addressClash(portal, { paths: [parsed.data], hosts: [] }).length) return { ok: false, error: t('player.settings.address.clashPortal') };
  return { ok: true, path: parsed.data };
}

/** A player hostname typed by the admin (a pasted URL is reduced to its hostname). */
export function checkPlayerHost(raw: string, existing: readonly string[], portal: PortalAddress | undefined): CheckResult<'hostname'> {
  let value = raw.trim().toLowerCase();
  if (/^[a-z]+:\/\//.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      // keep the raw value; the check below explains what is wrong
    }
  }
  const parsed = PlayerHost.safeParse({ hostname: value.replace(/\.+$/, '') });
  if (!parsed.success) return { ok: false, error: t('player.settings.address.invalid') };
  if (existing.includes(parsed.data.hostname)) return { ok: false, error: t('player.settings.address.duplicate') };
  if (portal && addressClash(portal, { paths: [], hosts: [parsed.data] }).length) return { ok: false, error: t('player.settings.address.clashPortal') };
  return { ok: true, hostname: parsed.data.hostname };
}

/** The page's own scheme for a hostname link (https outside a browser). */
function hostHref(hostname: string): string {
  const scheme = typeof location === 'undefined' ? 'https:' : location.protocol;
  return `${scheme}//${hostname}/`;
}

function OpenLink({ href }: { href: string }) {
  return (
    <a className="mk-action-link" href={href} target="_blank" rel="noreferrer noopener">
      {t('player.settings.address.open')}
    </a>
  );
}

export function PlayerAddressSection({ value, onChange }: { value: PublicPlayerAddress; onChange: (v: PublicPlayerAddress) => void }) {
  const portal = useRequestsSettings().data?.publicPortal;
  return (
    <FormSection label={t('player.settings.address.title')}>
      <p className="al-caption" style={{ margin: 0 }}>
        {t('player.settings.address.desc')}
      </p>
      <FormRow label={t('player.settings.address.paths')}>
        <div className="al-editor-stack" style={{ gap: 8 }}>
          <ul className="al-order-list" aria-label={t('player.settings.address.paths')}>
            <li className="al-portal-row">
              <span className="al-num">{DEFAULT_PLAYER_PATH}</span>
              <span className="al-caption">{t('player.settings.address.builtIn')}</span>
              <OpenLink href={DEFAULT_PLAYER_PATH} />
            </li>
            {value.paths.map((path) => (
              <li key={path} className="al-portal-row">
                <span className="al-num">{path}</span>
                <OpenLink href={path} />
                <Button size="sm" variant="danger" aria-label={`${t('common.remove')} ${path}`} onClick={() => onChange({ ...value, paths: value.paths.filter((p) => p !== path) })}>
                  {t('common.remove')}
                </Button>
              </li>
            ))}
          </ul>
          {value.paths.length < 20 ? (
            <AddRow
              label={t('player.settings.address.addPath')}
              placeholder="/watch"
              onAdd={(raw) => {
                const r = checkPlayerPath(raw, value.paths, portal);
                if (!r.ok) return r.error;
                onChange({ ...value, paths: [...value.paths, r.path] });
                return null;
              }}
            />
          ) : null}
        </div>
      </FormRow>
      <FormRow label={t('player.settings.address.hosts')} caption={t('player.settings.address.playerOnlyDesc')}>
        <div className="al-editor-stack" style={{ gap: 8 }}>
          {value.hosts.length > 0 ? (
            <ul className="al-order-list" aria-label={t('player.settings.address.hosts')}>
              {value.hosts.map((h) => (
                <li key={h.hostname} className="al-portal-row">
                  <span className="al-num">{h.hostname}</span>
                  <span className="al-portal-row__toggle">
                    <Toggle
                      aria-label={`${t('player.settings.address.playerOnly')} ${h.hostname}`}
                      checked={h.playerOnly}
                      onChange={(e) => {
                        const playerOnly = e.currentTarget.checked;
                        onChange({ ...value, hosts: value.hosts.map((x) => (x.hostname === h.hostname ? { ...x, playerOnly } : x)) });
                      }}
                    />
                    <span className="al-caption">{t('player.settings.address.playerOnly')}</span>
                  </span>
                  <OpenLink href={hostHref(h.hostname)} />
                  <Button size="sm" variant="danger" aria-label={`${t('common.remove')} ${h.hostname}`} onClick={() => onChange({ ...value, hosts: value.hosts.filter((x) => x.hostname !== h.hostname) })}>
                    {t('common.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {value.hosts.length < 20 ? (
            <AddRow
              label={t('player.settings.address.addHost')}
              placeholder="watch.example.com"
              onAdd={(raw) => {
                const r = checkPlayerHost(raw, value.hosts.map((h) => h.hostname), portal);
                if (!r.ok) return r.error;
                onChange({ ...value, hosts: [...value.hosts, { hostname: r.hostname, playerOnly: true }] });
                return null;
              }}
            />
          ) : null}
          <p className="al-caption" style={{ margin: 0 }}>
            {t('player.settings.address.hostsHelp')}
          </p>
        </div>
      </FormRow>
    </FormSection>
  );
}
