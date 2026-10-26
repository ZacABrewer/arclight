import { useId, useState } from 'react';
import type { IndexerGlobalSettings } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { ErrorBlock, FormRow, FormSection, Input, Skeleton, Toggle } from '../../../arclight/index.js';
import { useIndexerOptions, useSaveIndexerOptions } from '../../../hooks/indexers.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { DefinitionFeedPanel } from './definition-feed-panel.js';
import { t } from '../../../i18n/index.js';

/** Errors keyed by field for the indexer options form; empty when valid. */
export function validateIndexerOptions(v: IndexerGlobalSettings): Partial<Record<keyof IndexerGlobalSettings, string>> {
  const errors: Partial<Record<keyof IndexerGlobalSettings, string>> = {};
  const nonNeg = (k: 'minimumAgeMinutes' | 'retentionDays' | 'maximumSizeMb') => {
    if (!Number.isInteger(v[k]) || v[k] < 0) errors[k] = t('settings.indexerOptions.enterAWholeNumber0');
  };
  nonNeg('minimumAgeMinutes');
  nonNeg('retentionDays');
  nonNeg('maximumSizeMb');
  const r = v.rssSyncIntervalMinutes;
  if (!Number.isInteger(r) || (r !== 0 && (r < 10 || r > 1440))) errors.rssSyncIntervalMinutes = t('settings.indexerOptions.use0OffOr10');
  return errors;
}

/** "ENG, HC.ENG" -> ['ENG', 'HC.ENG']. */
export function parseTagList(text: string): string[] {
  return [...new Set(text.split(',').map((item) => item.trim()).filter(Boolean))];
}

/** Form model: the settings with the whitelist as the text the user types. */
type OptionsDraft = Omit<IndexerGlobalSettings, 'whitelistedHardcodedSubs'> & { subsText: string };

const EMPTY: OptionsDraft = {
  minimumAgeMinutes: 0,
  retentionDays: 0,
  maximumSizeMb: 0,
  rssSyncIntervalMinutes: 15,
  allowHardcodedSubs: false,
  preferIndexerFlags: false,
  subsText: '',
};

function toDraft(s: IndexerGlobalSettings): OptionsDraft {
  const { whitelistedHardcodedSubs, ...rest } = s;
  return { ...rest, subsText: whitelistedHardcodedSubs.join(', ') };
}

function fromDraft(d: OptionsDraft): IndexerGlobalSettings {
  const { subsText, ...rest } = d;
  return { ...rest, whitelistedHardcodedSubs: parseTagList(subsText) };
}

type NumKey = 'minimumAgeMinutes' | 'retentionDays' | 'maximumSizeMb' | 'rssSyncIntervalMinutes';

function NumberRow({
  label,
  caption,
  unit,
  value,
  error,
  onChange,
}: {
  label: string;
  caption: string;
  unit: string;
  value: number;
  error?: string | undefined;
  onChange: (n: number) => void;
}) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={caption} error={error}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        mono
        className="al-input--num"
        end={unit}
        invalid={error ? true : undefined}
        value={Number.isFinite(value) ? String(value) : ''}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </FormRow>
  );
}

