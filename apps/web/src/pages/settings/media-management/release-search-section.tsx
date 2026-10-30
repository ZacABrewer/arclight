import { useEffect, useState } from 'react';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, Input, Skeleton, Toggle } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useMusicReleasesSettings, useSaveMusicReleasesSettings } from '../../../hooks/music-acquisition.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

/**
 * Searching unreleased items (`releases.searchUnreleased`, `releaseGraceHours`; packages/shared
 * release-dates.ts). Every media type. Like the music and audiobook sections it saves on its
 * own and sends the stored releases section back with its two knobs changed.
 */
export function ReleaseSearchSection() {
  const settings = useMusicReleasesSettings();
  const save = useSaveMusicReleasesSettings();
  const toast = useToast();
  const [allow, setAllow] = useState(false);
  const [grace, setGrace] = useState('0');
  useEffect(() => {
    if (!settings.data) return;
    setAllow(settings.data.searchUnreleased);
    setGrace(String(settings.data.releaseGraceHours));
  }, [settings.data]);
  const n = Number(grace);
  const valid = Number.isInteger(n) && n >= 0 && n <= 168;
  const dirty = settings.data !== undefined && valid && (allow !== settings.data.searchUnreleased || n !== settings.data.releaseGraceHours);

  return (
    <SettingsSection
      label={t('settings.releaseSearch.title')}
      action={
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() =>
            settings.data &&
            save.mutate({ ...settings.data, searchUnreleased: allow, releaseGraceHours: n }, { onSuccess: () => toast.push({ tone: 'ok', title: t('settings.releaseSearch.saved') }) })
          }
        >
          {t('common.save')}
        </Button>
      }
    >
      {settings.isPending ? (
        <Skeleton lines={2} />
      ) : settings.isError ? (
        <ErrorBlock title={t('settings.releaseSearch.couldNotLoad')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <>
          <FormRow label={t('settings.releaseSearch.searchUnreleased')} caption={t('settings.releaseSearch.searchUnreleasedCaption')} captionInline>
            <Toggle aria-label={t('settings.releaseSearch.searchUnreleased')} checked={allow} onChange={(e) => setAllow(e.currentTarget.checked)} />
          </FormRow>
          <FormRow
            label={t('settings.releaseSearch.graceHours')}
            htmlFor="release-grace-hours"
            caption={t('settings.releaseSearch.graceHoursCaption')}
            error={valid ? undefined : t('settings.releaseSearch.graceHoursInvalid')}
          >
            <Input
              id="release-grace-hours"
              type="number"
              mono
              min={0}
              max={168}
              value={grace}
              onChange={(e) => setGrace(e.currentTarget.value)}
              end={t('settings.releaseSearch.hours')}
            />
          </FormRow>
        </>
      )}
    </SettingsSection>
  );
}
