import { useState } from 'react';
import type { UpdateSettings } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { ErrorBlock, Skeleton } from '../../../arclight/index.js';
import { useContainerUpdates, useSaveUpdateSettings, useUpdateSettings } from '../../../hooks/updates.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';
import { ContainerUpdatesPane, UpdateSettingsFields } from './updates-panels.js';
import { t } from '../../../i18n/index.js';

function UpdatesForm({ data }: { data: UpdateSettings }) {
  const draft = useDraft(data);
  const save = useSaveUpdateSettings();
  const containers = useContainerUpdates();
  const [advanced, setAdvanced] = useState(false);
  return (
    <SettingsPage
      title={t('common.updates')}
      description={t('settings.updates.settings.checkForNewArclightReleases')}
      advanced={{ value: advanced, onChange: setAdvanced }}
      save={{ count: draft.changes, onSave: () => save.mutate(draft.value), onDiscard: draft.discard, saving: save.isPending }}
      after={<ContainerUpdatesPane />}
    >
      <SettingsSection label={t('settings.updates.settings.releasesAndContainers')}>
        <UpdateSettingsFields draft={draft} advanced={advanced} dockerAvailable={containers.data?.dockerAvailable} />
      </SettingsSection>
    </SettingsPage>
  );
}

/** Settings → Updates (/settings/updates): mode, window, channel, and the container list. */
export function UpdatesSettingsPage() {
  const settings = useUpdateSettings();
  if (settings.isSuccess) return <UpdatesForm data={settings.data} />;
  return (
    <SettingsPage title={t('common.updates')}>
      {settings.isError ? (
        <ErrorBlock title={t('settings.updates.settings.couldntLoadUpdateSettings')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <Skeleton lines={5} />
      )}
    </SettingsPage>
  );
}
