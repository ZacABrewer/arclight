import { useId, useState } from 'react';
import type { TorrentDetail, TorrentLimits, TorrentLimitsRequest, TorrentPeer, TorrentWebSeed } from '@arclight/shared';
import { Button, Chip, EmptyState, FormRow, FormSection, Input, Table, Toggle, type Column } from '../../arclight/index.js';
import { useTorrentLimits, useTorrentSuperSeed } from '../../hooks/torrent.js';
import { formatDateTime, formatRate, formatSize } from '../../lib/format.js';
import { t } from '../../i18n/index.js';

// Torrent drawer extras for the built-in engine: per-peer connection badges, the BEP 19 web
// seeds table, and the per-torrent limits / BEP 16 super-seeding controls.

/** Encryption and transport of one peer connection, as two small chips. */
export function PeerConnectionBadges({ peer }: { peer: Pick<TorrentPeer, 'encrypted' | 'transport'> }) {
  if (peer.encrypted === undefined && peer.transport === undefined) return <>—</>;
  return (
    <span className="al-torrent-peer-badges">
      {peer.encrypted !== undefined ? (
        peer.encrypted ? (
          <Chip tone="accent" dot="none">
            {t('activity.torrentDrawer.encrypted')}
          </Chip>
        ) : (
          <Chip tone="muted" dot="none">
            {t('activity.torrentDrawer.plain')}
          </Chip>
        )
      ) : null}
      {peer.transport ? (
        <Chip tone="neutral" dot="none">
          {peer.transport === 'utp' ? 'uTP' : 'TCP'}
        </Chip>
      ) : null}
    </span>
  );
}

const WEB_SEED_COLUMNS: Column<TorrentWebSeed>[] = [
  {
    key: 'url',
    get header() {
      return t('common.url');
    },
    mono: true,
    cell: (w) => (
      <>
        <span className="al-activity-break">{w.url}</span>
        {w.lastError ? <div className="al-activity-muted">{w.lastError}</div> : null}
      </>
    ),
  },
  { key: 'rate', get header() { return t('common.down'); }, mono: true, align: 'right', cell: (w) => formatRate(w.downloadRate) },
  { key: 'downloaded', get header() { return t('activity.torrentDrawer.downloaded'); }, mono: true, align: 'right', cell: (w) => formatSize(w.downloaded) },
  { key: 'requests', get header() { return t('activity.torrentDrawer.requests'); }, mono: true, align: 'right', cell: (w) => w.activeRequests },
  { key: 'failures', get header() { return t('activity.torrentDrawer.failures'); }, mono: true, align: 'right', cell: (w) => w.failures },
  { key: 'retry', get header() { return t('activity.torrentDrawer.retryAt'); }, mono: true, cell: (w) => (w.retryAt ? formatDateTime(w.retryAt) : '—') },
];

export function WebSeeds({ torrent }: { torrent: TorrentDetail }) {
  const seeds = torrent.webSeeds ?? [];
  if (seeds.length === 0) return <EmptyState title={t('activity.torrentDrawer.noWebSeeds')}>{t('activity.torrentDrawer.noWebSeedsHint')}</EmptyState>;
  return <Table caption={t('activity.torrentDrawer.webSeeds')} columns={WEB_SEED_COLUMNS} rows={seeds} rowKey={(w) => w.url} sortable={false} />;
}

// ---- limits ---------------------------------------------------------------------------

export const LIMIT_KEYS = ['downloadLimit', 'uploadLimit', 'peerDownloadLimit', 'peerUploadLimit'] as const;
type LimitKey = (typeof LIMIT_KEYS)[number];

/** Limits are edited in KiB/s like the engine settings; text so a field can be empty (= unlimited). */
export type LimitsDraft = Record<LimitKey, string>;

const EMPTY_LIMITS: TorrentLimits = { uploadLimit: 0, downloadLimit: 0, peerUploadLimit: 0, peerDownloadLimit: 0 };

/** Bytes/s -> KiB/s text; 0 (unlimited) is an empty field. */
export function bytesToKibText(bytes: number): string {
  if (bytes <= 0) return '';
  const kib = bytes / 1024;
  return String(Number.isInteger(kib) ? kib : Math.round(kib * 10) / 10);
}

