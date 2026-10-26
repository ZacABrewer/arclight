import { useId, useState, type ReactNode } from 'react';
import type { Indexer, TrackerAccountSettings, TrackerAccountSettingsInput } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, FormSection, Input, Skeleton, Tabs, Textarea, Toggle } from '../../../arclight/index.js';
import { useSaveTrackerAccount, useTrackerAccount } from '../../../hooks/tracker-stats.js';
import { SaveError } from '../shared.js';
import { t } from '../../../i18n/index.js';

// "Tracker account" tab of the indexer editors (private-tracker helpers): ratio requirement,
// hit-and-run rule, freeleech-only mode, buffer tracking and account-page scraping, saved
// through GET/PUT /indexer/:id/tracker independently of the indexer itself.

const GIB = 1024 ** 3;

/** Number inputs stay text so they can be empty (= not set). */
export interface TrackerDraft {
  enabled: boolean;
  ratioRequired: string;
  minSeedHours: string;
  minRatio: string;
  freeleechOnly: boolean;
  bufferTracking: boolean;
  /** GiB. */
  minBuffer: string;
  /** One host per line (commas also split). */
  announceHosts: string;
  scrapeAccount: boolean;
}

const numText = (n: number | undefined) => (n === undefined ? '' : String(n));

export function toTrackerDraft(s: TrackerAccountSettings): TrackerDraft {
  return {
    enabled: s.enabled,
    ratioRequired: numText(s.ratioRequired),
    minSeedHours: numText(s.hnrRule.minSeedHours),
    minRatio: numText(s.hnrRule.minRatio),
    freeleechOnly: s.freeleechOnly,
    bufferTracking: s.bufferTracking,
    minBuffer: s.minBufferBytes === undefined ? '' : String(Math.round((s.minBufferBytes / GIB) * 100) / 100),
    announceHosts: s.announceHosts.join('\n'),
    scrapeAccount: s.scrapeAccount,
  };
}

function optionalNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** "Tracker.Example, other.example\n" -> ["tracker.example", "other.example"] (deduplicated). */
export function parseHosts(text: string): string[] {
  const hosts = text
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(hosts)];
}

/** Draft -> PUT body: empty numbers are left out (not set), the buffer goes back to bytes. */
export function toTrackerBody(d: TrackerDraft): TrackerAccountSettingsInput {
  const hnrRule: TrackerAccountSettingsInput['hnrRule'] = {};
  const minSeedHours = optionalNumber(d.minSeedHours);
  const minRatio = optionalNumber(d.minRatio);
  if (minSeedHours !== undefined) hnrRule.minSeedHours = minSeedHours;
  if (minRatio !== undefined) hnrRule.minRatio = minRatio;
  const body: TrackerAccountSettingsInput = {
    enabled: d.enabled,
    hnrRule,
    freeleechOnly: d.freeleechOnly,
    bufferTracking: d.bufferTracking,
    announceHosts: parseHosts(d.announceHosts),
    scrapeAccount: d.scrapeAccount,
  };
  const ratioRequired = optionalNumber(d.ratioRequired);
  if (ratioRequired !== undefined) body.ratioRequired = ratioRequired;
  const minBuffer = optionalNumber(d.minBuffer);
  if (minBuffer !== undefined) body.minBufferBytes = Math.round(minBuffer * GIB);
  return body;
}

/**
 * Whether a definition declares an `account` block. The definition contract does not carry
 * that yet, so this reads an `account` / `hasAccount` field when present and answers
 * undefined (unknown) otherwise.
 */
export function definitionHasAccount(def: object | undefined): boolean | undefined {
  if (!def) return undefined;
  const d = def as { account?: unknown; hasAccount?: unknown };
  if ('hasAccount' in d) return Boolean(d.hasAccount);
  if ('account' in d) return Boolean(d.account);
  return undefined;
}

/** Show the account-page switch: only for definition indexers whose definition may have one. */
export function showScrapeAccount(indexer: Pick<Indexer, 'implementation'>, def: object | undefined): boolean {
  if (indexer.implementation !== 'definition') return false;
  return definitionHasAccount(def) ?? true;
}

function NumberRow({ label, caption, unit, value, step, onChange }: { label: string; caption?: string; unit?: string; value: string; step?: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={caption}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        mono
        className="al-input--num"
        min={0}
        step={step}
        end={unit}
        placeholder={t('settings.indexers.trackerAccount.notSet')}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </FormRow>
  );
}

function SwitchRow({ label, caption, checked, onChange }: { label: string; caption: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <FormRow label={label} caption={caption} captionInline>
      <Toggle aria-label={label} checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    </FormRow>
  );
}

