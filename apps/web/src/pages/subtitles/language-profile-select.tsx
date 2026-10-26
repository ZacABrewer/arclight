import { Field, Select } from '../../arclight/index.js';
import { useLanguageProfiles } from '../../hooks/subtitles.js';
import { t } from '../../i18n/index.js';

/** Add dialogs may leave the profile to the server default (the field is omitted). */
export type LanguageProfileChoice = number | null | 'default';

/**
 * Language profile picker for the add / edit dialogs: "None", each profile, and (add dialogs
 * only, `allowDefault`) "Default", which leaves the choice to the server's default profile.
 */
export function LanguageProfileSelect<T extends LanguageProfileChoice>({
  value,
  onChange,
  allowDefault = false,
}: {
  value: T;
  onChange: (value: T) => void;
  allowDefault?: boolean;
}) {
  const profiles = useLanguageProfiles();
  const encoded = value === 'default' ? 'default' : value === null ? 'none' : String(value);
  const list = profiles.data ?? [];
  const known = value === null || value === 'default' || list.some((p) => p.id === value);
  return (
    <Field label={t('subtitles.languageProfileSelect.languageProfile')} hint={t('subtitles.languageProfileSelect.whichSubtitlesToLookFor')}>
      <Select
        value={encoded}
        onChange={(e) => {
          const v = e.currentTarget.value;
          onChange((v === 'default' ? 'default' : v === 'none' ? null : Number(v)) as T);
        }}
      >
        {allowDefault ? <option value="default">{t('subtitles.languageProfileSelect.default')}</option> : null}
        <option value="none">{t('common.none')}</option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {!known ? <option value={encoded}>{t('subtitles.languageProfileSelect.profileEncoded', { encoded })}</option> : null}
      </Select>
    </Field>
  );
}
