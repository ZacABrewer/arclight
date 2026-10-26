import { useId, useState } from 'react';
import type {
  SeedingRule,
  SeedingRuleAction,
  SeedingRuleInput,
  SpeedScheduleRange,
  TorrentSpeedSettings,
  TorrentSpeedSettingsUpdate,
} from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, ButtonGroup, Checkbox, EmptyState, ErrorBlock, FormRow, FormSection, Input, Pane, Segmented, Select, Skeleton, Toggle } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { useIndexerList } from '../../hooks/indexers.js';
import { useApplySeedingRules, useSaveSeedingRules, useSaveTorrentSpeedSettings, useSeedingRules, useTorrentSpeedSettings } from '../../hooks/torrent.js';
import { t, weekdayNames } from '../../i18n/index.js';

// Settings -> Torrent engine, below the engine form: the alternative ("slow mode") limits with
// their weekly schedule, and the seeding rules list. Each pane saves its own settings section.

// ---- speed schedule ---------------------------------------------------------------------------

export interface SpeedDraft {
  altDownloadLimitKbps: string;
  altUploadLimitKbps: string;
  scheduleEnabled: boolean;
  mirrorToQbittorrent: boolean;
  schedule: SpeedScheduleRange[];
}

export function toSpeedDraft(s: TorrentSpeedSettings): SpeedDraft {
  return {
    altDownloadLimitKbps: String(s.altDownloadLimitKbps),
    altUploadLimitKbps: String(s.altUploadLimitKbps),
    scheduleEnabled: s.scheduleEnabled,
    mirrorToQbittorrent: s.mirrorToQbittorrent,
    schedule: s.schedule.map((r) => ({ ...r, days: [...r.days] })),
  };
}

const kbps = (text: string): number => {
  const n = Math.round(Number(text.trim()));
  return text.trim() === '' || !Number.isFinite(n) || n < 0 ? 0 : n;
};

/** Draft -> PUT body; empty limits mean unlimited (0); windows without days are dropped. */
export function toSpeedUpdate(d: SpeedDraft): TorrentSpeedSettingsUpdate {
  return {
    altDownloadLimitKbps: kbps(d.altDownloadLimitKbps),
    altUploadLimitKbps: kbps(d.altUploadLimitKbps),
    scheduleEnabled: d.scheduleEnabled,
    mirrorToQbittorrent: d.mirrorToQbittorrent,
    schedule: d.schedule.filter((r) => r.days.length > 0).map((r) => ({ ...r, days: [...r.days].sort((a, b) => a - b) })),
  };
}

const NEW_WINDOW: SpeedScheduleRange = { days: [1, 2, 3, 4, 5], start: '08:00', end: '23:00' };

function KbpsRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={t('settings.torrent.n0Unlimited')}>
      <Input id={id} type="number" inputMode="numeric" mono className="al-input--num" end="KiB/s" min={0} value={value} onChange={(e) => onChange(e.currentTarget.value)} />
    </FormRow>
  );
}