function TrackerAccountForm({ indexerId, saved, scrape }: { indexerId: number; saved: TrackerAccountSettings; scrape: boolean }) {
  const savedKey = JSON.stringify(saved);
  const [state, setState] = useState<{ key: string; draft: TrackerDraft }>({ key: savedKey, draft: toTrackerDraft(saved) });
  const d = state.key === savedKey ? state.draft : toTrackerDraft(saved);
  const set = <K extends keyof TrackerDraft>(k: K, v: TrackerDraft[K]) => setState({ key: savedKey, draft: { ...d, [k]: v } });
  const save = useSaveTrackerAccount(indexerId);
  const hostsId = useId();
  const dirty = JSON.stringify(toTrackerBody(d)) !== JSON.stringify(toTrackerBody(toTrackerDraft(saved)));

  return (
    <form
      aria-label={t('settings.indexers.trackerAccount.title')}
      className="al-tracker-account"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(toTrackerBody(d));
      }}
    >
      <FormSection label={t('settings.indexers.trackerAccount.account')}>
        <SwitchRow label={t('settings.indexers.trackerAccount.enabled')} caption={t('settings.indexers.trackerAccount.enabledCaption')} checked={d.enabled} onChange={(v) => set('enabled', v)} />
        <NumberRow
          label={t('settings.indexers.trackerAccount.ratioRequired')}
          caption={t('settings.indexers.trackerAccount.ratioRequiredCaption')}
          step="0.1"
          value={d.ratioRequired}
          onChange={(v) => set('ratioRequired', v)}
        />
        {scrape ? (
          <SwitchRow
            label={t('settings.indexers.trackerAccount.scrapeAccount')}
            caption={t('settings.indexers.trackerAccount.scrapeAccountCaption')}
            checked={d.scrapeAccount}
            onChange={(v) => set('scrapeAccount', v)}
          />
        ) : null}
      </FormSection>
      <FormSection label={t('settings.indexers.trackerAccount.hitAndRun')}>
        <NumberRow
          label={t('settings.indexers.trackerAccount.minSeedHours')}
          caption={t('settings.indexers.trackerAccount.minSeedHoursCaption')}
          unit="h"
          value={d.minSeedHours}
          onChange={(v) => set('minSeedHours', v)}
        />
        <NumberRow
          label={t('settings.indexers.trackerAccount.minRatio')}
          caption={t('settings.indexers.trackerAccount.minRatioCaption')}
          step="0.1"
          value={d.minRatio}
          onChange={(v) => set('minRatio', v)}
        />
      </FormSection>
      <FormSection label={t('settings.indexers.trackerAccount.releasesAndBuffer')}>
        <SwitchRow
          label={t('settings.indexers.trackerAccount.freeleechOnly')}
          caption={t('settings.indexers.trackerAccount.freeleechOnlyCaption')}
          checked={d.freeleechOnly}
          onChange={(v) => set('freeleechOnly', v)}
        />
        <SwitchRow
          label={t('settings.indexers.trackerAccount.bufferTracking')}
          caption={t('settings.indexers.trackerAccount.bufferTrackingCaption')}
          checked={d.bufferTracking}
          onChange={(v) => set('bufferTracking', v)}
        />
        <NumberRow
          label={t('settings.indexers.trackerAccount.minBuffer')}
          caption={t('settings.indexers.trackerAccount.minBufferCaption')}
          unit="GiB"
          step="0.5"
          value={d.minBuffer}
          onChange={(v) => set('minBuffer', v)}
        />
        <FormRow label={t('settings.indexers.trackerAccount.announceHosts')} htmlFor={hostsId} caption={t('settings.indexers.trackerAccount.announceHostsCaption')}>
          <Textarea id={hostsId} mono rows={3} value={d.announceHosts} onChange={(e) => set('announceHosts', e.currentTarget.value)} />
        </FormRow>
      </FormSection>
      <SaveError error={save.error} />
      <div>
        <Button type="submit" variant="secondary" disabled={!dirty} loading={save.isPending}>
          {t('settings.indexers.trackerAccount.save')}
        </Button>
      </div>
    </form>
  );
}

/** The tracker account panel: loads the account settings of one saved torrent indexer. */
export function TrackerAccountPanel({ indexerId, scrape }: { indexerId: number; scrape: boolean }) {
  const account = useTrackerAccount(indexerId);
  if (account.isPending) return <Skeleton lines={5} />;
  if (account.isError)
    return (
      <ErrorBlock title={t('settings.indexers.trackerAccount.couldntLoad')} onRetry={() => void account.refetch()}>
        {errorMessage(account.error)}
      </ErrorBlock>
    );
  return <TrackerAccountForm indexerId={indexerId} saved={account.data} scrape={scrape} />;
}

/**
 * Editor body: the indexer settings alone, or Settings / Tracker account tabs for a saved
 * torrent indexer (the tracker endpoints answer 400 for usenet indexers).
 */
export function IndexerEditorTabs({ indexer, def, children }: { indexer: Indexer | null; def?: object | undefined; children: ReactNode }) {
  if (!indexer || indexer.protocol !== 'torrent') return <>{children}</>;
  return (
    <Tabs
      aria-label={t('settings.indexers.trackerAccount.editorSections')}
      tabs={[
        { id: 'settings', label: t('settings.indexers.trackerAccount.settingsTab'), content: children },
        { id: 'tracker', label: t('settings.indexers.trackerAccount.title'), content: <TrackerAccountPanel indexerId={indexer.id} scrape={showScrapeAccount(indexer, def)} /> },
      ]}
    />
  );
}
