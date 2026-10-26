import { useId } from 'react';
import type { CleanLibraryLevel, ImportListSettings } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { ErrorBlock, FormRow, FormSection, Input, Select, Skeleton } from '../../../arclight/index.js';
import { TagPicker } from '../../../components/forms/tag-picker.js';
import { useImportListSettings, useSaveImportListSettings } from '../../../hooks/import-lists.js';
import { useDraft, type Draft, type SaveBarProps } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

export const CLEAN_LEVEL_LABELS: Record<CleanLibraryLevel, string> = {
  get disabled() {
    return t('common.disabled');
  },
  get logOnly() {
    return t('settings.importLists.optionsCard.logOnly');
  },
  get unmonitor() {
    return t('common.unmonitor');
  },
  get remove() {
    return t('settings.importLists.optionsCard.removeFromLibrary');
  },
  get removeAndDeleteFiles() {
    return t('settings.importLists.optionsCard.removeAndDeleteFiles');
  },
};

export interface ImportListOptionsForm {
  query: ReturnType<typeof useImportListSettings>;
  saved: ImportListSettings | undefined;
  draft: Draft<ImportListSettings | null>;
  intervalValid: boolean;
  /** Props for the page's unsaved-changes bar. */
  save: SaveBarProps;
}

/** Draft state for the import-list options (GET/PUT /settings/importlists). */
export function useImportListOptions(): ImportListOptionsForm {
  const query = useImportListSettings();
  const mutation = useSaveImportListSettings();
  const draft = useDraft<ImportListSettings | null>(query.data ?? null);
  const interval = draft.value?.syncIntervalHours ?? 6;
  const intervalValid = Number.isInteger(interval) && interval >= 1 && interval <= 168;
  return {
    query,
    saved: query.data,
    draft,
    intervalValid,
    save: {
      count: draft.changes,
      saving: mutation.isPending,
      disabled: !intervalValid,
      onDiscard: draft.discard,
      onSave: () => {
        if (draft.value && intervalValid) mutation.mutate(draft.value);
      },
    },
  };
}

/** Import-list options: sync interval and "clean library", as Page 06 form rows. */
export function OptionsCard({ form }: { form: ImportListOptionsForm }) {
  const { query, draft, intervalValid } = form;
  const ids = useId();
  const value = draft.value;

  if (query.isError) {
    return (
      <SettingsSection label={t('settings.importLists.optionsCard.options')}>
        <ErrorBlock title={t('settings.importLists.optionsCard.couldNotLoadImportList')} onRetry={() => void query.refetch()}>
          {errorMessage(query.error)}
        </ErrorBlock>
      </SettingsSection>
    );
  }
  if (!value) {
    return (
      <SettingsSection label={t('settings.importLists.optionsCard.options')}>
        <Skeleton lines={3} />
      </SettingsSection>
    );
  }
  const set = (patch: Partial<ImportListSettings>) => draft.set((d) => (d ? { ...d, ...patch } : d));
  const interval = value.syncIntervalHours;

  return (
    <form aria-label={t('settings.importLists.optionsCard.importListOptions')} onSubmit={(e) => e.preventDefault()}>
      <FormSection label={t('settings.importLists.optionsCard.options')}>
        <FormRow
          label={t('settings.importLists.optionsCard.syncIntervalHours')}
          htmlFor={`${ids}-interval`}
          caption={t('settings.importLists.optionsCard.howOftenEachListIs')}
          error={intervalValid ? undefined : t('settings.importLists.optionsCard.enter1To168Hours')}
        >
          <Input
            id={`${ids}-interval`}
            type="number"
            mono
            min={1}
            max={168}
            invalid={!intervalValid}
            className="al-input--num"
            value={Number.isFinite(interval) ? String(interval) : ''}
            onChange={(e) => set({ syncIntervalHours: Number(e.currentTarget.value) })}
          />
        </FormRow>
        <FormRow label={t('settings.importLists.optionsCard.cleanLibraryLevel')} htmlFor={`${ids}-clean`} caption={t('settings.importLists.optionsCard.whatToDoWithLibrary')}>
          <Select
            id={`${ids}-clean`}
            className="al-select--fit"
            value={value.cleanLibraryLevel}
            onChange={(e) => set({ cleanLibraryLevel: e.currentTarget.value as CleanLibraryLevel })}
            options={Object.entries(CLEAN_LEVEL_LABELS).map(([v, label]) => ({ value: v, label }))}
          />
        </FormRow>
        {value.cleanLibraryLevel !== 'disabled' ? (
          <FormRow label={t('settings.importLists.optionsCard.cleanOnlyTagged')} caption={t('settings.importLists.optionsCard.onlyItemsWithOneOf')}>
            <TagPicker value={value.cleanLibraryTags} onChange={(tags) => set({ cleanLibraryTags: tags })} />
          </FormRow>
        ) : null}
      </FormSection>
    </form>
  );
}
