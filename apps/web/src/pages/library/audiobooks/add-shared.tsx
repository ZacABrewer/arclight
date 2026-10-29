import { useEffect, useState } from 'react';
import type { QualityProfile, RootFolder } from '@arclight/shared';
import { Button, FormRow, Select } from '../../../arclight/index.js';
import { FolderPickerModal } from '../../../components/media/folder-picker-modal.js';
import { useRootFolders } from '../../../hooks/library.js';
import { useAudiobookQualityProfiles } from '../../../hooks/audiobooks.js';
import { useAddRootFolder } from '../../../hooks/settings.js';
import { loadDefaults, saveDefaults } from '../add-dialog.js';
import { t } from '../../../i18n/index.js';

// Root folder and quality profile pickers shared by the add-author and add-book dialogs:
// audiobook root folders only (Browse adds a new one as `audiobook`), audiobook-domain profiles.

export interface AddTarget {
  rootFolderPath: string;
  qualityProfileId: number | null;
}

export function useAudiobookAddTarget(enabled: boolean) {
  const rootFolders = useRootFolders();
  const profiles = useAudiobookQualityProfiles(enabled);
  const roots = (rootFolders.data ?? []).filter((r) => r.mediaType === 'audiobook');
  return { roots, profiles: profiles.data ?? [] };
}

function initialTarget(roots: readonly RootFolder[], profiles: readonly QualityProfile[]): AddTarget {
  const d = loadDefaults('audiobook');
  const root = roots.find((r) => r.path === d.rootFolderPath) ?? roots[0];
  const profile = profiles.find((p) => p.id === d.qualityProfileId) ?? profiles[0];
  return { rootFolderPath: root?.path ?? '', qualityProfileId: profile?.id ?? null };
}

/** Form state for the target, filled in as root folders and profiles arrive. */
export function useTargetState(roots: readonly RootFolder[], profiles: readonly QualityProfile[]) {
  const [target, setTarget] = useState<AddTarget>(() => initialTarget(roots, profiles));
  useEffect(() => {
    setTarget((f) => {
      const init = initialTarget(roots, profiles);
      const next = { rootFolderPath: f.rootFolderPath || init.rootFolderPath, qualityProfileId: f.qualityProfileId ?? init.qualityProfileId };
      return next.rootFolderPath === f.rootFolderPath && next.qualityProfileId === f.qualityProfileId ? f : next;
    });
  }, [roots, profiles]);
  const errors = {
    rootFolderPath: target.rootFolderPath ? undefined : t('audiobooks.add.chooseAnAudiobookRootFolder'),
    qualityProfileId: target.qualityProfileId === null ? t('library.addForm.chooseAQualityProfile') : undefined,
  };
  const remember = () => {
    if (target.qualityProfileId !== null) saveDefaults('audiobook', { rootFolderPath: target.rootFolderPath, qualityProfileId: target.qualityProfileId });
  };
  return { target, setTarget, errors, valid: !errors.rootFolderPath && !errors.qualityProfileId, remember };
}

export function TargetFields({
  idPrefix,
  target,
  onChange,
  roots,
  profiles,
  errors,
  touched,
}: {
  idPrefix: string;
  target: AddTarget;
  onChange: (t: AddTarget) => void;
  roots: RootFolder[];
  profiles: QualityProfile[];
  errors: { rootFolderPath?: string | undefined; qualityProfileId?: string | undefined };
  touched: boolean;
}) {
  const [browsing, setBrowsing] = useState(false);
  const addRoot = useAddRootFolder();
  return (
    <>
      <FormRow
        label={t('common.rootFolder')}
        htmlFor={`${idPrefix}-root`}
        error={touched ? errors.rootFolderPath : undefined}
        caption={roots.length === 0 ? t('audiobooks.add.noAudiobookRootFolderYet') : undefined}
      >
        <div className="mk-row" style={{ flexWrap: 'nowrap' }}>
          <Select id={`${idPrefix}-root`} value={target.rootFolderPath} onChange={(e) => onChange({ ...target, rootFolderPath: e.target.value })} style={{ flex: 1, minWidth: 0 }}>
            <option value="">{t('library.addDialog.selectARootFolder')}</option>
            {roots.map((r) => (
              <option key={r.id} value={r.path}>
                {r.path}
                {r.accessible ? '' : t('library.addDialog.inaccessible')}
              </option>
            ))}
          </Select>
          <Button loading={addRoot.isPending} onClick={() => setBrowsing(true)}>
            {t('library.addDialog.browse')}
          </Button>
        </div>
      </FormRow>
      <FormRow label={t('common.qualityProfile')} htmlFor={`${idPrefix}-profile`} error={touched ? errors.qualityProfileId : undefined} caption={t('audiobooks.add.audiobookProfilesOnly')}>
        <Select
          id={`${idPrefix}-profile`}
          value={target.qualityProfileId?.toString() ?? ''}
          onChange={(e) => onChange({ ...target, qualityProfileId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">{t('library.addDialog.selectAProfile')}</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormRow>
      <FolderPickerModal
        open={browsing}
        onClose={() => setBrowsing(false)}
        title={t('common.chooseARootFolder')}
        initialPath={target.rootFolderPath}
        onSelect={(path) => {
          setBrowsing(false);
          if (roots.some((r) => r.path === path)) {
            onChange({ ...target, rootFolderPath: path });
            return;
          }
          addRoot.mutate({ path, mediaType: 'audiobook' }, { onSuccess: (root) => onChange({ ...target, rootFolderPath: root.path }) });
        }}
      />
    </>
  );
}
