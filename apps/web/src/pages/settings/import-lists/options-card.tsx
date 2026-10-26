import { useEffect, useState } from 'react';
import type { CleanLibraryLevel, ImportListSettings } from '@arclight/shared';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Select } from '../../../components/form.js';
import { TagPicker } from '../../../components/forms/tag-picker.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useImportListSettings, useSaveImportListSettings } from '../../../hooks/import-lists.js';

export const CLEAN_LEVEL_LABELS: Record<CleanLibraryLevel, string> = {
  disabled: 'Disabled',
  logOnly: 'Log only',
  unmonitor: 'Unmonitor',
  remove: 'Remove from library',
  removeAndDeleteFiles: 'Remove and delete files',
};

/** Import-list options: sync interval and "clean library" (GET/PUT /settings/importlists). */
export function OptionsCard() {
  const query = useImportListSettings();
  const save = useSaveImportListSettings();
  const [draft, setDraft] = useState<ImportListSettings | null>(null);

  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);

  const interval = draft?.syncIntervalHours ?? 6;
  const intervalValid = Number.isInteger(interval) && interval >= 1 && interval <= 168;

  return (
    <Card title="Options">
      {query.isError ? (
        <ErrorView error={query.error} onRetry={() => void query.refetch()} />
      ) : !draft ? (
        <LoadingBlock />
      ) : (
        <form
          aria-label="Import list options"
          onSubmit={(e) => {
            e.preventDefault();
            if (intervalValid) save.mutate(draft);
          }}
        >
          <FormField inline label="Sync interval (hours)" hint="How often each list is fetched (1-168)." error={intervalValid ? undefined : 'Enter 1 to 168 hours'}>
            <Input
              type="number"
              min={1}
              max={168}
              value={Number.isFinite(interval) ? String(interval) : ''}
              onChange={(e) => setDraft({ ...draft, syncIntervalHours: Number(e.currentTarget.value) })}
            />
          </FormField>
          <FormField inline label="Clean library level" hint="What to do with library items that are no longer on any enabled list.">
            <Select
              value={draft.cleanLibraryLevel}
              onChange={(e) => setDraft({ ...draft, cleanLibraryLevel: e.currentTarget.value as CleanLibraryLevel })}
              options={Object.entries(CLEAN_LEVEL_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </FormField>
          {draft.cleanLibraryLevel !== 'disabled' ? (
            <FormField inline label="Clean only tagged" hint="Only items with one of these tags are cleaned; empty means every item.">
              <TagPicker value={draft.cleanLibraryTags} onChange={(tags) => setDraft({ ...draft, cleanLibraryTags: tags })} />
            </FormField>
          ) : null}
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!intervalValid}>
              Save options
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