/** Settings → Indexer options (GET/PUT /settings/indexers). */
export function IndexerOptionsPage() {
  const query = useIndexerOptions();
  const save = useSaveIndexerOptions();
  // After a save the response is the saved value until the next refetch lands.
  const [savedOverride, setSavedOverride] = useState<{ at: number; value: OptionsDraft } | null>(null);
  const fromQuery = query.data ? toDraft(query.data) : EMPTY;
  const saved = savedOverride && savedOverride.at >= query.dataUpdatedAt ? savedOverride.value : fromQuery;
  const draft = useDraft(saved);
  const d = draft.value;
  const errors = validateIndexerOptions(fromDraft(d));
  const valid = Object.keys(errors).length === 0;
  const setNum = (k: NumKey) => (n: number) => draft.set((prev) => ({ ...prev, [k]: n }));
  const subsId = useId();

  const onSave = () => {
    if (!valid) return;
    save.mutate(fromDraft(d), { onSuccess: (res) => setSavedOverride({ at: Date.now(), value: toDraft(res) }) });
  };

  return (
    <SettingsPage
      title={t('settings.indexerOptions.indexerOptions')}
      description={t('settings.indexerOptions.limitsThatApplyToEvery')}
      save={{ count: query.data ? draft.changes : 0, onSave, onDiscard: draft.discard, saving: save.isPending, disabled: !valid }}
      after={<DefinitionFeedPanel />}
    >
      {query.isError ? (
        <ErrorBlock title={t('settings.indexerOptions.couldntLoadIndexerOptions')} onRetry={() => void query.refetch()}>
          {errorMessage(query.error)}
        </ErrorBlock>
      ) : !query.data ? (
        <Skeleton lines={6} />
      ) : (
        <form
          aria-label={t('settings.indexerOptions.indexerOptions')}
          style={{ display: 'flex', flexDirection: 'column', gap: 30 }}
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <FormSection label={t('settings.indexerOptions.rss')}>
            <NumberRow
              label={t('settings.indexerOptions.rssSyncInterval')}
              unit="min"
              caption={t('settings.indexerOptions.howOftenIndexersArePolled')}
              value={d.rssSyncIntervalMinutes}
              error={errors.rssSyncIntervalMinutes}
              onChange={setNum('rssSyncIntervalMinutes')}
            />
          </FormSection>
          <FormSection label={t('common.usenet')}>
            <NumberRow
              label={t('settings.indexerOptions.minimumAge')}
              unit="min"
              caption={t('settings.indexerOptions.releasesYoungerThanThisAre')}
              value={d.minimumAgeMinutes}
              error={errors.minimumAgeMinutes}
              onChange={setNum('minimumAgeMinutes')}
            />
            <NumberRow
              label={t('common.retention')}
              unit="days"
              caption={t('settings.indexerOptions.releasesOlderThanThisAre')}
              value={d.retentionDays}
              error={errors.retentionDays}
              onChange={setNum('retentionDays')}
            />
          </FormSection>
          <FormSection label={t('settings.indexerOptions.releases')}>
            <NumberRow
              label={t('settings.indexerOptions.maximumSize')}
              unit="MB"
              caption={t('settings.indexerOptions.releasesLargerThanThisAre')}
              value={d.maximumSizeMb}
              error={errors.maximumSizeMb}
              onChange={setNum('maximumSizeMb')}
            />
            <FormRow label={t('settings.indexerOptions.allowHardcodedSubs')} caption={t('settings.indexerOptions.acceptReleasesWithBurnedIn')} captionInline>
              <Toggle
                aria-label={t('settings.indexerOptions.allowHardcodedSubs')}
                checked={d.allowHardcodedSubs}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  draft.set((prev) => ({ ...prev, allowHardcodedSubs: on }));
                }}
              />
            </FormRow>
            {!d.allowHardcodedSubs ? (
              <FormRow
                label={t('settings.indexerOptions.whitelistedSubtitleTags')}
                htmlFor={subsId}
                caption={t('settings.indexerOptions.commaSeparatedTagsAllowedEven')}
              >
                <Input
                  id={subsId}
                  mono
                  value={d.subsText}
                  onChange={(e) => {
                    const text = e.currentTarget.value;
                    draft.set((prev) => ({ ...prev, subsText: text }));
                  }}
                />
              </FormRow>
            ) : null}
            <FormRow label={t('settings.indexerOptions.preferIndexerFlags')} caption={t('settings.indexerOptions.preferReleasesTheIndexerFlags')} captionInline>
              <Toggle
                aria-label={t('settings.indexerOptions.preferIndexerFlags')}
                checked={d.preferIndexerFlags}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  draft.set((prev) => ({ ...prev, preferIndexerFlags: on }));
                }}
              />
            </FormRow>
          </FormSection>
        </form>
      )}
    </SettingsPage>
  );
}