/** KiB/s text -> bytes/s; empty, 0 or invalid means unlimited (0). */
export function kibTextToBytes(text: string): number {
  const n = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1024);
}

export function toLimitsDraft(limits: TorrentLimits | undefined): LimitsDraft {
  const l = limits ?? EMPTY_LIMITS;
  return {
    downloadLimit: bytesToKibText(l.downloadLimit),
    uploadLimit: bytesToKibText(l.uploadLimit),
    peerDownloadLimit: bytesToKibText(l.peerDownloadLimit),
    peerUploadLimit: bytesToKibText(l.peerUploadLimit),
  };
}

/** Only the limits that differ from the current ones (omitted keys keep their value). */
export function toLimitsRequest(draft: LimitsDraft, current: TorrentLimits | undefined): TorrentLimitsRequest {
  const base = current ?? EMPTY_LIMITS;
  const body: TorrentLimitsRequest = {};
  for (const k of LIMIT_KEYS) {
    const bytes = kibTextToBytes(draft[k]);
    if (bytes !== base[k]) body[k] = bytes;
  }
  return body;
}

const LIMIT_LABELS: Record<LimitKey, () => string> = {
  downloadLimit: () => t('activity.torrentDrawer.downloadLimit'),
  uploadLimit: () => t('activity.torrentDrawer.uploadLimit'),
  peerDownloadLimit: () => t('activity.torrentDrawer.peerDownloadLimit'),
  peerUploadLimit: () => t('activity.torrentDrawer.peerUploadLimit'),
};

function LimitRow({ k, value, onChange }: { k: LimitKey; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <FormRow label={LIMIT_LABELS[k]()} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        mono
        className="al-input--num"
        end="KiB/s"
        min={0}
        placeholder={t('activity.torrentDrawer.unlimited')}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </FormRow>
  );
}

/** Per-torrent limits editor plus the super-seeding switch. */
export function LimitsPanel({ torrent }: { torrent: TorrentDetail }) {
  const limits = useTorrentLimits(torrent.id);
  const superSeed = useTorrentSuperSeed(torrent.id);
  const savedKey = JSON.stringify(torrent.limits ?? null);
  const [draft, setDraft] = useState<{ key: string; value: LimitsDraft }>({ key: savedKey, value: toLimitsDraft(torrent.limits) });
  // A refetch with new saved limits resets the form (the 3 s poll keeps the same values).
  const value = draft.key === savedKey ? draft.value : toLimitsDraft(torrent.limits);
  const body = toLimitsRequest(value, torrent.limits);
  const dirty = Object.keys(body).length > 0;
  const superSeeding = superSeed.isPending && superSeed.variables !== undefined ? superSeed.variables : (torrent.superSeeding ?? false);

  return (
    <form
      aria-label={t('activity.torrentDrawer.torrentLimits')}
      className="al-torrent-limits"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) limits.mutate(body);
      }}
    >
      <FormSection label={t('activity.torrentDrawer.rateLimits')}>
        {LIMIT_KEYS.map((k) => (
          <LimitRow key={k} k={k} value={value[k]} onChange={(v) => setDraft({ key: savedKey, value: { ...value, [k]: v } })} />
        ))}
        <p className="al-caption">{t('activity.torrentDrawer.limitsCaption')}</p>
        <div>
          <Button type="submit" variant="secondary" size="sm" disabled={!dirty} loading={limits.isPending}>
            {t('activity.torrentDrawer.saveLimits')}
          </Button>
        </div>
      </FormSection>
      <FormSection label={t('activity.torrentDrawer.seeding')}>
        <FormRow label={t('activity.torrentDrawer.superSeeding')} caption={t('activity.torrentDrawer.superSeedingCaption')} captionInline>
          <Toggle
            aria-label={t('activity.torrentDrawer.superSeeding')}
            checked={superSeeding}
            disabled={superSeed.isPending}
            onChange={(e) => superSeed.mutate(e.currentTarget.checked)}
          />
        </FormRow>
      </FormSection>
    </form>
  );
}