function WindowRow({ range, index, onChange, onRemove }: { range: SpeedScheduleRange; index: number; onChange: (r: SpeedScheduleRange) => void; onRemove: () => void }) {
  const short = weekdayNames(0, 'short');
  const long = weekdayNames(0, 'long');
  const startId = useId();
  const endId = useId();
  const toggleDay = (d: number) => onChange({ ...range, days: range.days.includes(d) ? range.days.filter((x) => x !== d) : [...range.days, d] });
  return (
    <div className="al-speed-window" role="group" aria-label={t('settings.torrentControl.windowN', { n: index + 1 })}>
      <div className="al-speed-window__days">
        {short.map((label, d) => (
          <button
            key={d}
            type="button"
            className="al-speed-day"
            aria-pressed={range.days.includes(d)}
            aria-label={long[d]}
            onClick={() => toggleDay(d)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="al-speed-window__time" htmlFor={startId}>
        <span className="al-caption">{t('settings.torrentControl.from')}</span>
        <Input id={startId} type="time" mono value={range.start} onChange={(e) => onChange({ ...range, start: e.currentTarget.value })} />
      </label>
      <label className="al-speed-window__time" htmlFor={endId}>
        <span className="al-caption">{t('settings.torrentControl.to')}</span>
        <Input id={endId} type="time" mono value={range.end} onChange={(e) => onChange({ ...range, end: e.currentTarget.value })} />
      </label>
      <Button size="sm" variant="ghost" onClick={onRemove} aria-label={t('settings.torrentControl.removeWindowN', { n: index + 1 })}>
        {t('common.remove')}
      </Button>
    </div>
  );
}

function SpeedForm({ saved }: { saved: TorrentSpeedSettings }) {
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState({ key: savedKey, value: toSpeedDraft(saved) });
  const d = draft.key === savedKey ? draft.value : toSpeedDraft(saved);
  const set = (patch: Partial<SpeedDraft>) => setDraft({ key: savedKey, value: { ...d, ...patch } });
  const save = useSaveTorrentSpeedSettings();
  const dirty = JSON.stringify(toSpeedUpdate(d)) !== JSON.stringify(toSpeedUpdate(toSpeedDraft(saved)));
  return (
    <form
      aria-label={t('settings.torrentControl.speedSchedule')}
      className="al-torrent-control"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(toSpeedUpdate(d));
      }}
    >
      <FormSection label={t('settings.torrentControl.alternativeLimits')}>
        <KbpsRow label={t('settings.torrent.downloadLimit')} value={d.altDownloadLimitKbps} onChange={(v) => set({ altDownloadLimitKbps: v })} />
        <KbpsRow label={t('settings.torrent.uploadLimit')} value={d.altUploadLimitKbps} onChange={(v) => set({ altUploadLimitKbps: v })} />
        <FormRow label={t('settings.torrentControl.mirrorToQbittorrent')} caption={t('settings.torrentControl.mirrorToQbittorrentCaption')} captionInline>
          <Toggle aria-label={t('settings.torrentControl.mirrorToQbittorrent')} checked={d.mirrorToQbittorrent} onChange={(e) => set({ mirrorToQbittorrent: e.currentTarget.checked })} />
        </FormRow>
      </FormSection>
      <FormSection label={t('settings.torrentControl.schedule')}>
        <FormRow label={t('settings.torrentControl.useSchedule')} caption={t('settings.torrentControl.useScheduleCaption')} captionInline>
          <Toggle aria-label={t('settings.torrentControl.useSchedule')} checked={d.scheduleEnabled} onChange={(e) => set({ scheduleEnabled: e.currentTarget.checked })} />
        </FormRow>
        {d.schedule.map((r, i) => (
          <WindowRow
            key={i}
            index={i}
            range={r}
            onChange={(next) => set({ schedule: d.schedule.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => set({ schedule: d.schedule.filter((_, j) => j !== i) })}
          />
        ))}
        {d.schedule.length === 0 ? <p className="al-caption">{t('settings.torrentControl.noWindows')}</p> : null}
        <div>
          <Button size="sm" variant="secondary" onClick={() => set({ schedule: [...d.schedule, { ...NEW_WINDOW, days: [...NEW_WINDOW.days] }] })}>
            {t('settings.torrentControl.addWindow')}
          </Button>
        </div>
      </FormSection>
      <div>
        <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
          {t('settings.torrentControl.saveSpeedSchedule')}
        </Button>
      </div>
    </form>
  );
}

/** Alternative limits, the qBittorrent mirror switch and the weekly schedule. */
export function SpeedSchedulePane() {
  const speed = useTorrentSpeedSettings();
  return (
    <Pane title={t('settings.torrentControl.speedSchedule')} aria-label={t('settings.torrentControl.speedSchedule')}>
      <p className="al-caption al-torrent-control__intro">{t('settings.torrentControl.speedScheduleIntro')}</p>
      {speed.isPending ? (
        <Skeleton lines={4} />
      ) : speed.isError ? (
        <ErrorBlock title={t('settings.torrentControl.couldntLoadSpeedSchedule')} onRetry={() => void speed.refetch()}>
          {errorMessage(speed.error)}
        </ErrorBlock>
      ) : (
        <SpeedForm saved={speed.data} />
      )}
    </Pane>
  );
}

// ---- seeding rules ----------------------------------------------------------------------------

export type SeedTimeUnit = 'hours' | 'days';

export interface RuleDraft {
  id: string;
  name: string;
  enabled: boolean;
  categories: string;
  trackers: string;
  indexerIds: number[];
  ratio: string;
  seedTime: string;
  seedTimeUnit: SeedTimeUnit;
  action: SeedingRuleAction;
  deleteFiles: boolean;
}

const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function toRuleDraft(r: SeedingRule): RuleDraft {
  const minutes = r.seedTimeMinutes;
  const days = minutes !== null && minutes > 0 && minutes % 1440 === 0;
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    categories: r.categories.join(', '),
    trackers: r.trackers.join(', '),
    indexerIds: [...r.indexerIds],
    ratio: r.ratio === null ? '' : String(r.ratio),
    seedTime: minutes === null ? '' : String(days ? minutes / 1440 : Math.round((minutes / 60) * 100) / 100),
    seedTimeUnit: days ? 'days' : 'hours',
    action: r.action,
    deleteFiles: r.deleteFiles,
  };
}

const numberOrNull = (text: string): number | null => {
  const n = Number(text.trim());
  return text.trim() === '' || !Number.isFinite(n) || n < 0 ? null : n;
};

export function fromRuleDraft(d: RuleDraft): SeedingRuleInput {
  const time = numberOrNull(d.seedTime);
  return {
    id: d.id,
    name: d.name.trim(),
    enabled: d.enabled,
    categories: splitList(d.categories),
    trackers: splitList(d.trackers).map((h) => h.toLowerCase()),
    indexerIds: d.indexerIds,
    ratio: numberOrNull(d.ratio),
    seedTimeMinutes: time === null ? null : Math.round(time * (d.seedTimeUnit === 'days' ? 1440 : 60)),
    action: d.action,
    deleteFiles: d.action === 'remove' && d.deleteFiles,
  };
}

/** What is wrong with a rule draft (null when it can be saved). */
export function ruleProblem(d: RuleDraft): string | null {
  if (d.name.trim() === '') return t('settings.torrentControl.ruleNeedsName');
  if (numberOrNull(d.ratio) === null && numberOrNull(d.seedTime) === null) return t('settings.torrentControl.ruleNeedsLimit');
  return null;
}

export function newRuleDraft(id: string = globalThis.crypto.randomUUID()): RuleDraft {
  return {
    id,
    name: '',
    enabled: true,
    categories: '',
    trackers: '',
    indexerIds: [],
    ratio: '2',
    seedTime: '14',
    seedTimeUnit: 'days',
    action: 'pause',
    deleteFiles: false,
  };
}

const ACTION_OPTIONS: { value: SeedingRuleAction; readonly label: string }[] = [
  { value: 'pause', get label() { return t('settings.torrentControl.actionPause'); } },
  { value: 'remove', get label() { return t('settings.torrentControl.actionRemove'); } },
];

const UNIT_OPTIONS: { value: SeedTimeUnit; readonly label: string }[] = [
  { value: 'hours', get label() { return t('settings.torrentControl.hours'); } },
  { value: 'days', get label() { return t('settings.torrentControl.days'); } },
];

function TextRow({ label, caption, value, placeholder, onChange, mono }: { label: string; caption?: string; value: string; placeholder?: string; onChange: (v: string) => void; mono?: boolean }) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={caption}>
      <Input id={id} mono={mono ?? false} value={value} placeholder={placeholder} onChange={(e) => onChange(e.currentTarget.value)} />
    </FormRow>
  );
}

function RuleEditor({
  draft,
  index,
  count,
  indexers,
  onChange,
  onMove,
  onRemove,
}: {
  draft: RuleDraft;
  index: number;
  count: number;
  indexers: { id: number; name: string }[];
  onChange: (patch: Partial<RuleDraft>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const ratioId = useId();
  const timeId = useId();
  const problem = ruleProblem(draft);
  const title = draft.name.trim() || t('settings.torrentControl.ruleN', { n: index + 1 });
  return (
    <section className="al-seed-rule" aria-label={title}>
      <div className="al-seed-rule__head">
        <Toggle size="sm" label={title} checked={draft.enabled} onChange={(e) => onChange({ enabled: e.currentTarget.checked })} />
        <ButtonGroup>
          <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t('settings.torrentControl.moveRuleUp', { name: title })}>
            {t('activity.queueControls.up')}
          </Button>
          <Button size="sm" variant="ghost" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={t('settings.torrentControl.moveRuleDown', { name: title })}>
            {t('activity.queueControls.down')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove} aria-label={t('settings.torrentControl.removeRule', { name: title })}>
            {t('common.remove')}
          </Button>
        </ButtonGroup>
      </div>
      <div className="al-form-grid">
        <TextRow label={t('common.name')} value={draft.name} onChange={(v) => onChange({ name: v })} />
        <TextRow
          label={t('settings.torrentControl.categories')}
          caption={t('settings.torrentControl.categoriesCaption')}
          placeholder="tv, movies"
          mono
          value={draft.categories}
          onChange={(v) => onChange({ categories: v })}
        />
        <TextRow
          label={t('settings.torrentControl.trackers')}
          caption={t('settings.torrentControl.trackersCaption')}
          placeholder="tracker.example.org"
          mono
          value={draft.trackers}
          onChange={(v) => onChange({ trackers: v })}
        />
        {indexers.length > 0 ? (
          <FormRow label={t('settings.torrentControl.indexers')} caption={t('settings.torrentControl.indexersCaption')}>
            <div className="al-seed-rule__indexers">
              {indexers.map((ix) => (
                <Checkbox
                  key={ix.id}
                  label={ix.name}
                  checked={draft.indexerIds.includes(ix.id)}
                  onChange={(e) =>
                    onChange({ indexerIds: e.currentTarget.checked ? [...draft.indexerIds, ix.id] : draft.indexerIds.filter((x) => x !== ix.id) })
                  }
                />
              ))}
            </div>
          </FormRow>
        ) : null}
        <FormRow label={t('settings.torrentControl.ratio')} htmlFor={ratioId} caption={t('settings.torrentControl.ratioCaption')}>
          <Input
            id={ratioId}
            type="number"
            inputMode="decimal"
            mono
            className="al-input--num"
            min={0}
            step="0.1"
            placeholder={t('settings.torrent.unlimited')}
            value={draft.ratio}
            onChange={(e) => onChange({ ratio: e.currentTarget.value })}
          />
        </FormRow>
        <FormRow label={t('settings.torrentControl.seedTime')} htmlFor={timeId} caption={t('settings.torrentControl.seedTimeCaption')}>
          <span className="al-seed-rule__time">
            <Input
              id={timeId}
              type="number"
              inputMode="decimal"
              mono
              className="al-input--num"
              min={0}
              placeholder={t('settings.torrent.unlimited')}
              value={draft.seedTime}
              onChange={(e) => onChange({ seedTime: e.currentTarget.value })}
            />
            <Select
              aria-label={t('settings.torrentControl.seedTimeUnit')}
              value={draft.seedTimeUnit}
              options={UNIT_OPTIONS}
              onChange={(e) => onChange({ seedTimeUnit: e.currentTarget.value as SeedTimeUnit })}
            />
          </span>
        </FormRow>
        <FormRow label={t('settings.torrentControl.then')}>
          <Segmented aria-label={t('settings.torrentControl.then')} variant="soft" options={ACTION_OPTIONS} value={draft.action} onChange={(v) => onChange({ action: v })} />
        </FormRow>
        {draft.action === 'remove' ? (
          <FormRow label={t('settings.torrentControl.deleteFiles')} caption={t('settings.torrentControl.deleteFilesCaption')} captionInline>
            <Toggle aria-label={t('settings.torrentControl.deleteFiles')} checked={draft.deleteFiles} onChange={(e) => onChange({ deleteFiles: e.currentTarget.checked })} />
          </FormRow>
        ) : null}
      </div>
      {problem ? (
        <p className="al-inline-error" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

function RulesForm({ saved }: { saved: SeedingRule[] }) {
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState({ key: savedKey, rules: saved.map(toRuleDraft) });
  const rules = draft.key === savedKey ? draft.rules : saved.map(toRuleDraft);
  const setRules = (next: RuleDraft[]) => setDraft({ key: savedKey, rules: next });
  const indexers = useIndexerList();
  const save = useSaveSeedingRules();
  const apply = useApplySeedingRules();
  const toast = useToast();
  const body = rules.map(fromRuleDraft);
  const dirty = JSON.stringify(body) !== JSON.stringify(saved.map((r) => fromRuleDraft(toRuleDraft(r))));
  const invalid = rules.some((r) => ruleProblem(r) !== null);
  const torrentIndexers = (indexers.data ?? []).filter((ix) => ix.protocol === 'torrent').map((ix) => ({ id: ix.id, name: ix.name }));
  return (
    <form
      aria-label={t('settings.torrentControl.seedingRules')}
      className="al-torrent-control"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) save.mutate({ rules: body });
      }}
    >
      {rules.length === 0 ? <EmptyState title={t('settings.torrentControl.noRules')}>{t('settings.torrentControl.noRulesHint')}</EmptyState> : null}
      {rules.map((r, i) => (
        <RuleEditor
          key={r.id}
          draft={r}
          index={i}
          count={rules.length}
          indexers={torrentIndexers}
          onChange={(patch) => setRules(rules.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
          onMove={(delta) => {
            const next = [...rules];
            const [moved] = next.splice(i, 1);
            next.splice(i + delta, 0, moved!);
            setRules(next);
          }}
          onRemove={() => setRules(rules.filter((_, j) => j !== i))}
        />
      ))}
      <div className="al-torrent-control__actions">
        <Button variant="secondary" onClick={() => setRules([...rules, newRuleDraft()])}>
          {t('settings.torrentControl.addRule')}
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || invalid} loading={save.isPending}>
          {t('settings.torrentControl.saveRules')}
        </Button>
        <Button
          variant="ghost"
          disabled={dirty}
          loading={apply.isPending}
          onClick={() =>
            apply.mutate(undefined, {
              onSuccess: (r) =>
                toast.push({
                  tone: 'ok',
                  title: t('settings.torrentControl.rulesApplied'),
                  message: r
                    ? t('settings.torrentControl.rulesAppliedSummary', { paused: r.paused.length, removed: r.removed.length, held: r.held.length })
                    : t('settings.torrentControl.engineNotRunning'),
                }),
            })
          }
        >
          {t('settings.torrentControl.applyNow')}
        </Button>
      </div>
    </form>
  );
}

/** The seeding rules list (first enabled match wins). */
export function SeedingRulesPane() {
  const rules = useSeedingRules();
  return (
    <Pane title={t('settings.torrentControl.seedingRules')} aria-label={t('settings.torrentControl.seedingRules')}>
      <p className="al-caption al-torrent-control__intro">{t('settings.torrentControl.seedingRulesIntro')}</p>
      {rules.isPending ? (
        <Skeleton lines={4} />
      ) : rules.isError ? (
        <ErrorBlock title={t('settings.torrentControl.couldntLoadSeedingRules')} onRetry={() => void rules.refetch()}>
          {errorMessage(rules.error)}
        </ErrorBlock>
      ) : (
        <RulesForm saved={rules.data.rules} />
      )}
    </Pane>
  );
}
