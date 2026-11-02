import { useEffect, useState } from 'react';
import type { SeasonPackUpgradeMode } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, Input, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useMusicReleasesSettings, useSaveMusicReleasesSettings } from '../../../hooks/music-acquisition.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

/**
 * Season packs (`releases.allowMultiSeasonPacks`, `seasonPackPreferPercent`,
 * `seasonPackUpgradeMode`/`Threshold`). Saves on its own like the release search section: the
 * stored releases section goes back with these knobs changed.
 */

interface Draft {
  allowMulti: boolean;
  prefer: string;
  mode: SeasonPackUpgradeMode;
  threshold: string;
}

const percentOk = (v: string) => {
  const n = Number(v);
  return v.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 100;
};

export function SeasonPacksSection() {
  const settings = useMusicReleasesSettings();
  const save = useSaveMusicReleasesSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({ allowMulti: true, prefer: '50', mode: 'all', threshold: '100' });
  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setDraft({
      allowMulti: s.allowMultiSeasonPacks,
      prefer: String(s.seasonPackPreferPercent),
      mode: s.seasonPackUpgradeMode,
      threshold: String(s.seasonPackUpgradeThreshold),
    });
  }, [settings.data]);

  const s = settings.data;
  const valid = percentOk(draft.prefer) && percentOk(draft.threshold);
  const dirty =
    s !== undefined &&
    valid &&
    (draft.allowMulti !== s.allowMultiSeasonPacks ||
      Number(draft.prefer) !== s.seasonPackPreferPercent ||
      draft.mode !== s.seasonPackUpgradeMode ||
      Number(draft.threshold) !== s.seasonPackUpgradeThreshold);
  const modes: Array<{ value: SeasonPackUpgradeMode; label: string }> = [
    { value: 'all', label: t('settings.seasonPacks.modeAll') },
    { value: 'any', label: t('settings.seasonPacks.modeAny') },
    { value: 'percent', label: t('settings.seasonPacks.modePercent') },
  ];

  return (
    <SettingsSection
      label={t('settings.seasonPacks.title')}
      action={
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() =>
            s &&
            save.mutate(
              {
                ...s,
                allowMultiSeasonPacks: draft.allowMulti,
                seasonPackPreferPercent: Number(draft.prefer),
                seasonPackUpgradeMode: draft.mode,
                seasonPackUpgradeThreshold: Number(draft.threshold),
              },
              { onSuccess: () => toast.push({ tone: 'ok', title: t('settings.seasonPacks.saved') }) },
            )
          }
        >
          {t('common.save')}
        </Button>
      }
    >
      {settings.isPending ? (
        <Skeleton lines={4} />
      ) : settings.isError ? (
        <ErrorBlock title={t('settings.seasonPacks.couldNotLoad')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <>
          <FormRow label={t('settings.seasonPacks.allowMulti')} caption={t('settings.seasonPacks.allowMultiCaption')} captionInline>
            <Toggle
              aria-label={t('settings.seasonPacks.allowMulti')}
              checked={draft.allowMulti}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setDraft((d) => ({ ...d, allowMulti: checked }));
              }}
            />
          </FormRow>
          <FormRow
            label={t('settings.seasonPacks.prefer')}
            htmlFor="season-pack-prefer"
            caption={t('settings.seasonPacks.preferCaption')}
            error={percentOk(draft.prefer) ? undefined : t('settings.seasonPacks.percentInvalid')}
          >
            <Input
              id="season-pack-prefer"
              type="number"
              mono
              min={0}
              max={100}
              value={draft.prefer}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setDraft((d) => ({ ...d, prefer: value }));
              }}
              end="%"
            />
          </FormRow>
          <FormRow label={t('settings.seasonPacks.upgradeMode')} htmlFor="season-pack-mode" caption={t('settings.seasonPacks.upgradeModeCaption')}>
            <Select
              id="season-pack-mode"
              value={draft.mode}
              onChange={(e) => {
                const mode = e.currentTarget.value as SeasonPackUpgradeMode;
                setDraft((d) => ({ ...d, mode }));
              }}
              options={modes}
            />
          </FormRow>
          {draft.mode === 'percent' ? (
            <FormRow
              label={t('settings.seasonPacks.threshold')}
              htmlFor="season-pack-threshold"
              caption={t('settings.seasonPacks.thresholdCaption')}
              error={percentOk(draft.threshold) ? undefined : t('settings.seasonPacks.percentInvalid')}
            >
              <Input
                id="season-pack-threshold"
                type="number"
                mono
                min={0}
                max={100}
                value={draft.threshold}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setDraft((d) => ({ ...d, threshold: value }));
                }}
                end="%"
              />
            </FormRow>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
