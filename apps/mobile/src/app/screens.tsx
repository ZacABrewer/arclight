import { useEffect, useState, type FormEvent } from 'react';
import { APP_VERSION, LINKS } from '../config.js';
import { originOf } from '../core/address.js';
import { connect, type ConnectResult } from '../core/probe.js';
import { parsePairingCode } from '../core/qr.js';
import { defaultServerName, type Server } from '../core/servers.js';
import type { PushState } from '../core/push.js';
import { DEFAULT_SETTINGS, LOCK_AFTER_CHOICES, loadSettings, saveSettings, type AppSettings } from '../core/settings.js';
import licenses from '../generated/licenses.json';
import { appBuild, isNative, openExternal, type Runtime } from '../platform/capacitor.js';
import { biometricAvailable, verifyBiometric } from '../platform/handlers.js';
import type { Route } from './route.js';
import { Icon, Mark, Notice, TopBar, haptic } from './ui.js';

interface Nav {
  go: (r: Route) => void;
}
interface WithRuntime extends Nav {
  rt: Runtime;
  connectTo: (s: Server) => Promise<void>;
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// Server list

export function ServerListScreen({ rt, go, connectTo }: WithRuntime) {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');

  const refresh = async () => {
    setServers(await rt.servers.list());
    setSelectedId((await rt.servers.selected())?.id ?? null);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const remove = async (s: Server) => {
    if (!window.confirm(`Remove ${s.name}? You can add it again later.`)) return;
    await rt.servers.remove(s.id);
    await rt.push.unregister(originOf(s.url)).catch(() => undefined);
    void haptic.tap();
    await refresh();
  };

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (renaming) await rt.servers.rename(renaming, name);
    setRenaming(null);
    await refresh();
  };

  return (
    <main className="screen">
      <TopBar
        title="Servers"
        right={
          <button type="button" className="icon-btn" onClick={() => go({ name: 'settings' })} aria-label="Settings">
            <Icon name="settings" />
          </button>
        }
      />
      {servers && servers.length === 0 && <p className="muted">No servers yet. Add the Arclight server you want to use.</p>}
      <ul className="list">
        {servers?.map((s) => (
          <li key={s.id} className={`row${s.id === selectedId ? ' selected' : ''}`}>
            {renaming === s.id ? (
              <form onSubmit={saveName} style={{ display: 'flex', gap: 8, flex: 1 }}>
                <label className="sr-only" htmlFor={`name-${s.id}`}>
                  Server name
                </label>
                <input id={`name-${s.id}`} type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
                <button type="submit" className="btn primary">
                  Save
                </button>
              </form>
            ) : (
              <>
                <button type="button" className="grow" onClick={() => void connectTo(s)}>
                  <div className="title">{s.name}</div>
                  <div className="sub">{s.url}</div>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Rename ${s.name}`}
                  onClick={() => {
                    setRenaming(s.id);
                    setName(s.name);
                  }}
                >
                  <Icon name="edit" />
                </button>
                <button type="button" className="icon-btn" aria-label={`Remove ${s.name}`} onClick={() => void remove(s)}>
                  <Icon name="trash" />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="btn accent block" onClick={() => go({ name: 'add' })}>
        <Icon name="plus" /> Add server
      </button>
      {servers?.some((s) => s.id === selectedId) && <p className="muted small">Tap a server to open it.</p>}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------
// Add / edit server

export function AddServerScreen({ rt, go, connectTo, initialUrl, editId }: WithRuntime & { initialUrl?: string; editId?: string }) {
  const [address, setAddress] = useState(initialUrl ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectResult | null>(null);
  const [editing, setEditing] = useState<Server | null>(null);
  const [hasServers, setHasServers] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setHasServers((await rt.servers.list()).length > 0);
      if (editId) {
        const s = await rt.servers.get(editId);
        if (s) {
          setEditing(s);
          setAddress(s.url);
          setName(s.name);
        }
      }
    })();
  }, [editId]);

  const check = async (value = address) => {
    setBusy(true);
    setResult(null);
    const r = await connect(rt.http, value);
    setBusy(false);
    setResult(r);
    if (r.ok) {
      void haptic.success();
      if (!name.trim() || (editing && name === defaultServerName(editing.url))) setName(defaultServerName(r.url));
    } else void haptic.error();
    return r;
  };

  const save = async () => {
    if (!result?.ok) return;
    let server: Server;
    if (editing) {
      try {
        await rt.servers.updateUrl(editing.id, result.url);
      } catch (err) {
        setResult({ ok: false, reason: 'invalid', message: (err as Error).message, tried: [] });
        return;
      }
      await rt.servers.rename(editing.id, name);
      await rt.servers.select(editing.id);
      server = (await rt.servers.get(editing.id))!;
    } else {
      server = await rt.servers.add(result.url, name);
    }
    await connectTo(server);
  };

  const scan = async () => {
    setScanError(null);
    try {
      // Loaded on demand: the scanner's web fallback (html5-qrcode) is large and rarely needed.
      const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import('@capacitor/barcode-scanner');
      const r = await CapacitorBarcodeScanner.scanBarcode({ hint: CapacitorBarcodeScannerTypeHint.QR_CODE, scanInstructions: 'Point the camera at the pairing code in Arclight → Settings' });
      const url = parsePairingCode(r.ScanResult);
      if (!url) {
        setScanError('That QR code is not an Arclight pairing code.');
        return;
      }
      setAddress(url);
      await check(url);
    } catch (err) {
      const msg = (err as Error)?.message ?? '';
      if (!/cancel/i.test(msg)) setScanError('Could not scan. Allow camera access for Arclight in the system settings, or type the address.');
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (result?.ok) void save();
    else void check();
  };

  return (
    <main className="screen">
      <TopBar title={editing ? 'Edit address' : 'Add your server'} {...(hasServers || editing ? { onBack: () => go({ name: 'servers' }) } : {})} />
      {!hasServers && !editing && (
        <div className="center" style={{ flex: 'none', paddingTop: 8 }}>
          <Mark />
          <p className="muted">Arclight is a remote for your own self-hosted Arclight server. Enter its address, or scan the pairing code from the server's settings.</p>
        </div>
      )}
      <form onSubmit={submit} className="actions" noValidate>
        <label>
          Server address
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="192.168.1.20:7878 or arclight.example.com"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setResult(null);
            }}
            autoFocus={!initialUrl && !editId}
          />
          <span className="hint">An IP address or host name, with or without http(s):// and port. Arclight's default port is 7878.</span>
        </label>

        {result && !result.ok && <Notice kind="error">{result.message}</Notice>}
        {scanError && <Notice kind="error">{scanError}</Notice>}
        {result?.ok && (
          <>
            <Notice kind="ok">
              Found Arclight at <span className="mono">{result.url}</span>.{' '}
              {result.needsSetup ? 'The server still needs its first-time setup; you will be taken there.' : result.needsSignIn ? 'You will sign in on the next screen.' : 'You are already signed in.'}
            </Notice>
            {result.insecure && (
              <Notice kind="warn">
                This connection is not encrypted (plain http:// over the internet). Your password and data can be read by anyone on the network path. Use https:// or a VPN for access from outside your home.
              </Notice>
            )}
            <label>
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Home" />
            </label>
          </>
        )}

        {result?.ok ? (
          <button type="submit" className={result.insecure ? 'btn block' : 'btn accent block'}>
            {result.insecure ? 'Connect anyway' : editing ? 'Save and connect' : 'Add and connect'}
          </button>
        ) : (
          <button type="submit" className="btn accent block" disabled={busy || !address.trim()}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        )}
        {isNative() && !editing && (
          <button type="button" className="btn block" onClick={() => void scan()} disabled={busy}>
            <Icon name="qr" /> Scan pairing code
          </button>
        )}
      </form>
      {busy && (
        <div className="center" style={{ flex: 'none' }}>
          <div className="spinner" role="progressbar" aria-label="Checking the address" />
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------
// Settings, About, Licenses, Lock

export function SettingsScreen({ rt, go }: Nav & { rt: Runtime }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [bio, setBio] = useState<{ available: boolean; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void rt.push.state().then(setPush);
    void loadSettings(rt.kv).then(setSettings);
    void biometricAvailable().then(setBio);
  }, []);

  const update = async (next: AppSettings) => {
    setSettings(next);
    await saveSettings(rt.kv, next);
  };

  const toggleLock = async (on: boolean) => {
    setError(null);
    if (on) {
      if (!bio?.available) {
        setError('Set up Face ID, Touch ID, a fingerprint or a device passcode in the system settings first.');
        return;
      }
      // Confirm it works before turning it on, so nobody locks themselves out.
      if (!(await verifyBiometric('Confirm to turn on the app lock'))) return;
    }
    void haptic.tap();
    await update({ ...settings, biometricLock: on });
  };

  return (
    <main className="screen">
      <TopBar title="Settings" onBack={() => go({ name: 'servers' })} />
      <section className="card actions">
        <h2>Security</h2>
        <label className="toggle">
          <span>
            {bio?.label ?? 'Biometric'} lock
            <br />
            <span className="hint">Ask for {bio?.label ?? 'biometrics'} when Arclight opens.</span>
          </span>
          <input type="checkbox" role="switch" checked={settings.biometricLock} onChange={(e) => void toggleLock(e.target.checked)} />
        </label>
        {settings.biometricLock && (
          <label>
            Lock again after
            <select value={settings.lockAfterMinutes} onChange={(e) => void update({ ...settings, lockAfterMinutes: Number(e.target.value) })}>
              {LOCK_AFTER_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'Immediately' : m === 1 ? '1 minute in the background' : m === 60 ? '1 hour in the background' : `${m} minutes in the background`}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <Notice kind="error">{error}</Notice>}
      </section>
      <section className="card actions">
        <h2>Notifications</h2>
        <p className="hint">Turn notifications on in each server's own settings (your profile → Notifications). The server decides what to send.</p>
        {push ? (
          <>
            <label>
              Push relay device ID
              <span className="hint">Quote this ID to ask for the push registration to be deleted at the relay.</span>
              <input type="text" readOnly value={push.deviceId} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label="Push relay device ID" />
            </label>
            <div className="actions inline">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void navigator.clipboard?.writeText(push.deviceId).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? 'Copied' : 'Copy ID'}
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  if (!window.confirm('Remove the push registration? No server can send notifications to this device until you turn them on again.')) return;
                  await rt.push.unregister(null);
                  void haptic.tap();
                  setPush(null);
                }}
              >
                Remove push registration
              </button>
            </div>
          </>
        ) : (
          <p className="hint">This device is not registered for push notifications.</p>
        )}
      </section>
      <section className="actions">
        <button type="button" className="btn block" onClick={() => go({ name: 'about' })}>
          About Arclight
        </button>
        <button type="button" className="btn block" onClick={() => go({ name: 'licenses' })}>
          Open-source licenses
        </button>
        <button type="button" className="btn ghost block" onClick={() => void openExternal(LINKS.privacy)}>
          Privacy policy
        </button>
        <button type="button" className="btn ghost block" onClick={() => void openExternal(LINKS.support)}>
          Help and support
        </button>
      </section>
    </main>
  );
}

export function AboutScreen({ go }: Nav) {
  const [build, setBuild] = useState('');
  useEffect(() => {
    void appBuild().then(setBuild, () => setBuild(''));
  }, []);
  return (
    <main className="screen">
      <TopBar title="About" onBack={() => go({ name: 'settings' })} />
      <div className="center" style={{ flex: 'none' }}>
        <Mark />
        <h1 className="brand">ARCLIGHT</h1>
        <p className="muted">
          Version {APP_VERSION}
          {build ? ` (${build})` : ''}
        </p>
      </div>
      <section className="card actions">
        <p>Arclight is a companion app for your own, self-hosted Arclight server. It stores only the addresses and names of your servers on this device; everything else lives on your server.</p>
        <p className="small muted">
          This product uses the TMDB API but is not endorsed or certified by TMDB. Movie and TV metadata and artwork shown by your server come from <ExternalLink href={LINKS.tmdb}>The Movie Database (TMDB)</ExternalLink>.
        </p>
        <p className="small muted">
          Free software under the GNU General Public License v3.0. Source code: <ExternalLink href={LINKS.source}>{LINKS.source.replace('https://', '')}</ExternalLink>
        </p>
      </section>
      <div className="actions">
        <button type="button" className="btn block" onClick={() => void openExternal(LINKS.website)}>
          arclight.moviemethat.com
        </button>
        <button type="button" className="btn ghost block" onClick={() => void openExternal(LINKS.privacy)}>
          Privacy policy
        </button>
        <button type="button" className="btn ghost block" onClick={() => void openExternal(LINKS.support)}>
          Support
        </button>
      </div>
    </main>
  );
}

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  repository?: string;
}

export function LicensesScreen({ go }: Nav) {
  const data = licenses as { packages: LicenseEntry[]; native: LicenseEntry[] };
  return (
    <main className="screen">
      <TopBar title="Licenses" onBack={() => go({ name: 'settings' })} />
      <section className="card actions">
        <h2>Arclight</h2>
        <p className="small">
          Copyright 2026 Arclight contributors. This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free
          Software Foundation, version 3 of the License or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see the{' '}
          <ExternalLink href={LINKS.license}>GNU GPL v3.0</ExternalLink> for details. Source: <ExternalLink href={LINKS.source}>GitHub</ExternalLink>.
        </p>
        <p className="small muted">Chakra Petch font: SIL Open Font License 1.1.</p>
      </section>
      <section className="card">
        <h2>JavaScript packages</h2>
        <ul className="list licenses">
          {data.packages.map((p) => (
            <li key={p.name}>
              <div>
                <strong>{p.name}</strong> <span className="muted small">{p.version}</span>
              </div>
              <div className="small muted">
                {p.license}
                {p.repository ? (
                  <>
                    {' · '}
                    <ExternalLink href={p.repository}>source</ExternalLink>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>Native libraries</h2>
        <ul className="list licenses">
          {data.native.map((p) => (
            <li key={p.name}>
              <strong>{p.name}</strong>
              <div className="small muted">{p.license}</div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

export function LockScreen({ onUnlock }: { onUnlock: () => Promise<boolean> }) {
  return (
    <main className="screen">
      <div className="center">
        <Mark />
        <h1>Arclight is locked</h1>
        <button type="button" className="btn accent" onClick={() => void onUnlock()}>
          Unlock
        </button>
      </div>
    </main>
  );
}
