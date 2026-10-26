import { useEffect, useState } from 'react';
import type { IndexerGlobalSettings } from '@media-tron/shared';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Toggle } from '../../../components/form.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useIndexerOptions, useSaveIndexerOptions } from '../../../hooks/indexers.js';

/** Errors keyed by field for the indexer options form; empty when valid. */
export function validateIndexerOptions(v: IndexerGlobalSettings): Partial<Record<keyof IndexerGlobalSettings, string>> {
  const errors: Partial<Record<keyof IndexerGlobalSettings, string>> = {};
  const nonNeg = (k: 'minimumAgeMinutes' | 'retentionDays' | 'maximumSizeMb') => {
    if (!Number.isInteger(v[k]) || v[k] < 0) errors[k] = 'Enter a whole number, 0 or more';
  };
  nonNeg('minimumAgeMinutes');
  nonNeg('retentionDays');
  nonNeg('maximumSizeMb');
  const r = v.rssSyncIntervalMinutes;
  if (!Number.isInteger(r) || (r !== 0 && (r < 10 || r > 1440))) errors.rssSyncIntervalMinutes = 'Use 0 (off) or 10 to 1440 minutes';
  return errors;
}

/** "ENG, HC.ENG" -> ['ENG', 'HC.ENG']. */
export function parseTagList(text: string): string[] {
  return [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))];
}

function NumberField({
  label,
  hint,
  unit,
  value,
  error,
  onChange,
}: {
  label: string;
  hint: string;
  unit: string;
  value: number;
  error?: string | undefined;
  onChange: (n: number) => void;
}) {
  return (
    <FormField inline label={label} hint={hint} error={error}>
      <span className="input-with-unit">
        <Input type="number" min={0} aria-label={label} value={Number.isFinite(value) ? String(value) : ''} onChange={(e) => onChange(Number(e.currentTarget.value))} />
        <span className="input-unit">{unit}</span>
      </span>
    </FormField>
  );
}

/** Settings → Indexer options (GET/PUT /settings/indexers). */
export function IndexerOptionsPage() {
  const query = useIndexerOptions();
  const save = useSaveIndexerOptions();
  const [draft, setDraft] = useState<IndexerGlobalSettings | null>(null);
  const [subsText, setSubsText] = useState('');

  useEffect(() => {
    if (query.data) {
      setDraft(query.data);
      setSubsText(query.data.whitelistedHardcodedSubs.join(', '));
    }
  }, [query.data]);

  const errors = draft ? validateIndexerOptions(draft) : {};
  const valid = Object.keys(errors).length === 0;

  return (
    <Page title="Indexer Options">
      <Card>
        {query.isError ? (
          <ErrorView error={query.error} onRetry={() => void query.refetch()} />
        ) : !draft ? (
          <LoadingBlock />
        ) : (
          <form
            aria-label="Indexer options"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) save.mutate({ ...draft, whitelistedHardcodedSubs: parseTagList(subsText) });
            }}
          >
            <NumberField
              label="Minimum age"
              unit="min"
              hint="Usenet only: releases younger than this are not grabbed. 0 = off."
              value={draft.minimumAgeMinutes}
              error={errors.minimumAgeMinutes}
              onChange={(n) => setDraft({ ...draft, minimumAgeMinutes: n })}
            />
            <NumberField
              label="Retention"
              unit="days"
              hint="Usenet only: releases older than this are ignored. 0 = unlimited."
              value={draft.retentionDays}
              error={errors.retentionDays}
              onChange={(n) => setDraft({ ...draft, retentionDays: n })}
            />
            <NumberField
              label="Maximum size"
              unit="MB"
              hint="Releases larger than this are rejected. 0 = unlimited."
              value={draft.maximumSizeMb}
              error={errors.maximumSizeMb}
              onChange={(n) => setDraft({ ...draft, maximumSizeMb: n })}
            />
            <NumberField
              label="RSS sync interval"
              unit="min"
              hint="How often indexers are polled for new releases. 0 disables RSS sync; otherwise 10 to 1440."
              value={draft.rssSyncIntervalMinutes}
              error={errors.rssSyncIntervalMinutes}
              onChange={(n) => setDraft({ ...draft, rssSyncIntervalMinutes: n })}
            />
            <FormField inline label="Allow hardcoded subs" hint="Accept releases with burned-in subtitles.">
              <Toggle
                aria-label="Allow hardcoded subs"
                checked={draft.allowHardcodedSubs}
                onChange={(e) => setDraft({ ...draft, allowHardcodedSubs: e.currentTarget.checked })}
              />
            </FormField>
            {!draft.allowHardcodedSubs ? (
              <FormField inline label="Whitelisted subtitle tags" hint="Comma-separated tags allowed even though hardcoded subs are not (e.g. ENG, HC.ENG).">
                <Input aria-label="Whitelisted subtitle tags" value={subsText} onChange={(e) => setSubsText(e.currentTarget.value)} />
              </FormField>
            ) : null}
            <FormField inline label="Prefer indexer flags" hint="Prefer releases the indexer flags (freeleech, internal, ...).">
              <Toggle
                aria-label="Prefer indexer flags"
                checked={draft.preferIndexerFlags}
                onChange={(e) => setDraft({ ...draft, preferIndexerFlags: e.currentTarget.checked })}
              />
            </FormField>
            <div className="form-actions">
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!valid}>
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>
    </Page>
  );
}
